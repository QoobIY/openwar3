import type { DataSource } from "./types";

export type War3TextEncoding = "utf-8" | "windows-1252" | "windows-1251";
type LegacyEncoding = Exclude<War3TextEncoding, "utf-8">;

let activeEncoding: War3TextEncoding = "windows-1252";
let legacyEncoding: LegacyEncoding = "windows-1252";

const SAMPLE_FILES = [
  "UI\\FrameDef\\GlobalStrings.fdf",
  "UI\\HelpStrings.txt",
  "Units\\HumanUnitStrings.txt",
  "Units\\OrcUnitStrings.txt",
  "Units\\UndeadUnitStrings.txt",
  "Units\\NightElfUnitStrings.txt",
] as const;

const RUSSIAN_MARKERS = new Set([
  0xa8, 0xb8,
  0xd8, 0xd9, 0xda, 0xdb, 0xdd, 0xde,
  0xf8, 0xfd, 0xfe,
]);

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function hasNonAscii(bytes: Uint8Array): boolean {
  return bytes.some((byte) => byte >= 0x80);
}

function detectLegacyEncoding(
  samples: Iterable<Uint8Array | null>,
  locale?: string | null,
): LegacyEncoding {
  if (locale?.toLowerCase() === "ruru") return "windows-1251";
  let markers = 0;
  for (const bytes of samples) {
    if (!bytes) continue;
    for (const byte of bytes) if (RUSSIAN_MARKERS.has(byte)) markers++;
  }
  return markers >= 4 ? "windows-1251" : "windows-1252";
}

export function detectWar3TextEncoding(
  samples: Iterable<Uint8Array | null>,
  locale?: string | null,
): War3TextEncoding {
  const all = [...samples];
  for (const bytes of all) {
    if (bytes && hasNonAscii(bytes) && decodeUtf8(bytes) !== null) return "utf-8";
  }
  return detectLegacyEncoding(all, locale);
}

export function configureWar3TextEncoding(source: DataSource, locale?: string | null): War3TextEncoding {
  const samples = SAMPLE_FILES.map((path) => source.rawBytes(path));
  legacyEncoding = detectLegacyEncoding(samples, locale);
  activeEncoding = detectWar3TextEncoding(samples, locale);
  return activeEncoding;
}

export function war3TextEncoding(): War3TextEncoding {
  return activeEncoding;
}

export function decodeWar3Text(bytes: Uint8Array): string {
  return decodeUtf8(bytes) ?? new TextDecoder(legacyEncoding).decode(bytes);
}

const encoders = new Map<LegacyEncoding, Map<number, number>>();

export function encodeWar3Text(text: string): Uint8Array {
  if (activeEncoding === "utf-8") return new TextEncoder().encode(text);
  let encoder = encoders.get(activeEncoding);
  if (!encoder) {
    encoder = new Map<number, number>();
    const decoder = new TextDecoder(activeEncoding);
    const bytes = new Uint8Array(1);
    for (let byte = 0x80; byte <= 0xff; byte++) {
      bytes[0] = byte;
      const decoded = decoder.decode(bytes);
      if (decoded.length === 1 && decoded.charCodeAt(0) !== 0xfffd) encoder.set(decoded.charCodeAt(0), byte);
    }
    encoders.set(activeEncoding, encoder);
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i] = code < 0x80 ? code : encoder.get(code) ?? 0x3f;
  }
  return out;
}
