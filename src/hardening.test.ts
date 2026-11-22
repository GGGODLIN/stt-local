import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig } from "./config.ts";
import { createHandler, type RequestLog } from "./handler.ts";
import { createCodexAuthBroker, type CodexAppServerProcess } from "./vendor/codex-auth.ts";
import { createCodexSttProvider } from "./vendor/codex.ts";
import { SttError, type SttAudio, type SttProvider } from "./vendor/provider.ts";
import type { CodexSttSettings } from "./vendor/types.ts";

const KEY = "sttl-hardening-key-0123456789";

interface Frame {
  id?: number;
  method?: string;
  params?: { includeToken?: boolean; refreshToken?: boolean };
}

interface FakeConfig {
  answerInitialize?: boolean;
  authMethod?: string | null;
  token?: string;
  hold?: boolean;
  onWrite?: (frame: Frame, fake: FakeAppServer) => void;
}

interface FakeAppServer {
  process: CodexAppServerProcess;
  written: Frame[];
  killed: boolean;
  release(): void;
  emit(line: string): void;
  emitRaw(chunk: string): void;
  die(reason: string): void;
}

function fakeAppServer(config: FakeConfig = {}): FakeAppServer {
  const answerInitialize = config.answerInitialize ?? true;
  const authMethod = config.authMethod === undefined ? "chatgpt" : config.authMethod;
  const token = config.token ?? "access-token";
  let stdout: ((chunk: Uint8Array) => void) | null = null;
  let onExit: ((reason: string) => void) | null = null;
  const held: string[] = [];

  const fake: FakeAppServer = {
    written: [],
    killed: false,
    emit(line) {
      stdout?.(new TextEncoder().encode(`${line}\n`));
    },
    emitRaw(chunk) {
      stdout?.(new TextEncoder().encode(chunk));
    },
    release() {
      const queued = held.splice(0, held.length);
      for (const line of queued) fake.emit(line);
    },
    die(reason) {
      onExit?.(reason);
    },
    process: {
      stdin: {
        write(chunk) {
          const frame = JSON.parse(chunk) as Frame;
          fake.written.push(frame);
          config.onWrite?.(frame, fake);
          if (frame.method === "initialize" && answerInitialize) {
            fake.emit(JSON.stringify({ id: frame.id, result: { codexHome: "/tmp/codex" } }));
          }
          if (frame.method === "getAuthStatus") {
            const line = JSON.stringify({
              id: frame.id,
              result: {
                authMethod,
                authToken: frame.params?.includeToken === true ? token : null,
              },
            });
            if (config.hold === true) held.push(line);
            else fake.emit(line);
          }
          return true;
        },
      },
      onStdout(listener) {
        stdout = listener;
      },
      onStderr() {},
      onExit(listener) {
        onExit = listener;
      },
      kill() {
        fake.killed = true;
      },
    },
  };
  return fake;
}

async function written(fake: FakeAppServer, count: number): Promise<void> {
  for (let turn = 0; turn < 100 && fake.written.length < count; turn++) await Promise.resolve();
  expect(fake.written).toHaveLength(count);
}

