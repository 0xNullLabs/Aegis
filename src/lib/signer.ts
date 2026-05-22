/**
 * Transaction signing and broadcasting via tcx-wasm + Sepolia RPC.
 * Completely self-contained — no external wallet plugin needed.
 *
 * This module is designed to be AI-callable: each function is a pure
 * async operation that accepts simple parameters and returns results.
 */

import { ethers } from "ethers";
import { buildPoseidon } from "circomlibjs";
import {
  ADDRESSES,
  CHAIN_ID,
  ERC20_ABI,
  ZWERC20_ABI,
  SEPOLIA_RPC,
  SEPOLIA_RPC_FALLBACKS,
} from "./contracts";
import {
  deriveFromSecret,
  rebuildMerkleTree,
  findUserCommitment,
  prepareCircuitInput,
} from "./zkProof";
import { initWasm, sign_tx } from "./wasm";

// ─── Types ────────────────────────────────────────────────────────────────────

export type StepId =
  | "init"
  | "approve"
  | "deposit"
  | "wait"
  | "tree"
  | "proof"
  | "remint"
  | "done";

export type StepStatus = "pending" | "running" | "done" | "error";

export interface FlowStep {
  id: StepId;
  label: string;
  status: StepStatus;
  txHash?: string;
  detail?: string;
}

export type StepCallback = (step: Partial<FlowStep> & { id: StepId }) => void;

// ─── Provider ─────────────────────────────────────────────────────────────────

function resolveRpc(rpc: string): string {
  if (rpc.startsWith("/") && typeof window !== "undefined") {
    return window.location.origin + rpc;
  }
  return rpc;
}

const STATIC_NETWORK = ethers.Network.from(CHAIN_ID);

export function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(resolveRpc(SEPOLIA_RPC), STATIC_NETWORK, {
    staticNetwork: STATIC_NETWORK,
  });
}

export async function getProviderWithFallback(): Promise<ethers.JsonRpcProvider> {
  const rpcs = [SEPOLIA_RPC, ...SEPOLIA_RPC_FALLBACKS];
  for (const rpc of rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(resolveRpc(rpc), STATIC_NETWORK, {
        staticNetwork: STATIC_NETWORK,
      });
      await provider.getBlockNumber();
      return provider;
    } catch {
      continue;
    }
  }
  throw new Error("All Sepolia RPC endpoints are unreachable. Check your network.");
}

// ─── Core signing ─────────────────────────────────────────────────────────────

async function signAndBroadcast(
  keystoreJson: string,
  prfKey: string,
  derivationPath: string,
  from: string,
  to: string,
  data: string,
  value: bigint,
  provider: ethers.JsonRpcProvider
): Promise<string> {
  await initWasm();

  const [nonce, feeData, gasEstimate] = await Promise.all([
    provider.getTransactionCount(from),
    provider.getFeeData(),
    provider.estimateGas({ from, to, data, value }).catch(() => 500000n),
  ]);

  const maxFeePerGas = ((feeData.maxFeePerGas ?? 2000000000n) * 150n) / 100n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1500000000n;
  const gasLimit = (gasEstimate * 130n) / 100n;

  const result: { signature: string; txHash: string } = JSON.parse(
    sign_tx(
      JSON.stringify({
        keystoreJson,
        key: prfKey,
        derivationPath,
        input: {
          nonce: nonce.toString(),
          gasLimit: gasLimit.toString(),
          to,
          value: value.toString(),
          data: data || "0x",
          chainId: CHAIN_ID.toString(),
          txType: "02",
          maxFeePerGas: maxFeePerGas.toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          accessList: [],
        },
      })
    )
  );

  const rawTx = result.signature.startsWith("0x") ? result.signature : "0x" + result.signature;
  const tx = await provider.broadcastTransaction(rawTx);
  return tx.hash;
}

// ─── Balance queries ──────────────────────────────────────────────────────────

export async function getBalances(
  address: string,
  provider: ethers.JsonRpcProvider
): Promise<{ eth: bigint; usdc: bigint; decimals: number }> {
  const usdcContract = new ethers.Contract(ADDRESSES.USDC, ERC20_ABI, provider);
  const [eth, usdc, decimals] = await Promise.all([
    provider.getBalance(address),
    usdcContract.balanceOf(address) as Promise<bigint>,
    usdcContract.decimals() as Promise<number>,
  ]);
  return { eth, usdc, decimals: Number(decimals) };
}

// ─── Privacy buy flow ─────────────────────────────────────────────────────────

export interface BuyFlowResult {
  orderId: string;
  remintTxHash: string;
  depositTxHash: string;
  accountB: string;
  amountUsdc: string;
}

