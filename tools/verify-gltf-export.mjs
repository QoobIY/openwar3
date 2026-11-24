import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGltf } from "./mdx-gltf.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] || join(REPO, "media"));
const manifestPath = join(output, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const failures = [];
let checked = 0;
let images = 0;

function localUri(base, value) {
  const decoded = decodeURIComponent(value);
  if (/^[a-z]+:/i.test(decoded) || decoded.startsWith("//")) throw new Error(`External URI is not allowed: ${value}`);
  return resolve(base, decoded);
}

for (const model of manifest.models) {
  try {
    const gltfPath = join(output, model.gltf);
    const gltf = JSON.parse(readFileSync(gltfPath, "utf8"));
    const binPath = localUri(dirname(gltfPath), gltf.buffers[0].uri);
    const bin = readFileSync(binPath);
    const errors = validateGltf(gltf, bin);
    if (errors.length) throw new Error(errors.slice(0, 10).join("; "));
    for (const image of gltf.images || []) {
      if (image.uri && !existsSync(localUri(dirname(gltfPath), image.uri))) throw new Error(`Missing image: ${image.uri}`);
      images++;
    }
    const originalPath = join(output, model.original);
    if (!existsSync(originalPath)) throw new Error(`Missing original MDX: ${model.original}`);
    if (readFileSync(originalPath).byteLength !== model.sourceBytes) throw new Error(`Original MDX size mismatch: ${model.original}`);
    if (gltf.extras?.openwar3?.sourcePath !== model.source) throw new Error("Source metadata mismatch");
    checked++;
    if (checked % 250 === 0) console.log(`Verified ${checked}/${manifest.models.length}`);
  } catch (error) {
    failures.push({ source: model.source, error: error.message });
  }
}

const result = {
  checked,
  images,
  manifestModels: manifest.models.length,
  manifestFailures: manifest.failures.length,
  extractionErrors: manifest.extractionErrors?.length || 0,
  textureErrors: manifest.textureErrors?.length || 0,
  verificationFailures: failures.length,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) {
  console.error(JSON.stringify(failures.slice(0, 30), null, 2));
  writeFileSync(join(output, "verification-errors.json"), JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else if (existsSync(join(output, "verification-errors.json"))) {
  writeFileSync(join(output, "verification-errors.json"), "[]\n");
}
if (checked !== manifest.models.length || manifest.failures.length) process.exitCode = 1;
