import { deflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STREAMED = /\.(wav|mp3|avi|w3m|w3x|w3n)$/i;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collect(root, relative = "", out = []) {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collect(root, path, out);
    else if (entry.isFile() && !STREAMED.test(entry.name)) out.push(path);
  }
  return out;
}

export function packMediaCore(mediaRoot) {
  const root = resolve(mediaRoot);
  const filesRoot = join(root, "files");
  const paths = collect(filesRoot).sort();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let originalBytes = 0;
  for (const path of paths) {
    const name = Buffer.from(`files/${path}`);
    const original = readFileSync(join(filesRoot, path));
    const compressed = deflateRawSync(original, { level: 6 });
    const crc = crc32(original);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(original.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0808, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(original.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
    originalBytes += original.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(paths.length, 8);
  end.writeUInt16LE(paths.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  const packed = Buffer.concat([...localParts, central, end]);
  const output = join(root, "core.zip");
  writeFileSync(output, packed);
  const result = { files: paths.length, originalBytes, packedBytes: packed.length, output };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  packMediaCore(process.argv[2] ? resolve(process.argv[2]) : join(root, "media"));
}
