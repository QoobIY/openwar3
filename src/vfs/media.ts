import { inflateRaw } from "pako";
import type { InstallFiles } from "../assets/opfs";
import { normalizeMpqPath, type DataSource, type LoadProgress } from "./types";

const STREAMED = /\.(wav|mp3|avi|w3m|w3x|w3n)$/i;

function key(path: string): string {
  return normalizeMpqPath(path).toLowerCase();
}

function unpackZip(bytes: Uint8Array): Array<[string, Uint8Array]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("media/core.zip: central directory not found");
  const count = view.getUint16(eocd + 10, true);
  let central = view.getUint32(eocd + 16, true);
  const out: Array<[string, Uint8Array]> = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(central, true) !== 0x02014b50) throw new Error("media/core.zip: invalid central entry");
    const method = view.getUint16(central + 10, true);
    const compressedSize = view.getUint32(central + 20, true);
    const normalSize = view.getUint32(central + 24, true);
    const nameLength = view.getUint16(central + 28, true);
    const extraLength = view.getUint16(central + 30, true);
    const commentLength = view.getUint16(central + 32, true);
    const local = view.getUint32(central + 42, true);
    const name = decoder.decode(bytes.subarray(central + 46, central + 46 + nameLength)).replace(/\//g, "\\");
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const start = local + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(start, start + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? inflateRaw(compressed) : null;
    if (!data || data.byteLength !== normalSize) throw new Error(`media/core.zip: cannot decode ${name}`);
    out.push([name, data]);
    central += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

export class MediaDataSource implements DataSource {
  readonly label = "media";
  private bytes = new Map<string, Uint8Array>();
  private names = new Map<string, string>();

  private constructor(private files: InstallFiles) {
    for (const name of files.keys()) this.names.set(key(name), name);
  }

  static async open(files: InstallFiles, onProgress?: LoadProgress): Promise<MediaDataSource> {
    const source = new MediaDataSource(files);
    const coreName = [...files.keys()].find((name) => name.toLowerCase() === "core.zip");
    if (coreName) {
      onProgress?.("Loading core game data…", 0);
      const packed = new Uint8Array(await files.get(coreName)!.arrayBuffer());
      for (const [name, bytes] of unpackZip(packed)) source.bytes.set(key(name), bytes);
      onProgress?.("Core game data loaded", 1);
      return source;
    }
    const preload = [...files.keys()].filter((name) => name.startsWith("files\\") && !STREAMED.test(name));
    let completed = 0;
    const worker = async (): Promise<void> => {
      while (preload.length) {
        const name = preload.shift()!;
        const file = files.get(name)!;
        source.bytes.set(key(name), new Uint8Array(await file.arrayBuffer()));
        completed++;
        onProgress?.(`Loading media… ${completed}/${preload.length}`, completed / preload.length);
      }
    };
    const workers = Math.min(24, preload.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return source;
  }

  private resolve(path: string): string | null {
    const normalized = normalizeMpqPath(path);
    const direct = this.names.get(key(normalized));
    if (direct) return direct;
    if (/\.mdx$/i.test(normalized)) {
      const converted = this.names.get(key(`gltf\\${normalized.replace(/\.mdx$/i, ".gltf")}`));
      return converted ?? this.names.get(key(`files\\${normalized}`)) ?? null;
    }
    if (/\.(gltf|glb)$/i.test(normalized)) return this.names.get(key(`gltf\\${normalized}`)) ?? null;
    return this.names.get(key(`gltf\\${normalized}`)) ?? this.names.get(key(`files\\${normalized}`)) ?? null;
  }

  exists(path: string): boolean {
    return this.resolve(path) !== null;
  }

  async read(path: string): Promise<Uint8Array> {
    const resolved = this.resolve(path);
    if (!resolved) throw new Error(`${this.label}: file not found: ${path}`);
    const id = key(resolved);
    let bytes = this.bytes.get(id);
    if (!bytes) {
      bytes = new Uint8Array(await this.files.get(resolved)!.arrayBuffer());
      this.bytes.set(id, bytes);
    }
    return bytes;
  }

  rawBytes(path: string): Uint8Array | null {
    const resolved = this.resolve(path);
    const bytes = resolved ? this.bytes.get(key(resolved)) : undefined;
    if (bytes) return bytes;
    if (/\.mdx$/i.test(path)) return this.bytes.get(key(`files\\${normalizeMpqPath(path)}`)) ?? null;
    return null;
  }

  list(): string[] {
    return [...this.names.values()].map((name) => name.startsWith("files\\") ? name.slice(6) : name).sort();
  }
}
