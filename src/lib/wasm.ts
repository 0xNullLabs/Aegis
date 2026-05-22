import init, {
  create_keystore as _create_keystore,
  export_mnemonic as _export_mnemonic,
  derive_accounts as _derive_accounts,
  sign_tx as _sign_tx,
  cache_keystore as _cache_keystore,
  clear_cached_keystore as _clear_cached_keystore,
} from "../pkg/tcx_wasm";

let ready = false;

export async function initWasm(): Promise<void> {
  if (ready) return;
  console.log("[tcx_wasm_bg] 初始化 WASM 模块：加载 /tcx_wasm_bg.wasm");
  await init("/tcx_wasm_bg.wasm");
  ready = true;
  console.log("[tcx_wasm_bg] WASM 模块初始化完成");
}

export function create_keystore(param_json: string): string {
  console.log("[tcx_wasm_bg] create_keystore — 根据参数创建加密 keystore（含私钥）");
  return _create_keystore(param_json);
}

export function export_mnemonic(param_json: string): string {
  console.log("[tcx_wasm_bg] export_mnemonic — 从 keystore 解密并导出助记词");
  return _export_mnemonic(param_json);
}

export function derive_accounts(param_json: string): string {
  console.log("[tcx_wasm_bg] derive_accounts — 从助记词/私钥派生链上账户地址");
  return _derive_accounts(param_json);
}

export function sign_tx(param_json: string): string {
  console.log("[tcx_wasm_bg] sign_tx — 使用私钥对交易进行签名，返回已签名的原始交易");
  return _sign_tx(param_json);
}

export function cache_keystore(keystore_json: string): void {
  console.log("[tcx_wasm_bg] cache_keystore — 将 keystore 缓存到 WASM 内存中，避免重复解密");
  _cache_keystore(keystore_json);
}

export function clear_cached_keystore(): void {
  console.log("[tcx_wasm_bg] clear_cached_keystore — 清除 WASM 内存中缓存的 keystore");
  _clear_cached_keystore();
}
