// The few settings types the vendored Collie modules imported from Collie's own config.ts.
// Kept to exactly what they use, so a re-vendor is a diff against Collie and nothing else.

export const SERVICE_VERSION = "0.1.0";

export type SttWireIdentity = "honest" | "codex-cli";

export type SttConversion = "zh-TW";

export interface CodexSttSettings {
  provider: "codex";
  codexBin: string;
  wireIdentity: SttWireIdentity;
  convert?: SttConversion;
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;
