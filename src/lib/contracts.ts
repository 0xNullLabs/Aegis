// Sepolia Testnet - ZWToken commit a0e27e5
export const CHAIN_ID = 11155111;

export const ADDRESSES = {
  ZWERC20: "0x7E45741E01F5830Ff69a9faB1B6bd3f953da0503",
  USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  ZWETH: "0x48E4C0f0BE2a996b36F72dED5A21C170a2404796",
} as const;

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

export const ZWERC20_ABI = [
  "function deposit(address to, uint256 id, uint256 amount, bytes data) external payable",
  "function withdraw(address to, uint256 id, uint256 amount, bytes data) external",
  "function remint(address to, uint256 id, uint256 amount, tuple(bytes32 commitment, bytes32[] nullifiers, bytes proverData, bytes relayerData, bool redeem, bytes proof) data) external",
  "function balanceOf(address account) external view returns (uint256)",
  "function root() external view returns (bytes32)",
  "function getCommitLeafCount(uint256 id) external view returns (uint256)",
  "function getCommitLeaves(uint256 id, uint256 startIndex, uint256 length) external view returns (bytes32[] memory commitHashes, address[] memory recipients, uint256[] memory amounts)",
  "function nullifierUsed(bytes32 nullifier) external view returns (bool)",
  "function hasFirstReceiptRecorded(address account) external view returns (bool)",
];

// Primary Sepolia RPC — proxied through Next.js API to avoid browser CORS restrictions
export const SEPOLIA_RPC = "/api/rpc";
// Fallback RPCs if primary fails (server-side use only)
export const SEPOLIA_RPC_FALLBACKS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://rpc.sepolia.org",
];

export const ETHERSCAN_BASE = "https://sepolia.etherscan.io";

// HD derivation paths
export const ETH_PATH_PRIMARY = "m/44'/60'/0'/0/0";   // Account A — payer
export const ETH_PATH_SECONDARY = "m/44'/60'/0'/0/1"; // Account B — anonymous recipient
