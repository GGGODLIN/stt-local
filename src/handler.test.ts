import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config.ts";
import { createHandler, extensionFor, type RequestLog } from "./handler.ts";
import { withConversion } from "./vendor/convert.ts";
import { SttError, type SttAudio, type SttProvider } from "./vendor/provider.ts";

const KEY = "sttl-test-key-0123456789";

function fakeProvider(answer: (input: SttAudio) => Promise<string>): SttProvider & { seen: SttAudio[] } {
  const seen: SttAudio[] = [];
  return {
    id: "fake",
    seen,
    status: async () => ({ available: true }),
    async transcribe(input) {
      seen.push(input);
      return { text: await answer(input) };
    },
  };
}

function upload(opts: { key?: string | null; file?: File; path?: string } = {}): Request {
  const form = new FormData();
  if (opts.file !== undefined) form.append("file", opts.file);
  form.append("model", "whatever-the-caller-says");
  const headers = new Headers();
  if (opts.key !== null) headers.set("authorization", `Bearer ${opts.key ?? KEY}`);
  return new Request(`http://127.0.0.1:8732${opts.path ?? "/v1/audio/transcriptions"}`, {
    method: "POST",
    body: form,
    headers,
  });
}

const wav = (bytes = 64) => new File([new Uint8Array(bytes)], "clip.wav", { type: "audio/wav" });

describe("the transcription route", () => {
  test("answers the OpenAI shape and logs no text", async () => {
    const provider = fakeProvider(async () => "你好 commit message");
    const logs: RequestLog[] = [];
    const handle = createHandler({ apiKey: KEY, provider, log: (e) => logs.push(e) });
    const res = await handle(upload({ file: wav() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "你好 commit message" });
    expect(provider.seen[0]!.filename).toBe("recording.wav");
    expect(JSON.stringify(logs)).not.toContain("commit");
    expect(logs[0]!.status).toBe(200);
  });

  test("refuses a missing or wrong key before reading the audio", async () => {
    const provider = fakeProvider(async () => "x");
    const handle = createHandler({ apiKey: KEY, provider, log: () => {} });
    expect((await handle(upload({ key: null, file: wav() }))).status).toBe(401);
    expect((await handle(upload({ key: "sttl-test-key-012345678X", file: wav() }))).status).toBe(401);
    expect(provider.seen.length).toBe(0);
  });

  test("refuses an empty, missing, oversized or unknown file", async () => {
    const handle = createHandler({ apiKey: KEY, provider: fakeProvider(async () => "x"), log: () => {} });
    expect((await handle(upload({}))).status).toBe(400);
    expect((await handle(upload({ file: wav(0) }))).status).toBe(400);
    expect((await handle(upload({ file: wav(8 * 1024 * 1024 + 1) }))).status).toBe(413);
    const text = new File(["hi"], "notes.txt", { type: "text/plain" });
    expect((await handle(upload({ file: text }))).status).toBe(415);
  });

  test("maps a provider failure to its status and message", async () => {
    const provider = fakeProvider(async () => {
      throw new SttError("refused", "the Codex account is rate limited (429) — try again shortly");
    });
    const handle = createHandler({ apiKey: KEY, provider, log: () => {} });
    const res = await handle(upload({ file: wav() }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toContain("rate limited");
  });

  test("serves health and nothing else", async () => {
    const handle = createHandler({ apiKey: KEY, provider: fakeProvider(async () => "x"), log: () => {} });
    const health = await handle(new Request("http://127.0.0.1:8732/health"));
    expect(await health.json()).toEqual({ ok: true, provider: { available: true } });
    expect((await handle(upload({ file: wav(), path: "/v1/chat/completions" }))).status).toBe(404);
  });

  test("converts through the vendored OpenCC wrapper", async () => {
    const provider = withConversion(fakeProvider(async () => "软件的信息 commit message"), "zh-TW");
    const handle = createHandler({ apiKey: KEY, provider, log: () => {} });
    const res = await handle(upload({ file: wav() }));
    expect(await res.json()).toEqual({ text: "軟體的資訊 commit message" });
  });
});

describe("extensionFor", () => {
  test("takes the type first, the name as a fallback", () => {
    expect(extensionFor("audio/webm;codecs=opus", "blob")).toBe("webm");
    expect(extensionFor("application/octet-stream", "rec.WAV")).toBe("wav");
    expect(extensionFor("application/octet-stream", "rec.exe")).toBeNull();
  });
});

describe("parseConfig", () => {
  test("refuses a config with no usable key", () => {
    expect(parseConfig({ codexBin: "/x/codex" }).ok).toBe(false);
    expect(parseConfig({ codexBin: "/x/codex", apiKey: "short" }).ok).toBe(false);
  });

  test("fills the defaults", () => {
    const parsed = parseConfig({ codexBin: "/x/codex", apiKey: KEY });
    expect(parsed).toEqual({
      ok: true,
      config: { port: 8732, apiKey: KEY, codexBin: "/x/codex", wireIdentity: "honest" },
    });
  });
});