/**
 * Full ZWToken privacy payment flow:
 *   Account A → approve USDC → deposit to privacy pool →
 *   generate ZK proof → remint (withdraw) to Account B
 *
 * Designed for AI invocation: onStep receives incremental updates.
 */
export async function runPrivacyBuyFlow(params: {
  keystoreJson: string;
  prfKey: string;
  addressA: string;
  addressB: string;
  amountUSDC: string; // human-readable, e.g. "10"
  onStep: StepCallback;
}): Promise<BuyFlowResult> {
  const { keystoreJson, prfKey, addressA, addressB, onStep } = params;
  const derivationPath = "m/44'/60'/0'/0/0";

  onStep({ id: "init", status: "running", label: "Connecting to Sepolia..." });
  const provider = await getProviderWithFallback();

  // Resolve USDC decimals and parse amount
  const usdcContract = new ethers.Contract(ADDRESSES.USDC, ERC20_ABI, provider);
  const decimals = Number(await usdcContract.decimals());
  const amount = ethers.parseUnits(params.amountUSDC, decimals);

  const zwContract = new ethers.Contract(ADDRESSES.ZWERC20, ZWERC20_ABI, provider);
  const iface = new ethers.Interface(ZWERC20_ABI);
  const usdcIface = new ethers.Interface(ERC20_ABI);

  onStep({ id: "init", status: "done", label: "Connected to Sepolia" });

  // ── Step 1: Approve USDC ──────────────────────────────────────────────────
  onStep({ id: "approve", status: "running", label: "Approving USDC..." });

  const approveData = usdcIface.encodeFunctionData("approve", [ADDRESSES.ZWERC20, amount]);
  const approveTxHash = await signAndBroadcast(
    keystoreJson, prfKey, derivationPath, addressA, ADDRESSES.USDC, approveData, 0n, provider
  );
  await provider.waitForTransaction(approveTxHash, 1);

  onStep({ id: "approve", status: "done", label: "USDC Approved", txHash: approveTxHash });

  // ── Step 2: Generate privacy secret & deposit ─────────────────────────────
  onStep({ id: "deposit", status: "running", label: "Depositing to privacy pool..." });

  // Random 32-byte secret
  const secretBytes = crypto.getRandomValues(new Uint8Array(31));
  const secretHex = "0x" + Array.from(secretBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const { privacyAddress, addr20, q, nullifier, secret } = await deriveFromSecret(secretHex);

  const depositData = iface.encodeFunctionData("deposit", [privacyAddress, 0, amount, "0x"]);
  const depositTxHash = await signAndBroadcast(
    keystoreJson, prfKey, derivationPath, addressA, ADDRESSES.ZWERC20, depositData, 0n, provider
  );

  onStep({ id: "deposit", status: "running", label: "Waiting for deposit confirmation...", txHash: depositTxHash });
  await provider.waitForTransaction(depositTxHash, 1);
  onStep({ id: "deposit", status: "done", label: "Deposited to privacy pool", txHash: depositTxHash });

  // ── Step 3: Rebuild Merkle tree ───────────────────────────────────────────
  onStep({ id: "tree", status: "running", label: "Syncing Merkle tree from chain..." });

  const poseidon = await buildPoseidon();
  const tree = await rebuildMerkleTree(zwContract, poseidon);
  const onchainRoot = await zwContract.root();
  const localRoot = "0x" + tree.root.toString(16).padStart(64, "0");

  if (localRoot.toLowerCase() !== onchainRoot.toLowerCase()) {
    throw new Error(`Merkle root mismatch: local=${localRoot} on-chain=${onchainRoot}`);
  }

  const userCommitment = await findUserCommitment(zwContract, privacyAddress, poseidon);
  if (!userCommitment) {
    throw new Error("Commitment not found in tree after deposit. Please retry.");
  }

  onStep({ id: "tree", status: "done", label: "Merkle tree synced", detail: `Root: ${localRoot.slice(0, 18)}...` });

  // ── Step 4: Generate ZK proof ─────────────────────────────────────────────
  onStep({ id: "proof", status: "running", label: "Generating ZK proof (30–60s)..." });

  const merkleProof = tree.getProof(userCommitment.index);
  const circuitInput = prepareCircuitInput({
    root: tree.root,
    nullifier,
    recipient: addressB,
    remintAmount: amount,
    secret,
    addr20,
    commitAmount: userCommitment.amount,
    q,
    merkleProof,
    redeem: true,
  });

  // snarkjs is loaded dynamically to avoid SSR issues
  const snarkjs = await import("snarkjs");
  const { proof: zkProof, publicSignals } = await (snarkjs as any).groth16.fullProve(
    circuitInput,
    "/circuits/remint.wasm",
    "/circuits/remint_final.zkey"
  );

  const calldata = await (snarkjs as any).groth16.exportSolidityCallData(zkProof, publicSignals);
  const calldataJson = JSON.parse("[" + calldata + "]");

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const proofBytes = abiCoder.encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [calldataJson[0], calldataJson[1], calldataJson[2]]
  );

  onStep({ id: "proof", status: "done", label: "ZK proof generated" });

  // ── Step 5: Remint (withdraw to Account B) ────────────────────────────────
  onStep({ id: "remint", status: "running", label: "Withdrawing via ZK proof to anonymous address..." });

  const nullifierHex = "0x" + nullifier.toString(16).padStart(64, "0");

  const remintData = iface.encodeFunctionData("remint", [
    addressB,
    0,
    amount,
    {
      commitment: localRoot,
      nullifiers: [nullifierHex],
      proverData: "0x",
      relayerData: "0x",
      redeem: true,
      proof: proofBytes,
    },
  ]);

  const remintTxHash = await signAndBroadcast(
    keystoreJson, prfKey, derivationPath, addressA, ADDRESSES.ZWERC20, remintData, 0n, provider
  );
  await provider.waitForTransaction(remintTxHash, 1);

  onStep({ id: "remint", status: "done", label: "USDC withdrawn to anonymous address", txHash: remintTxHash });
  onStep({ id: "done", status: "done", label: "Payment complete" });

  return {
    orderId: generateOrderId(),
    remintTxHash,
    depositTxHash,
    accountB: addressB,
    amountUsdc: params.amountUSDC,
  };
}

