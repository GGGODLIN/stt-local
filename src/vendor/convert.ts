// Script conversion of a transcript, after the provider and before the phone.
//
// A transcription endpoint answers Chinese in whichever script its model prefers, and the ChatGPT
// endpoint answers Simplified to a Taiwanese speaker. No provider takes a script hint (the
// `language` field is ISO-639-1, which cannot tell zh-Hans from zh-Hant), so the one place that can
// honour the operator's script is here, on the bridge, over the text every provider returns.
//
// Off unless `convert` is set in stt.json. The conversion is local (OpenCC's dictionaries are
// bundled), so this adds no outbound call to the bridge's no-egress posture.

import { Converter } from "opencc-js/cn2t";
import type { SttConversion } from "./types.ts";
import type { SttProvider } from "./provider.ts";

// Built once: constructing a converter walks its dictionaries, and every transcript reuses it.
const toTaiwan = Converter({ from: "cn", to: "twp" });

/** The transcript in the operator's script. */
export function convertTranscript(text: string, conversion: SttConversion): string {
  switch (conversion) {
    case "zh-TW":
      return toTaiwan(text);
  }
}

/** The same provider, with every transcript converted. Status and shutdown pass through untouched. */
export function withConversion(provider: SttProvider, conversion: SttConversion): SttProvider {
  return {
    ...provider,
    async transcribe(input, signal) {
      const result = await provider.transcribe(input, signal);
      return { ...result, text: convertTranscript(result.text, conversion) };
    },
  };
}
