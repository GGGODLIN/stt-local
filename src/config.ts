import { homedir } from "node:os";
import { join } from "node:path";
import type { SttConversion, SttWireIdentity } from "./vendor/types.ts";

export interface ServiceConfig {
  port: number;
  /** Every caller must send it as a bearer token: any local process can reach 127.0.0.1. */
  apiKey: string;
  /** Absolute, because launchd's PATH does not reach an nvm-installed codex. */
  codexBin: string;
  wireIdentity: SttWireIdentity;
  convert?: SttConversion;
}

export const DEFAULT_PORT = 8732;

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return env.STT_LOCAL_CONFIG ?? join(homedir(), ".config", "stt-local", "config.json");
}

/** The config, or the reason it cannot run. A missing key is refused, never defaulted to open. */
export type ParsedConfig = { ok: true; config: ServiceConfig } | { ok: false; reason: string };

export function parseConfig(raw: unknown): ParsedConfig {
  const refuse = (reason: string): ParsedConfig => ({ ok: false, reason });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse("config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.apiKey !== "string" || obj.apiKey.length < 16) {
    return refuse("apiKey is missing or shorter than 16 characters");
  }
  if (typeof obj.codexBin !== "string" || obj.codexBin.length === 0) {
    return refuse("codexBin is missing");
  }
  if (obj.wireIdentity !== undefined && obj.wireIdentity !== "honest" && obj.wireIdentity !== "codex-cli") {
    return refuse(`unknown wireIdentity "${String(obj.wireIdentity)}"`);
  }
  const wireIdentity: SttWireIdentity = obj.wireIdentity ?? "honest";
  if (obj.convert !== undefined && obj.convert !== "zh-TW") {
    return refuse(`unknown convert "${String(obj.convert)}"`);
  }
  const port = obj.port ?? DEFAULT_PORT;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return refuse(`bad port ${String(port)}`);
  }
  const config: ServiceConfig = { port, apiKey: obj.apiKey, codexBin: obj.codexBin, wireIdentity };
  if (obj.convert !== undefined) config.convert = obj.convert;
  return { ok: true, config };
}

export async function loadConfig(path: string): Promise<ServiceConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`no config at ${path}`);
  const parsed = parseConfig(await file.json());
  if (!parsed.ok) throw new Error(`${path}: ${parsed.reason}`);
  return parsed.config;
}