function generateOrderId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => chars[b % chars.length])
    .join("");
}

// ─── Individual step exports ──────────────────────────────────────────────────

export interface DepositOnlyResult {
  depositTxHash: string;
  secretHex: string;
  privacyAddress: string;
  addr20: bigint;
  q: bigint;
  nullifier: bigint;
  secret: bigint;
  amount: bigint;
  amountUSDC: string;
}

/** Approve USDC + deposit to privacy pool only. Save the result for runRemintOnly. */
export async function runDepositOnly(params: {
  keystoreJson: string;
  prfKey: string;
  addressA: string;
  amountUSDC: string;
  onStep: StepCallback;
}): Promise<DepositOnlyResult> {
  const { keystoreJson, prfKey, addressA, onStep } = params;
  const derivationPath = "m/44'/60'/0'/0/0";

  onStep({ id: "init", status: "running", label: "连接 Sepolia 网络..." });
  const provider = await getProviderWithFallback();

  const usdcContract = new ethers.Contract(ADDRESSES.USDC, ERC20_ABI, provider);
  const decimals = Number(await usdcContract.decimals());
  const amount = ethers.parseUnits(params.amountUSDC, decimals);

  const iface = new ethers.Interface(ZWERC20_ABI);
  const usdcIface = new ethers.Interface(ERC20_ABI);

  onStep({ id: "init", status: "done", label: "已连接 Sepolia" });

  onStep({ id: "approve", status: "running", label: "授权 USDC..." });
  const approveData = usdcIface.encodeFunctionData("approve", [ADDRESSES.ZWERC20, amount]);
  const approveTxHash = await signAndBroadcast(keystoreJson, prfKey, derivationPath, addressA, ADDRESSES.USDC, approveData, 0n, provider);
  await provider.waitForTransaction(approveTxHash, 1);
  onStep({ id: "approve", status: "done", label: "USDC 授权完成", txHash: approveTxHash });

  onStep({ id: "deposit", status: "running", label: "存入隐私池..." });
  const secretBytes = crypto.getRandomValues(new Uint8Array(31));
  const secretHex = "0x" + Array.from(secretBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const { privacyAddress, addr20, q, nullifier, secret } = await deriveFromSecret(secretHex);

  const depositData = iface.encodeFunctionData("deposit", [privacyAddress, 0, amount, "0x"]);
  const depositTxHash = await signAndBroadcast(keystoreJson, prfKey, derivationPath, addressA, ADDRESSES.ZWERC20, depositData, 0n, provider);

  onStep({ id: "deposit", status: "running", label: "等待存款确认...", txHash: depositTxHash });
  await provider.waitForTransaction(depositTxHash, 1);
  onStep({ id: "deposit", status: "done", label: "已存入隐私池", txHash: depositTxHash });
  onStep({ id: "done", status: "done", label: "存钱完成" });

  return { depositTxHash, secretHex, privacyAddress, addr20, q, nullifier, secret, amount, amountUSDC: params.amountUSDC };
}

/** Check if a known privacy address still has funds in the pool. */
export async function checkPrivacyBalance(privacyAddress: string): Promise<{
  found: boolean;
  amount: bigint;
  decimals: number;
}> {
  const provider = await getProviderWithFallback();
  const zwContract = new ethers.Contract(ADDRESSES.ZWERC20, ZWERC20_ABI, provider);
  const usdcContract = new ethers.Contract(ADDRESSES.USDC, ERC20_ABI, provider);
  const decimals = Number(await usdcContract.decimals());

  const poseidon = await buildPoseidon();
  const commitment = await findUserCommitment(zwContract, privacyAddress, poseidon);

  if (!commitment) return { found: false, amount: 0n, decimals };
  return { found: true, amount: commitment.amount, decimals };
}

/** Sync Merkle tree + generate ZK proof + remint to addressB. Requires a prior runDepositOnly result. */
export async function runRemintOnly(params: {
  keystoreJson: string;
  prfKey: string;
  addressA: string;
  addressB: string;
  privacyAddress: string;
  addr20: bigint;
  q: bigint;
  nullifier: bigint;
  secret: bigint;
  amount: bigint;
  amountUSDC: string;
  onStep: StepCallback;
}): Promise<{ remintTxHash: string }> {
  const { keystoreJson, prfKey, addressA, addressB, privacyAddress, addr20, q, nullifier, secret, amount, onStep } = params;
  const derivationPath = "m/44'/60'/0'/0/0";

  onStep({ id: "init", status: "running", label: "连接 Sepolia 网络..." });
  const provider = await getProviderWithFallback();
  const zwContract = new ethers.Contract(ADDRESSES.ZWERC20, ZWERC20_ABI, provider);
  const iface = new ethers.Interface(ZWERC20_ABI);
  onStep({ id: "init", status: "done", label: "已连接 Sepolia" });

  onStep({ id: "tree", status: "running", label: "同步 Merkle 树..." });
  const poseidon = await buildPoseidon();
  const tree = await rebuildMerkleTree(zwContract, poseidon);
  const onchainRoot = await zwContract.root();
  const localRoot = "0x" + tree.root.toString(16).padStart(64, "0");

  if (localRoot.toLowerCase() !== onchainRoot.toLowerCase()) {
    throw new Error(`Merkle root mismatch: local=${localRoot} on-chain=${onchainRoot}`);
  }

  const userCommitment = await findUserCommitment(zwContract, privacyAddress, poseidon);
  if (!userCommitment) throw new Error("未找到存款记录，请先完成存钱操作。");

  onStep({ id: "tree", status: "done", label: "Merkle 树同步完成", detail: `Root: ${localRoot.slice(0, 18)}...` });

  onStep({ id: "proof", status: "running", label: "生成 ZK 证明（30-60秒）..." });
  const merkleProof = tree.getProof(userCommitment.index);
  const circuitInput = prepareCircuitInput({
    root: tree.root, nullifier, recipient: addressB, remintAmount: amount,
    secret, addr20, commitAmount: userCommitment.amount, q, merkleProof, redeem: true,
  });

  const snarkjs = await import("snarkjs");
  const { proof: zkProof, publicSignals } = await (snarkjs as any).groth16.fullProve(
    circuitInput, "/circuits/remint.wasm", "/circuits/remint_final.zkey"
  );

  const calldata = await (snarkjs as any).groth16.exportSolidityCallData(zkProof, publicSignals);
  const calldataJson = JSON.parse("[" + calldata + "]");
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const proofBytes = abiCoder.encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [calldataJson[0], calldataJson[1], calldataJson[2]]
  );
  onStep({ id: "proof", status: "done", label: "ZK 证明生成完成" });

  onStep({ id: "remint", status: "running", label: "向匿名地址取款..." });
  const nullifierHex = "0x" + nullifier.toString(16).padStart(64, "0");
  const remintData = iface.encodeFunctionData("remint", [
    addressB, 0, amount,
    { commitment: localRoot, nullifiers: [nullifierHex], proverData: "0x", relayerData: "0x", redeem: true, proof: proofBytes },
  ]);

  const remintTxHash = await signAndBroadcast(keystoreJson, prfKey, derivationPath, addressA, ADDRESSES.ZWERC20, remintData, 0n, provider);
  await provider.waitForTransaction(remintTxHash, 1);
  onStep({ id: "remint", status: "done", label: "取款完成", txHash: remintTxHash });
  onStep({ id: "done", status: "done", label: "取钱支付完成" });

  return { remintTxHash };
}
