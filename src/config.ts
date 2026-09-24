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

interface RawConfig {
  port?: number;
  apiKey?: string;
  codexBin?: string;
  wireIdentity?: string;
  convert?: string;
}

/** The config, or the reason it cannot run. A missing key is refused, never defaulted to open. */
export type ParsedConfig = { ok: true; config: ServiceConfig } | { ok: false; reason: string };

export function parseConfig(raw: RawConfig): ParsedConfig {
  const refuse = (reason: string): ParsedConfig => ({ ok: false, reason });
  if (!raw.apiKey || raw.apiKey.length < 16) return refuse("apiKey is missing or shorter than 16 characters");
  if (!raw.codexBin) return refuse("codexBin is missing");
  const wireIdentity = raw.wireIdentity ?? "honest";
  if (wireIdentity !== "honest" && wireIdentity !== "codex-cli") {
    return refuse(`unknown wireIdentity "${wireIdentity}"`);
  }
  if (raw.convert !== undefined && raw.convert !== "zh-TW") return refuse(`unknown convert "${raw.convert}"`);
  const port = raw.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse(`bad port ${port}`);
  const config: ServiceConfig = { port, apiKey: raw.apiKey, codexBin: raw.codexBin, wireIdentity };
  if (raw.convert !== undefined) config.convert = raw.convert;
  return { ok: true, config };
}

export async function loadConfig(path: string): Promise<ServiceConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`no config at ${path}`);
  const parsed = parseConfig(await file.json());
  if (!parsed.ok) throw new Error(`${path}: ${parsed.reason}`);
  return parsed.config;
}
