// Writes a first config with a fresh key, at 0600. Refuses to overwrite: the key is already copied
// into Collie's stt.json and VoiceInk, and a silent new one would break both.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, DEFAULT_PORT } from "./config.ts";

const codexBin = process.argv[2];
if (!codexBin) {
  console.error("usage: bun src/init.ts <absolute path to the codex binary>");
  process.exit(2);
}
const path = configPath();
if (existsSync(path)) {
  console.error(`${path} already exists; edit it by hand`);
  process.exit(1);
}
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const config = {
  port: DEFAULT_PORT,
  apiKey: `sttl-${randomBytes(24).toString("base64url")}`,
  codexBin,
  wireIdentity: "honest",
  convert: "zh-TW",
};
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`wrote ${path}`);
