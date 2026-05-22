declare module "snarkjs" {
  export const groth16: {
    fullProve(input: any, wasmFile: string, zkeyFile: string): Promise<{ proof: any; publicSignals: string[] }>;
    exportSolidityCallData(proof: any, publicSignals: string[]): Promise<string>;
  };
}
