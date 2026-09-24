import { configPath, loadConfig } from "./config.ts";
import { createHandler } from "./handler.ts";
import { createCodexSttProvider } from "./vendor/codex.ts";
import { withConversion } from "./vendor/convert.ts";

const config = await loadConfig(configPath());

const codex = createCodexSttProvider({
  provider: "codex",
  codexBin: config.codexBin,
  wireIdentity: config.wireIdentity,
});
const provider = config.convert === undefined ? codex : withConversion(codex, config.convert);

const handler = createHandler({
  apiKey: config.apiKey,
  provider,
  log: (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })),
});

// Loopback only: the key is the second lock, not the first.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  maxRequestBodySize: 10 * 1024 * 1024,
  // The upstream allows two minutes; Bun's default 10s idle timeout would cut a slow answer off.
  idleTimeout: 150,
  fetch: handler,
});

console.log(JSON.stringify({ at: new Date().toISOString(), listening: `http://127.0.0.1:${server.port}/v1` }));

function shutdown(): void {
  provider.close?.();
  void server.stop();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
