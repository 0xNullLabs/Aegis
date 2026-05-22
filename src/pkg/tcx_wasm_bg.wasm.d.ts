/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const cache_keystore: (a: number, b: number) => void;
export const create_keystore: (a: number, b: number) => [number, number, number, number];
export const decrypt_message: (a: number, b: number) => [number, number, number, number];
export const derive_accounts: (a: number, b: number) => [number, number, number, number];
export const derive_message_key_pair: (a: number, b: number) => [number, number, number, number];
export const encrypt_message: (a: number, b: number) => [number, number, number, number];
export const export_mnemonic: (a: number, b: number) => [number, number, number, number];
export const sign_message: (a: number, b: number) => [number, number, number, number];
export const sign_message_event: (a: number, b: number) => [number, number, number, number];
export const sign_psbt: (a: number, b: number) => [number, number, number, number];
export const sign_psbts: (a: number, b: number) => [number, number, number, number];
export const sign_tx: (a: number, b: number) => [number, number, number, number];
export const sign_txs: (a: number, b: number) => [number, number, number, number];
export const clear_cached_keystore: () => void;
export const rustsecp256k1_v0_6_1_default_error_callback_fn: (a: number, b: number) => void;
export const rustsecp256k1_v0_6_1_default_illegal_callback_fn: (a: number, b: number) => void;
export const rustsecp256k1_v0_6_1_context_create: (a: number) => number;
export const rustsecp256k1_v0_6_1_context_destroy: (a: number) => void;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
