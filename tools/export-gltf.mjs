import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assetKey, convertModel, decodeTexture, portablePath, validateGltf } from "./mdx-gltf.mjs";
import { packMediaCore } from "./pack-media-core.mjs";

const require = createRequire(import.meta.url);
const mpqModule = require("mdx-m3-viewer/dist/cjs/parsers/mpq");
const MpqArchive = (mpqModule.default ?? mpqModule).Archive;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVES = ["war3.mpq", "War3x.mpq", "War3xlocal.mpq", "War3Patch.mpq"];

function argument(name, fallback = null) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function openArchive(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const archive = new MpqArchive();
  archive.load(copy, true);
  return archive;
}

function writeBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function outputPath(root, path) {
  const result = resolve(root, ...portablePath(path).split("/"));
  if (result !== root && !result.startsWith(root + sep)) throw new Error(`Unsafe asset path: ${path}`);
  return result;
}

function uri(path) {
  return path.split(sep).map(encodeURIComponent).join("/");
}

function sourceLabel(path) {
  return path.replace(/\//g, "\\");
}

const source = resolve(argument("source", join(REPO, "source")));
const output = resolve(argument("output", join(REPO, "media")));
const limit = Number(argument("limit", "0"));
const only = argument("only", "")?.toLowerCase() || "";
const skipExtract = hasFlag("skip-extract");
const skipNested = hasFlag("skip-nested");
const archives = new Map();
const knownNames = new Set();

for (const name of ARCHIVES) {
  const path = join(source, name);
  if (!existsSync(path)) continue;
  const archive = openArchive(readFileSync(path));
  archives.set(name, archive);
  if (name !== "War3Patch.mpq") {
    for (const pathName of archive.getFileNames()) if (pathName && !pathName.startsWith("(")) knownNames.add(pathName);
  }
  console.log(`Opened ${name}`);
}
if (!archives.size) throw new Error(`No MPQ archives found in ${source}`);

const entries = new Map();
for (const path of [...knownNames].sort((a, b) => a.localeCompare(b))) {
  const holders = ARCHIVES.filter((name) => archives.get(name)?.has(path));
  if (!holders.length) continue;
  const archive = holders[holders.length - 1];
  entries.set(assetKey(path), { path, archive, read: () => archives.get(archive).get(path)?.bytes() || null, nested: false });
}
console.log(`Effective files: ${entries.size}`);

const nestedEntries = new Map();
if (!skipNested) {
  for (const entry of [...entries.values()].filter((candidate) => /\.mpq$/i.test(candidate.path))) {
    try {
      const bytes = entry.read();
      const archive = openArchive(bytes);
      const namespace = entry.path.replace(/\.mpq$/i, "");
      let count = 0;
      for (const path of archive.getFileNames()) {
        if (!path || path.startsWith("(")) continue;
        const logical = `${entry.path}:${path}`;
        nestedEntries.set(assetKey(logical), {
          path: logical,
          diskPath: `__nested/${namespace}.mpq/${path}`,
          archive: `${entry.archive}:${entry.path}`,
          read: () => archive.get(path)?.bytes() || null,
          nested: true,
          namespace: entry.path,
        });
        count++;
      }
      console.log(`${entry.archive}:${entry.path}: ${count} files`);
    } catch (error) {
      console.warn(`Cannot open nested ${entry.path}: ${error.message}`);
    }
  }
}

const allEntries = new Map([...entries, ...nestedEntries]);
const extractionErrors = [];
let extracted = 0;
if (!skipExtract) {
  for (const entry of allEntries.values()) {
    try {
      const bytes = entry.read();
      if (!bytes) continue;
      writeBytes(outputPath(output, `files/${entry.diskPath || entry.path}`), bytes);
      extracted++;
      if (extracted % 1000 === 0) console.log(`Extracted ${extracted}/${allEntries.size}`);
    } catch (error) {
      extractionErrors.push({ source: sourceLabel(entry.path), archive: entry.archive, error: error.message });
    }
  }
  console.log(`Extracted ${extracted} files; failed ${extractionErrors.length}`);
}

const textureCache = new Map();
const textureErrors = [];
function resolveTexture(path, modelSourcePath, gltfFile) {
  const nestedNamespace = modelSourcePath.includes(":") ? modelSourcePath.slice(0, modelSourcePath.indexOf(":")) : null;
  const candidates = nestedNamespace ? [`${nestedNamespace}:${path}`, path] : [path];
  const entry = candidates.map((candidate) => allEntries.get(assetKey(candidate))).find(Boolean);
  if (!entry) return null;
  const extension = path.toLowerCase().slice(path.lastIndexOf("."));
  const convertedExtension = extension === ".blp" || extension === ".tga" ? ".png" : extension;
  const textureAssetPath = `textures/${entry.diskPath || entry.path}`.slice(0, -extension.length) + convertedExtension;
  const textureFile = outputPath(output, textureAssetPath);
  if (!textureCache.has(textureFile)) {
    try {
      const bytes = entry.read();
      if (!bytes) return null;
      writeBytes(textureFile, decodeTexture(entry.path, bytes));
      textureCache.set(textureFile, true);
    } catch (error) {
      textureErrors.push({ path: entry.path, error: error.message });
      textureCache.set(textureFile, false);
    }
  }
  if (!textureCache.get(textureFile)) return null;
  return { uri: uri(relative(dirname(gltfFile), textureFile)) };
}

const models = [...allEntries.values()].filter((entry) => /\.mdx$/i.test(entry.path) && (!only || entry.path.toLowerCase().includes(only)));
const selected = limit > 0 ? models.slice(0, limit) : models;
const manifest = {
  format: "openwar3-gltf-export-v1",
  source,
  archives: [...archives.keys()],
  originalFiles: allEntries.size,
  extracted: !skipExtract,
  extractedFiles: extracted,
  extractionErrors,
  models: [],
  failures: [],
  textureErrors,
};
let originalModelBytes = 0;
let gltfBytes = 0;
let binBytes = 0;
let completed = 0;

for (const entry of selected) {
  const gltfAssetPath = `gltf/${entry.diskPath || entry.path}`.replace(/\.mdx$/i, ".gltf");
  const gltfFile = outputPath(output, gltfAssetPath);
  const baseName = basename(gltfFile, ".gltf");
  try {
    const bytes = entry.read();
    if (!bytes) throw new Error("Cannot read source MDX");
    const originalFile = outputPath(output, `files/${entry.diskPath || entry.path}`);
    const result = convertModel(bytes, {
      sourcePath: sourceLabel(entry.path),
      sourceArchive: entry.archive,
      originalUri: uri(relative(dirname(gltfFile), originalFile)),
      baseName,
      resolveTexture: (path, sourcePath) => resolveTexture(path, sourcePath, gltfFile),
    });
    const errors = validateGltf(result.gltf, result.bin);
    if (errors.length) throw new Error(errors.slice(0, 10).join("; "));
    const binFile = gltfFile.replace(/\.gltf$/i, ".bin");
    writeBytes(binFile, result.bin);
    writeBytes(gltfFile, JSON.stringify(result.gltf));
    originalModelBytes += bytes.byteLength;
    gltfBytes += Buffer.byteLength(JSON.stringify(result.gltf));
    binBytes += result.bin.byteLength;
    manifest.models.push({
      source: sourceLabel(entry.path),
      archive: entry.archive,
      gltf: uri(relative(output, gltfFile)),
      original: uri(relative(output, originalFile)),
      sourceBytes: bytes.byteLength,
      gltfBytes: Buffer.byteLength(JSON.stringify(result.gltf)),
      binBytes: result.bin.byteLength,
      sequences: result.model.sequences.length,
      geosets: result.model.geosets.length,
      warnings: result.warnings.length,
      unresolvedTextures: result.unresolvedTextures,
    });
    completed++;
    if (completed % 100 === 0) console.log(`Converted ${completed}/${selected.length}; failed ${manifest.failures.length}`);
  } catch (error) {
    manifest.failures.push({ source: sourceLabel(entry.path), archive: entry.archive, error: error.stack || error.message });
    console.error(`FAIL ${entry.path}: ${error.message}`);
  }
}

let textureBytes = 0;
for (const [file, ok] of textureCache) if (ok) textureBytes += readFileSync(file).byteLength;
manifest.summary = {
  discoveredModels: models.length,
  convertedModels: completed,
  failedModels: manifest.failures.length,
  convertedTextures: [...textureCache.values()].filter(Boolean).length,
  failedTextures: textureErrors.length,
  originalModelBytes,
  gltfBytes,
  binBytes,
  textureBytes,
  convertedBytes: gltfBytes + binBytes + textureBytes,
};
writeBytes(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
packMediaCore(output);
console.log(JSON.stringify(manifest.summary, null, 2));
console.log(`Manifest: ${join(output, "manifest.json")}`);
if (manifest.failures.length) process.exitCode = 1;
