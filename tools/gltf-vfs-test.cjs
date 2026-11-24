const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const { convertGltf, GltfDataSource } = require(path.join(ROOT, ".sim-build", "src", "vfs", "gltf.js"));
const MdlxModel = require("mdx-m3-viewer/dist/cjs/parsers/mdlx/model").default;

function parseMdx(bytes) {
  const model = new MdlxModel();
  model.load(bytes);
  return model;
}

function glb(doc, bin) {
  const json = Buffer.from(JSON.stringify(doc));
  const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const binPadded = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
  const out = Buffer.alloc(12 + 8 + jsonPadded.length + 8 + binPadded.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonPadded.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonPadded.copy(out, 20);
  const binAt = 20 + jsonPadded.length;
  out.writeUInt32LE(binPadded.length, binAt);
  out.writeUInt32LE(0x004e4942, binAt + 4);
  binPadded.copy(out, binAt + 8);
  return out;
}

function memorySource(files) {
  const normalized = new Map();
  for (const [name, bytes] of Object.entries(files)) normalized.set(name.replace(/\//g, "\\").toLowerCase(), bytes);
  return {
    label: "memory",
    exists(name) { return normalized.has(name.replace(/\//g, "\\").toLowerCase()); },
    async read(name) { const bytes = this.rawBytes(name); if (!bytes) throw new Error(name); return bytes; },
    rawBytes(name) { return normalized.get(name.replace(/\//g, "\\").toLowerCase()) || null; },
    list() { return [...normalized.keys()]; },
  };
}

function genericTriangle() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(uv.buffer), Buffer.from(indices.buffer)]);
  const doc = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: {} }],
    buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${bin.toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: 36, byteLength: normals.byteLength },
      { buffer: 0, byteOffset: 72, byteLength: uv.byteLength },
      { buffer: 0, byteOffset: 96, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
    ],
  };
  return new TextEncoder().encode(JSON.stringify(doc));
}

const generic = convertGltf(genericTriangle(), "triangle.gltf", () => null);
const genericModel = parseMdx(generic.bytes);
assert.equal(genericModel.geosets.length, 1);
assert.equal(genericModel.geosets[0].faces.length, 3);
assert.equal(genericModel.helpers.length, 1);
assert.equal(genericModel.sequences.length, 1);
assert.equal(genericModel.sequences[0].name, "Stand");
console.log("ok generic glTF triangle and data URI");

const exportRoot = path.join(ROOT, "media");
const relative = path.join("gltf", "Units", "Human", "Footman", "Footman.gltf");
if (!fs.existsSync(path.join(exportRoot, relative))) {
  console.log("ok skipped exported Footman integration (media is absent)");
} else {
  const sourcePath = relative.replace(/\//g, "\\");
  const source = fs.readFileSync(path.join(exportRoot, relative));
  const doc = JSON.parse(source.toString("utf8"));
  const reader = (dependency) => {
    const file = path.resolve(exportRoot, dependency.replace(/\//g, "\\").split("\\").join(path.sep));
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  };
  const original = convertGltf(source, sourcePath, reader);
  assert.equal(parseMdx(original.bytes).name, "Footman");
  console.log("ok sourceOriginal fallback");

  const standaloneReader = (dependency) => dependency.toLowerCase().includes("files\\") ? null : reader(dependency);
  const standalone = convertGltf(source, sourcePath, standaloneReader);
  const model = parseMdx(standalone.bytes);
  assert.equal(model.name, "Footman");
  assert.equal(model.geosets.length, 5);
  assert.equal(model.sequences.length, 13);
  assert.equal(model.bones.length, 25);
  assert.equal(model.materials.length, 3);
  assert.ok(model.textures.some((texture) => /\.png$/i.test(texture.path)));
  assert.ok(model.bones.some((bone) => bone.animations.length > 0));
  console.log("ok standalone exported glTF: geometry, skeleton, materials and animations");

  const bin = reader("gltf\\Units\\Human\\Footman\\Footman.bin");
  delete doc.extras.openwar3.sourceOriginal;
  delete doc.buffers[0].uri;
  const packed = glb(doc, bin);
  const packedModel = parseMdx(convertGltf(packed, "Footman.glb", standaloneReader).bytes);
  assert.equal(packedModel.geosets.length, 5);
  assert.equal(packedModel.sequences.length, 13);
  console.log("ok GLB with binary chunk");

  const images = doc.images.map((image) => reader(path.posix.join("gltf/Units/Human/Footman", decodeURIComponent(image.uri)).replace(/\//g, "\\")));
  const chunks = [bin];
  let imageOffset = bin.length;
  doc.images.forEach((image, index) => {
    const bytes = images[index];
    const padding = (4 - imageOffset % 4) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      imageOffset += padding;
    }
    doc.bufferViews.push({ buffer: 0, byteOffset: imageOffset, byteLength: bytes.length });
    image.bufferView = doc.bufferViews.length - 1;
    image.mimeType = "image/png";
    delete image.uri;
    chunks.push(bytes);
    imageOffset += bytes.length;
  });
  const embeddedBin = Buffer.concat(chunks);
  doc.buffers[0].byteLength = embeddedBin.length;
  const embedded = convertGltf(glb(doc, embeddedBin), "Footman.glb", () => null);
  assert.ok(embedded.files.size >= 2);
  assert.equal(parseMdx(embedded.bytes).geosets.length, 5);
  console.log("ok self-contained GLB with embedded PNG textures");

  const vfs = new GltfDataSource(memorySource({ "broken.gltf": new TextEncoder().encode("{"), "broken.mdx": original.bytes }));
  assert.equal(parseMdx(vfs.rawBytes("broken.gltf")).name, "Footman");
  console.log("ok corrupt glTF falls back to same-name MDX");
}

if (process.argv.includes("--all")) {
  const manifest = JSON.parse(fs.readFileSync(path.join(exportRoot, "manifest.json"), "utf8"));
  const failures = [];
  let checked = 0;
  for (const entry of manifest.models) {
    const sourcePath = entry.gltf.replace(/\//g, "\\");
    try {
      const source = fs.readFileSync(path.join(exportRoot, entry.gltf));
      const result = convertGltf(source, sourcePath, (dependency) => {
        if (dependency.toLowerCase().includes("files\\")) return null;
        const file = path.resolve(exportRoot, dependency.replace(/\//g, "\\").split("\\").join(path.sep));
        return fs.existsSync(file) ? fs.readFileSync(file) : null;
      });
      parseMdx(result.bytes);
      checked++;
      if (checked % 250 === 0) console.log(`standalone round-trip ${checked}/${manifest.models.length}`);
    } catch (error) {
      failures.push({ source: entry.gltf, error: error.message });
    }
  }
  console.log(JSON.stringify({ checked, failures: failures.length }, null, 2));
  if (failures.length) {
    console.log(JSON.stringify(failures.slice(0, 40), null, 2));
    process.exitCode = 1;
  }
}