function methods(fake: FakeAppServer): (string | undefined)[] {
  return fake.written.map((frame) => frame.method);
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to get ephemeral port"));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForPortClosed(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const refused = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "ECONNREFUSED");
      });
    });
    if (refused) return;
    await Bun.sleep(10);
  }
  throw new Error(`Port ${port} did not close within ${timeoutMs}ms`);
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stt-local-hardening-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("hardening suite B1..B11", () => {
  test("B1: old child start() catch does not wipe replacement child's stdout buffer (fake + real stdio)", async () => {
    // (b) Real spawned stdio chunked generation swap via default spawnCodexAppServer
    const dir = makeTempDir();
    const spawnCountFile = join(dir, "spawns.txt");
    const childAReadyFile = join(dir, "child-a-ready");
    const childAExitedFile = join(dir, "child-a-exited");
    const childScript = join(dir, "fake-codex.ts");
    const wrapperBin = join(dir, "fake-codex");

    writeFileSync(
      childScript,
      `
import { appendFileSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const countFile = ${JSON.stringify(spawnCountFile)};
const readyFile = ${JSON.stringify(childAReadyFile)};
const exitedFile = ${JSON.stringify(childAExitedFile)};
appendFileSync(countFile, "x\\n");
const generation = readFileSync(countFile, "utf8").trim().split("\\n").length;

if (generation === 1) {
  process.on("SIGTERM", () => {
    writeFileSync(exitedFile, "exited");
    process.exit(0);
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (generation === 1) {
    if (frame.method === "initialize") {
      writeFileSync(readyFile, "ready");
    }
    return;
  }
  if (frame.method === "initialize") {
    writeSync(1, '{"id":');
    setTimeout(() => {
      writeSync(1, \`\${frame.id},"result":{"codexHome":"/tmp"}}\\n\`);
    }, 20);
  } else if (frame.method === "getAuthStatus") {
    writeSync(1, JSON.stringify({
      id: frame.id,
      result: {
        authMethod: "chatgpt",
        authToken: frame.params?.includeToken ? "real-stdio-fresh-token" : null,
      },
    }) + "\\n");
  }
});
`,
    );
    writeFileSync(wrapperBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)} "$@"\n`);
    chmodSync(wrapperBin, 0o755);

    const realBroker = createCodexAuthBroker({ codexBin: wrapperBin, requestTimeoutMs: 2_000 });
    try {
      const realP1 = realBroker.accessToken(false);
      const realP1Settled = realP1.catch((err: unknown) => err);
      await waitForCondition(() => existsSync(childAReadyFile), 2_000, "child A initialize");

      const realP2 = realBroker.accessToken(true);
      await waitForCondition(() => existsSync(childAExitedFile), 2_000, "child A exit");
      expect(await realP2).toEqual({ accessToken: "real-stdio-fresh-token" });
      expect(await realP1Settled).toBeInstanceOf(SttError);
    } finally {
      realBroker.close();
    }

    // (a) Synchronous fake CodexAppServerProcess generation swap
    let childBInitId: number | undefined;
    let finishChildBInit: (() => void) | null = null;
    const childA = fakeAppServer({ answerInitialize: false });
    const childB = fakeAppServer({
      answerInitialize: false,
      token: "fresh-token",
      onWrite: (frame, fake) => {
        if (frame.method === "initialize") {
          childBInitId = frame.id;
          fake.emitRaw('{"id":');
          finishChildBInit = () => {
            fake.emitRaw(`${childBInitId},"result":{"codexHome":"/tmp"}}\n`);
          };
        }
      },
    });
    const queue = [childA, childB];
    const broker = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("unexpected spawn");
        return next.process;
      },
      requestTimeoutMs: 50,
    });

    try {
      const p1 = broker.accessToken(false);
      const p1Settled = p1.catch((err: unknown) => err);
      await written(childA, 1);

      const p2 = broker.accessToken(true);
      await Promise.resolve();
      await Promise.resolve();

      expect(finishChildBInit).not.toBeNull();
      finishChildBInit!();

      expect(await p2).toEqual({ accessToken: "fresh-token" });
      await p1Settled;
    } finally {
      broker.close();
    }
  });

  test("B2: stale start() continuation does not write initialized to replacement child or clobber lastKnown on close", async () => {
    const childA1 = fakeAppServer({ answerInitialize: false });
    const childB1 = fakeAppServer({ answerInitialize: false });
    const queue1 = [childA1, childB1];
    const broker1 = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => {
        const next = queue1.shift();
        if (next === undefined) throw new Error("unexpected spawn");
        return next.process;
      },
      requestTimeoutMs: 500,
    });

    const p1 = broker1.accessToken(false).catch(() => {});
    await written(childA1, 1);
    const initId1 = childA1.written[0]!.id!;

    childA1.emit(JSON.stringify({ id: initId1, result: { codexHome: "/tmp" } }));
    const p2 = broker1.accessToken(true).catch(() => {});

    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(methods(childB1)).toEqual(["initialize"]);
    broker1.close();
    await Promise.all([p1, p2]);

    const childA2 = fakeAppServer({ answerInitialize: false });
    const broker2 = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => childA2.process,
      requestTimeoutMs: 500,
    });

    const p3 = broker2.accessToken(false).catch(() => {});
    await written(childA2, 1);
    const initId2 = childA2.written[0]!.id!;

    childA2.emit(JSON.stringify({ id: initId2, result: { codexHome: "/tmp" } }));
    broker2.close();

    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(broker2.lastKnown().available).toBe(false);
    expect(broker2.lastKnown().reason).toContain("shut down");
    await p3;
  });

  test("B3: post-ensureStarted() callers do not send getAuthStatus to uninitialized replacement child or misreport close()", async () => {
    let p2: Promise<unknown> | undefined;
    const childB = fakeAppServer({ answerInitialize: false });
    const childA = fakeAppServer({
      answerInitialize: true,
      onWrite: (frame) => {
        if (frame.method === "initialized") {
          p2 = broker1.accessToken(true).catch(() => {});
        }
      },
    });
    const queue = [childA, childB];
    const broker1 = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("unexpected spawn");
        return next.process;
      },
      requestTimeoutMs: 500,
    });

    const p1 = broker1.accessToken(false).catch(() => {});
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(methods(childB)).toEqual(["initialize"]);
    broker1.close();
    await Promise.all([p1, p2]);

    const closeChild = fakeAppServer({
      answerInitialize: true,
      onWrite: (frame) => {
        if (frame.method === "initialized") {
          broker2.close();
        }
      },
    });
    const broker2 = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => closeChild.process,
      requestTimeoutMs: 500,
    });

    await expect(broker2.accessToken(false)).rejects.toThrow("shut down");
    broker2.close();
  });

  test("B4: post-handshake RPC timeout retires and kills wedged child so subsequent non-refresh calls recover", async () => {
    const first = fakeAppServer({ hold: true });
    const second = fakeAppServer({ token: "recovered-token" });
    const queue = [first, second];
    const broker = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("unexpected spawn");
        return next.process;
      },
      requestTimeoutMs: 15,
    });

    try {
      await expect(broker.accessToken(false)).rejects.toThrow("in time");
      expect(first.killed).toBe(true);
      expect(await broker.accessToken(false)).toEqual({ accessToken: "recovered-token" });
      expect(methods(second)).toEqual(["initialize", "initialized", "getAuthStatus"]);
    } finally {
      broker.close();
    }
  });

  test("B5: close() updates lastKnown() to unavailable and keeps it unavailable after probe()", async () => {
    const fake = fakeAppServer();
    const broker = createCodexAuthBroker({ codexBin: "codex", spawn: () => fake.process });

    await broker.accessToken();
    expect(broker.lastKnown()).toEqual({ available: true });

    broker.close();
    expect(broker.lastKnown().available).toBe(false);
    expect(broker.lastKnown().reason).toContain("shut down");

    const probed = await broker.probe();
    expect(probed.available).toBe(false);
    expect(broker.lastKnown().available).toBe(false);
  });

  test("B6: codex.ts transcribe() checks response.ok before readCapped and discards non-OK body", async () => {
    const settings: CodexSttSettings = { provider: "codex", codexBin: "codex", wireIdentity: "honest" };
    const clip: SttAudio = { audio: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", filename: "clip.wav" };
    const broker = {
      lastKnown: () => ({ available: true }),
      probe: async () => ({ available: true }),
      accessToken: async () => ({
        accessToken: `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth.chatgpt_account_id": "acct-1" })).toString("base64url")}.s`,
      }),
      close: () => {},
    };

    const provider502 = createCodexSttProvider(settings, {
      broker,
      prime: false,
      version: "1.2.3",
      fetch: async () => new Response("x".repeat(300 * 1024), { status: 502 }),
    });
    const err502 = await provider502.transcribe(clip).then(
      () => null,
      (err: unknown) => err,
    );
    expect(err502).toBeInstanceOf(SttError);
    expect(err502 instanceof SttError ? err502.kind : null).toBe("refused");
    expect(err502 instanceof Error ? err502.message : "").toContain("502");

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const provider500 = createCodexSttProvider(settings, {
      broker,
      prime: false,
      version: "1.2.3",
      fetch: async () => new Response(stream, { status: 500 }),
    });
    const err500 = await provider500.transcribe(clip).then(
      () => null,
      (err: unknown) => err,
    );
    expect(err500).toBeInstanceOf(SttError);
    expect(err500 instanceof SttError ? err500.kind : null).toBe("refused");
    expect(err500 instanceof Error ? err500.message : "").toContain("500");
    expect(cancelled).toBe(true);
  });

  test("B7: handler.ts maps SttError('oversized') to HTTP 502 instead of 413", async () => {
    const provider: SttProvider = {
      id: "fake",
      status: async () => ({ available: true }),
      async transcribe() {
        throw new SttError("oversized");
      },
    };
    const handle = createHandler({ apiKey: KEY, provider, log: () => {} });
    const form = new FormData();
    form.append("file", new File([new Uint8Array(64)], "clip.wav", { type: "audio/wav" }));
    const res = await handle(
      new Request("http://127.0.0.1:8732/v1/audio/transcriptions", {
        method: "POST",
        body: form,
        headers: { authorization: `Bearer ${KEY}` },
      }),
    );
    expect(res.status).toBe(502);
  });

  test("B8: handler.ts maps client abort during req.formData() to 499 cancelled", async () => {
    const provider: SttProvider = {
      id: "fake",
      status: async () => ({ available: true }),
      async transcribe() {
        return { text: "ok" };
      },
    };
    const logs: RequestLog[] = [];
    const handle = createHandler({ apiKey: KEY, provider, log: (entry) => logs.push(entry) });
    const ac = new AbortController();
    ac.abort();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("The connection was closed.", "AbortError"));
      },
    });
    const req = new Request("http://127.0.0.1:8732/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "multipart/form-data; boundary=b",
      },
      signal: ac.signal,
      body,
    });
    const res = await handle(req);
    expect(res.status).toBe(499);
    expect(logs[0]).toMatchObject({ status: 499, error: "cancelled" });

    const abortDuringProviderAc = new AbortController();
    const abortingProvider: SttProvider = {
      id: "fake",
      status: async () => ({ available: true }),
      async transcribe(_input, signal) {
        abortDuringProviderAc.abort();
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        return { text: "ok" };
      },
    };
    const logs2: RequestLog[] = [];
    const handle2 = createHandler({ apiKey: KEY, provider: abortingProvider, log: (entry) => logs2.push(entry) });
    const form2 = new FormData();
    form2.append("file", new File([new Uint8Array(64)], "clip.wav", { type: "audio/wav" }));
    const res2 = await handle2(
      new Request("http://127.0.0.1:8732/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
        signal: abortDuringProviderAc.signal,
        body: form2,
      }),
    );
    expect(res2.status).toBe(499);
    expect(logs2[0]).toMatchObject({ status: 499, error: "cancelled" });
  });

  test("B9: main.ts shutdown() drains in-flight requests via server.stop() before closing provider and exiting", async () => {
    const dir = makeTempDir();
    const port = await findFreePort();
    const readyFile = join(dir, "ready");
    const releaseFile = join(dir, "release");
    const codexScript = join(dir, "fake-codex.ts");
    const codexBin = join(dir, "fake-codex");
    const configFile = join(dir, "config.json");

    writeFileSync(
      codexScript,
      `
import { existsSync, writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const readyFile = ${JSON.stringify(readyFile)};
const releaseFile = ${JSON.stringify(releaseFile)};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    writeSync(1, JSON.stringify({ id: frame.id, result: { codexHome: "/tmp" } }) + "\\n");
  } else if (frame.method === "getAuthStatus") {
    writeFileSync(readyFile, "ready");
    const timer = setInterval(() => {
      if (existsSync(releaseFile)) {
        clearInterval(timer);
        writeSync(1, JSON.stringify({ id: frame.id, result: { authMethod: null, authToken: null } }) + "\\n");
      }
    }, 10);
  }
});
`,
    );
    writeFileSync(codexBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(codexScript)} "$@"\n`);
    chmodSync(codexBin, 0o755);
    writeFileSync(configFile, JSON.stringify({ port, apiKey: KEY, codexBin }));

    const proc = spawn(process.execPath, [join(import.meta.dir, "main.ts")], {
      env: { ...process.env, STT_LOCAL_CONFIG: configFile },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let listening = false;
    let stdoutBuf = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      if (stdoutBuf.includes('"listening"')) listening = true;
    });
    const exitPromise = new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => resolve(code));
    });

    try {
      await waitForCondition(() => listening, 5_000, "main.ts listening");

      const form = new FormData();
      form.append("file", new File([new Uint8Array(64)], "clip.wav", { type: "audio/wav" }));
      const fetchPromise = fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
        body: form,
      });

      await waitForCondition(() => existsSync(readyFile), 5_000, "in-flight getAuthStatus");
      proc.kill("SIGTERM");

      await waitForPortClosed(port, 5_000);
      writeFileSync(releaseFile, "go");

      const res = await fetchPromise;
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain("not signed in");
      expect(await exitPromise).toBe(0);
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
        await exitPromise;
      }
    }
  });

  test("B10: parseConfig rejects non-object JSON and non-string apiKey/codexBin, and loadConfig includes path", async () => {
    expect(parseConfig(null as unknown as Parameters<typeof parseConfig>[0]).ok).toBe(false);
    expect(parseConfig([] as unknown as Parameters<typeof parseConfig>[0]).ok).toBe(false);
    expect(
      parseConfig({ apiKey: new Array(16).fill("a"), codexBin: "/x/codex" } as unknown as Parameters<
        typeof parseConfig
      >[0]).ok,
    ).toBe(false);
    expect(
      parseConfig({ apiKey: KEY, codexBin: 123 } as unknown as Parameters<typeof parseConfig>[0]).ok,
    ).toBe(false);
    expect(
      parseConfig({ apiKey: KEY, codexBin: "/x/codex", wireIdentity: null } as unknown as Parameters<
        typeof parseConfig
      >[0]).ok,
    ).toBe(false);

    const dir = makeTempDir();
    const tmpPath = join(dir, "null-config.json");
    writeFileSync(tmpPath, "null\n");
    await expect(loadConfig(tmpPath)).rejects.toThrow(tmpPath);
  });

  test("B11: unbounded newline-less stdout buffer is capped, retiring child and failing pending requests with SttError('unavailable')", async () => {
    const badChild = fakeAppServer({ hold: true });
    const healthyChild = fakeAppServer({ token: "healthy-token" });
    const queue = [badChild, healthyChild];
    const broker = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("unexpected spawn");
        return next.process;
      },
      requestTimeoutMs: 5_000,
    });

    try {
      const started = Date.now();
      const pending = broker.accessToken(false);
      await written(badChild, 3);

      badChild.emitRaw("x".repeat(1600 * 1024));

      const err = await pending.then(
        () => null,
        (e: unknown) => e,
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(err).toBeInstanceOf(SttError);
      expect(err instanceof SttError ? err.kind : null).toBe("unavailable");
      expect(badChild.killed).toBe(true);

      expect(await broker.accessToken(false)).toEqual({ accessToken: "healthy-token" });
    } finally {
      broker.close();
    }
  });
});
