import { buildPoseidon } from "circomlibjs";
import { ethers } from "ethers";

export class IncrementalMerkleTree {
  depth: number;
  zeros: bigint[];
  filledSubtrees: bigint[];
  leaves: bigint[];
  nextIndex: number;
  root: bigint;
  poseidon: any;

  constructor(depth: number, poseidon: any) {
    this.depth = depth;
    this.zeros = [];
    this.filledSubtrees = new Array(depth);
    this.leaves = [];
    this.nextIndex = 0;
    this.poseidon = poseidon;

    let currentZero = 0n;
    this.zeros[0] = currentZero;
    for (let i = 1; i < depth; i++) {
      currentZero = this.hash(currentZero, currentZero);
      this.zeros[i] = currentZero;
    }
    this.root = this.zeros[depth - 1];
  }

  private hash(left: bigint, right: bigint): bigint {
    const result = this.poseidon([left, right]);
    return BigInt(this.poseidon.F.toString(result));
  }

  insert(leaf: bigint) {
    this.leaves.push(leaf);
    const index = this.nextIndex;
    let currentHash = BigInt(leaf);
    let currentIndex = index;

    for (let i = 0; i < this.depth; i++) {
      if (currentIndex % 2 === 0) {
        this.filledSubtrees[i] = currentHash;
        currentHash = this.hash(currentHash, this.zeros[i]);
      } else {
        currentHash = this.hash(this.filledSubtrees[i], currentHash);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }

    this.root = currentHash;
    this.nextIndex++;
    return currentHash;
  }

  getProof(index: number): { pathElements: bigint[]; pathIndices: number[] } {
    if (index >= this.nextIndex) throw new Error("Index out of bounds");

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let currentIndex = index;

    for (let i = 0; i < this.depth; i++) {
      const isRight = currentIndex % 2 === 1;
      pathIndices.push(isRight ? 1 : 0);
      const levelSize = Math.pow(2, i);

      if (isRight) {
        // current is right child — sibling is the left node at (currentIndex - 1)
        const siblingLeafStart = (currentIndex - 1) * levelSize;
        pathElements.push(this._reconstructSubtree(siblingLeafStart, i));
      } else {
        // current is left child — sibling is the right node at (currentIndex + 1)
        const siblingLeafStart = (currentIndex + 1) * levelSize;
        if (siblingLeafStart < this.nextIndex) {
          pathElements.push(this._reconstructSubtree(siblingLeafStart, i));
        } else {
          pathElements.push(this.zeros[i]);
        }
      }
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { pathElements, pathIndices };
  }

  // leafIndex is the absolute leaf-array index of the leftmost leaf in this subtree
  private _reconstructSubtree(leafIndex: number, level: number): bigint {
    if (level === 0) {
      return leafIndex < this.leaves.length ? BigInt(this.leaves[leafIndex]) : this.zeros[0];
    }
    const levelSize = Math.pow(2, level - 1);
    const left = this._reconstructSubtree(leafIndex, level - 1);
    const right = this._reconstructSubtree(leafIndex + levelSize, level - 1);
    return this.hash(left, right);
  }
}

export async function deriveFromSecret(secret: string, tokenId: bigint = 0n) {
  const poseidon = await buildPoseidon();
  const secretBigInt = BigInt(secret);

  const addrScalar = poseidon.F.toString(poseidon([8065n, tokenId, secretBigInt]));
  const addr20 = BigInt(addrScalar) & ((1n << 160n) - 1n);
  const q = (BigInt(addrScalar) - addr20) / (1n << 160n);

  const privacyAddress = ethers.getAddress("0x" + addr20.toString(16).padStart(40, "0"));
  const nullifier = BigInt(poseidon.F.toString(poseidon([addr20, secretBigInt])));

  return { privacyAddress, addr20, q, nullifier, secret: secretBigInt, tokenId };
}

export async function rebuildMerkleTree(
  contract: ethers.Contract,
  poseidon: any,
  tokenId: number = 0
): Promise<IncrementalMerkleTree> {
  const leafCount = await contract.getCommitLeafCount(tokenId);
  if (leafCount === 0n) throw new Error("No commitments found on chain yet");

  const total = Number(leafCount);
  const allLeaves: Array<{ to: string; amount: bigint }> = [];
  const batchSize = 100;

  for (let i = 0; i < total; i += batchSize) {
    const length = Math.min(batchSize, total - i);
    const [, recipients, amounts] = await contract.getCommitLeaves(tokenId, i, length);
    for (let j = 0; j < recipients.length; j++) {
      allLeaves.push({ to: recipients[j], amount: BigInt(amounts[j]) });
    }
  }

  const tree = new IncrementalMerkleTree(20, poseidon);
  for (const leaf of allLeaves) {
    const commitment = poseidon([BigInt(leaf.to), BigInt(leaf.amount)]);
    tree.insert(BigInt(poseidon.F.toString(commitment)));
  }

  return tree;
}

export async function findUserCommitment(
  contract: ethers.Contract,
  privacyAddress: string,
  poseidon: any,
  tokenId: number = 0
): Promise<{ commitment: bigint; amount: bigint; index: number } | null> {
  const leafCount = await contract.getCommitLeafCount(tokenId);
  if (leafCount === 0n) return null;

  const total = Number(leafCount);
  const batchSize = 100;
  let offset = 0;

  while (offset < total) {
    const length = Math.min(batchSize, total - offset);
    const [, recipients, amounts] = await contract.getCommitLeaves(tokenId, offset, length);
    for (let j = 0; j < recipients.length; j++) {
      if (recipients[j].toLowerCase() === privacyAddress.toLowerCase()) {
        const commitment = poseidon([BigInt(recipients[j]), BigInt(amounts[j])]);
        return {
          commitment: BigInt(poseidon.F.toString(commitment)),
          amount: BigInt(amounts[j]),
          index: offset + j,
        };
      }
    }
    offset += length;
  }

  return null;
}

export function prepareCircuitInput(params: {
  root: bigint;
  nullifier: bigint;
  recipient: string;
  remintAmount: bigint;
  id?: bigint;
  redeem?: boolean;
  relayerFee?: bigint;
  secret: bigint;
  addr20: bigint;
  commitAmount: bigint;
  q: bigint;
  merkleProof: { pathElements: bigint[]; pathIndices: number[] };
}) {
  return {
    root: params.root,
    nullifier: params.nullifier,
    to: BigInt(params.recipient),
    remintAmount: params.remintAmount,
    id: params.id ?? 0n,
    redeem: params.redeem ? 1n : 0n,
    relayerFee: params.relayerFee ?? 0n,
    secret: params.secret,
    addr20: params.addr20,
    commitAmount: params.commitAmount,
    q: params.q,
    pathElements: params.merkleProof.pathElements,
    pathIndices: params.merkleProof.pathIndices,
  };
}
