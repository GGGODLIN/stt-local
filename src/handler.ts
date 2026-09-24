// The OpenAI transcription shape, in front of one provider.
//
// Both callers speak it natively: Collie's `openai-compatible` provider and VoiceInk's custom cloud
// model each send `POST <base>/audio/transcriptions`, multipart, the audio in `file`. So this is the
// one place a transcript is made, whichever device recorded it. `model`, `language` and `prompt`
// are accepted and ignored: the service, not the caller, decides how audio becomes text.

import { timingSafeEqual } from "node:crypto";
import { SttCancelledError, SttError, type SttProvider } from "./vendor/provider.ts";

/** Collie's own cap, so a clip Collie accepted is never refused one hop later. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const EXTENSION_BY_TYPE = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["application/ogg", "ogg"],
  ["audio/mp4", "mp4"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/wave", "wav"],
]);
const KNOWN_EXTENSIONS = new Set(EXTENSION_BY_TYPE.values());

export interface RequestLog {
  status: number;
  bytes: number;
  ms: number;
  error?: string;
}

export interface HandlerDeps {
  apiKey: string;
  provider: SttProvider;
  /** One line per request. Never the audio and never the transcript. */
  log: (entry: RequestLog) => void;
  now?: () => number;
}

function openAiError(status: number, message: string): Response {
  return Response.json({ error: { message, type: "stt_local_error" } }, { status });
}

function authorised(header: string | null, apiKey: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header?.trim() ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]!);
  const expected = Buffer.from(apiKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The extension the upstream needs to pick a demuxer, from the part's type first and its name
 * second. VoiceInk may label a WAV `application/octet-stream`, so the name is a real fallback.
 */
export function extensionFor(type: string, name: string): string | null {
  const container = type.split(";", 1)[0]!.trim().toLowerCase();
  const byType = EXTENSION_BY_TYPE.get(container);
  if (byType !== undefined) return byType;
  const byName = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return byName !== undefined && KNOWN_EXTENSIONS.has(byName) ? byName : null;
}

const STATUS_BY_KIND = { timeout: 504, oversized: 413, refused: 502, unavailable: 503 } as const;

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;

  async function transcribe(req: Request): Promise<{ response: Response; bytes: number; error?: string }> {
    if (!authorised(req.headers.get("authorization"), deps.apiKey)) {
      return { response: openAiError(401, "missing or wrong API key"), bytes: 0 };
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return { response: openAiError(400, "expected a multipart form"), bytes: 0 };
    }
    const file = form.get("file");
    if (!(file instanceof File)) return { response: openAiError(400, "no file field"), bytes: 0 };
    const bytes = file.size;
    if (bytes === 0) return { response: openAiError(400, "the file is empty"), bytes };
    if (bytes > MAX_AUDIO_BYTES) return { response: openAiError(413, "the file is larger than 8 MB"), bytes };
    const extension = extensionFor(file.type, file.name);
    if (extension === null) return { response: openAiError(415, "unsupported audio format"), bytes };

    try {
      const result = await deps.provider.transcribe(
        {
          audio: new Uint8Array(await file.arrayBuffer()),
          mimeType: file.type || `audio/${extension}`,
          filename: `recording.${extension}`,
        },
        req.signal,
      );
      return { response: Response.json({ text: result.text }), bytes };
    } catch (err) {
      if (err instanceof SttError) {
        return { response: openAiError(STATUS_BY_KIND[err.kind], err.message), bytes, error: err.message };
      }
      if (err instanceof SttCancelledError) {
        return { response: openAiError(499, "the caller went away"), bytes, error: "cancelled" };
      }
      return { response: openAiError(500, "transcription failed"), bytes, error: String(err) };
    }
  }

  return async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, provider: await deps.provider.status() });
    }
    if (req.method !== "POST" || url.pathname !== "/v1/audio/transcriptions") {
      return openAiError(404, "not found");
    }
    const started = now();
    const { response, bytes, error } = await transcribe(req);
    const entry: RequestLog = { status: response.status, bytes, ms: now() - started };
    if (error !== undefined) entry.error = error;
    deps.log(entry);
    return response;
  };
}
