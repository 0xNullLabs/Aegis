import { ethers } from "ethers";
import { initWasm, create_keystore, derive_accounts } from "./wasm";
import { CHAIN_ID } from "./contracts";

export interface WalletInfo {
  keystoreJson: string;
  prfKey: string;
  addressA: string;
  addressB: string;
}

export async function createWalletFromSecret(secret: string): Promise<WalletInfo> {
  await initWasm();

  // Deterministic 16-byte entropy and 32-byte PRF key from the secret
  const secretHash = ethers.keccak256(ethers.toUtf8Bytes(secret));
  const entropy = secretHash.slice(2, 34); // first 16 bytes, no 0x
  const prfKey = ethers.keccak256(ethers.toUtf8Bytes("zkbuy:" + secret)).slice(2); // 32 bytes, no 0x

  const keystoreJson = create_keystore(
    JSON.stringify({
      prfKey,
      userId: "zkbuy",
      credentialId: "zkbuy",
      rpId: "zkbuy",
      entropy,
      network: "TESTNET",
    })
  );

  const accounts: Array<{ address: string }> = JSON.parse(
    derive_accounts(
      JSON.stringify({
        keystoreJson,
        key: prfKey,
        derivations: [
          {
            chain: "ETHEREUM",
            derivationPath: "m/44'/60'/0'/0/0",
            chainId: CHAIN_ID.toString(),
            network: "TESTNET",
          },
          {
            chain: "ETHEREUM",
            derivationPath: "m/44'/60'/0'/0/1",
            chainId: CHAIN_ID.toString(),
            network: "TESTNET",
          },
        ],
      })
    )
  );

  return {
    keystoreJson,
    prfKey,
    addressA: accounts[0].address,
    addressB: accounts[1].address,
  };
}
