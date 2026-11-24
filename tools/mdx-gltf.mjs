import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MdlxModel = require("mdx-m3-viewer/dist/cjs/parsers/mdlx/model").default;
const { BlpImage } = require("mdx-m3-viewer/dist/cjs/parsers/blp/image.js");
const { mat4, quat, vec3 } = require("gl-matrix");

if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
}

const REPLACEABLE = {
  1: "ReplaceableTextures\\TeamColor\\TeamColor00.blp",
  2: "ReplaceableTextures\\TeamGlow\\TeamGlow00.blp",
  11: "ReplaceableTextures\\Cliff\\Cliff0.blp",
  31: "ReplaceableTextures\\LordaeronTree\\LordaeronSummerTree.blp",
  32: "ReplaceableTextures\\AshenvaleTree\\AshenTree.blp",
  33: "ReplaceableTextures\\BarrensTree\\BarrensTree.blp",
  34: "ReplaceableTextures\\NorthrendTree\\NorthTree.blp",
  35: "ReplaceableTextures\\Mushroom\\MushroomTree.blp",
  36: "ReplaceableTextures\\RuinsTree\\RuinsTree.blp",
  37: "ReplaceableTextures\\OutlandMushroomTree\\MushroomTree.blp",
};

const OBJECT_COLLECTIONS = [
  ["bones", "bone"],
  ["lights", "light"],
  ["helpers", "helper"],
  ["attachments", "attachment"],
  ["particleEmitters", "particleEmitter"],
  ["particleEmitters2", "particleEmitter2"],
  ["particleEmittersPopcorn", "particleEmitterPopcorn"],
  ["ribbonEmitters", "ribbonEmitter"],
  ["eventObjects", "eventObject"],
  ["collisionShapes", "collisionShape"],
];

const CHANNELS = { KGTR: "translation", KGRT: "rotation", KGSC: "scale" };
const DEFAULTS = { KGTR: [0, 0, 0], KGRT: [0, 0, 0, 1], KGSC: [1, 1, 1] };
const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export const normalizeAssetPath = (path) => path.replace(/\//g, "\\").replace(/^\\+/, "");
export const assetKey = (path) => normalizeAssetPath(path).toLowerCase();
export const portablePath = (path) => normalizeAssetPath(path).replace(/:/g, "\\").split("\\").filter(Boolean).join("/");

export function plain(value, omit = new Set()) {
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map((entry) => plain(entry, omit));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!key.startsWith("_") && !omit.has(key)) result[key] = plain(entry, omit);
    }
    return result;
  }
  return value;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), row + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function decodeBlp(bytes) {
  const image = new BlpImage();
  image.load(bytes.slice());
  const mip = image.getMipmap(0);
  return { width: mip.width, height: mip.height, data: new Uint8Array(mip.data) };
}

export function decodeTga(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = view.getUint8(0);
  const colorMapType = view.getUint8(1);
  const type = view.getUint8(2);
  const colorMapStart = view.getUint16(3, true);
  const colorMapLength = view.getUint16(5, true);
  const colorMapBits = view.getUint8(7);
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const bits = view.getUint8(16);
  const descriptor = view.getUint8(17);
  const baseType = type & 7;
  const rle = (type & 8) !== 0;
  if (!width || !height || ![1, 2, 3].includes(baseType) || ![8, 15, 16, 24, 32].includes(bits)) {
    throw new Error(`Unsupported TGA layout: type=${type}, bits=${bits}`);
  }
  if (baseType === 1 && (!colorMapType || ![24, 32].includes(colorMapBits))) throw new Error("Unsupported TGA palette");
  let offset = 18 + idLength;
  const palette = [];
  const paletteBytes = colorMapBits / 8;
  for (let i = 0; i < colorMapLength; i++) {
    const entry = readTgaPixel(bytes, offset, colorMapBits);
    offset += paletteBytes;
    palette[colorMapStart + i] = entry;
  }
  const pixelCount = width * height;
  const pixels = new Array(pixelCount);
  const pixelBytes = bits / 8;
  const readPixel = () => {
    const value = baseType === 1 ? bytes[offset] : readTgaPixel(bytes, offset, bits);
    offset += pixelBytes;
    return baseType === 1 ? palette[value] : value;
  };
  for (let i = 0; i < pixelCount;) {
    let count = 1;
    let repeated = false;
    if (rle) {
      const packet = bytes[offset++];
      count = (packet & 0x7f) + 1;
      repeated = (packet & 0x80) !== 0;
    }
    const first = readPixel();
    for (let j = 0; j < count && i < pixelCount; j++, i++) pixels[i] = repeated ? first : j === 0 ? first : readPixel();
  }
  const data = new Uint8Array(pixelCount * 4);
  const topOrigin = (descriptor & 0x20) !== 0;
  const rightOrigin = (descriptor & 0x10) !== 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = rightOrigin ? width - 1 - x : x;
      const sy = topOrigin ? y : height - 1 - y;
      const source = pixels[sy * width + sx];
      if (!source) throw new Error("Invalid TGA palette index");
      data.set(source, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function readTgaPixel(bytes, offset, bits) {
  if (bits === 8) return [bytes[offset], bytes[offset], bytes[offset], 255];
  if (bits === 15 || bits === 16) {
    const value = bytes[offset] | (bytes[offset + 1] << 8);
    return [
      Math.round(((value >> 10) & 31) * 255 / 31),
      Math.round(((value >> 5) & 31) * 255 / 31),
      Math.round((value & 31) * 255 / 31),
      bits === 16 ? ((value & 0x8000) ? 255 : 0) : 255,
    ];
  }
  return [bytes[offset + 2], bytes[offset + 1], bytes[offset], bits === 32 ? bytes[offset + 3] : 255];
}

export function decodeTexture(path, bytes) {
  const ext = path.toLowerCase().slice(path.lastIndexOf("."));
  if (ext === ".blp") return encodePng(...Object.values(decodeBlp(bytes)));
  if (ext === ".tga") return encodePng(...Object.values(decodeTga(bytes)));
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") return bytes;
  throw new Error(`Unsupported texture format: ${path}`);
}

class BinaryBuilder {
  constructor() {
    this.parts = [];
    this.length = 0;
    this.bufferViews = [];
    this.accessors = [];
  }

  align(alignment = 4) {
    const padding = (alignment - (this.length % alignment)) % alignment;
    if (padding) this.append(new Uint8Array(padding));
  }

  append(bytes) {
    this.parts.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.length += bytes.byteLength;
  }

  accessor(typed, type, componentType, target, minMax = false) {
    this.align(4);
    const byteOffset = this.length;
    this.append(typed);
    const bufferView = this.bufferViews.push({ buffer: 0, byteOffset, byteLength: typed.byteLength, ...(target ? { target } : {}) }) - 1;
    const count = typed.length / TYPE_SIZE[type];
    const accessor = { bufferView, componentType, count, type };
    if (minMax) {
      accessor.min = new Array(TYPE_SIZE[type]).fill(Infinity);
      accessor.max = new Array(TYPE_SIZE[type]).fill(-Infinity);
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < TYPE_SIZE[type]; c++) {
          const value = typed[i * TYPE_SIZE[type] + c];
          accessor.min[c] = Math.min(accessor.min[c], value);
          accessor.max[c] = Math.max(accessor.max[c], value);
        }
      }
    }
    return this.accessors.push(accessor) - 1;
  }

  finish() {
    this.align(4);
    return Buffer.concat(this.parts, this.length);
  }
}

function hermite(a, b, c, d, t) {
  const t2 = t * t;
  return a * (t2 * (2 * t - 3) + 1) + b * (t2 * (t - 2) + t) + c * (t2 * (t - 1)) + d * (t2 * (3 - 2 * t));
}

function bezier(a, b, c, d, t) {
  const u = 1 - t;
  return a * u * u * u + b * 3 * t * u * u + c * 3 * t * t * u + d * t * t * t;
}

function normalizeQuaternion(value) {
  const length = Math.hypot(...value);
  return length > 0 ? value.map((v) => v / length) : [0, 0, 0, 1];
}

function trackIndices(animation, sequence) {
  const start = sequence.interval[0];
  const end = sequence.interval[1];
  return animation.frames.map((value, index) => [value, index]).filter(([value]) => value >= start && value <= end).map(([, index]) => index);
}

function trackSegment(animation, sequence, frame, indices = trackIndices(animation, sequence)) {
  if (indices.length < 2) return null;
  const frames = animation.frames;
  let left = indices.length - 1;
  let right = 0;
  if (frame >= frames[indices[0]] && frame < frames[indices[indices.length - 1]]) {
    for (let i = 1; i < indices.length; i++) {
      if (frames[indices[i]] > frame) {
        left = i - 1;
        right = i;
        break;
      }
    }
  }
  const leftIndex = indices[left];
  const rightIndex = indices[right];
  let startFrame = frames[leftIndex];
  const endFrame = frames[rightIndex];
  let duration = endFrame - startFrame;
  if (duration < 0) {
    duration += sequence.interval[1] - sequence.interval[0];
    if (frame < startFrame) startFrame = endFrame;
  }
  return { leftIndex, rightIndex, t: duration === 0 ? 0 : (frame - startFrame) / duration };
}

function sampleTrack(animation, sequence, frame, indices = trackIndices(animation, sequence)) {
  if (!indices.length) return DEFAULTS[animation.name];
  if (indices.length === 1) return Array.from(animation.values[indices[0]]);
  const { leftIndex, rightIndex, t } = trackSegment(animation, sequence, frame, indices);
  const a = animation.values[leftIndex];
  const d = animation.values[rightIndex];
  const interpolation = animation.interpolationType;
  const value = a.map((_, component) => {
    if (interpolation === 0) return a[component];
    if (interpolation === 1) return a[component] + (d[component] - a[component]) * t;
    const b = animation.outTans[leftIndex][component];
    const c = animation.inTans[rightIndex][component];
    return interpolation === 2 ? hermite(a[component], b, c, d[component], t) : bezier(a[component], b, c, d[component], t);
  });
  return animation.name === "KGRT" ? normalizeQuaternion(value) : value;
}

function cubicTangents(animation, sequence, times, indices) {
  const width = DEFAULTS[animation.name].length;
  const values = new Float32Array(times.length * 3 * width);
  for (let i = 0; i < times.length; i++) values.set(sampleTrack(animation, sequence, times[i], indices), (i * 3 + 1) * width);
  for (let i = 0; i + 1 < times.length; i++) {
    const segment = trackSegment(animation, sequence, times[i], indices);
    if (!segment) continue;
    const { leftIndex, rightIndex } = segment;
    for (let component = 0; component < width; component++) {
      const leftValue = animation.values[leftIndex][component];
      const rightValue = animation.values[rightIndex][component];
      const out = animation.outTans[leftIndex]?.[component] ?? 0;
      const incoming = animation.inTans[rightIndex]?.[component] ?? 0;
      values[(i * 3 + 2) * width + component] = animation.interpolationType === 2 ? out : 3 * (out - leftValue);
      values[((i + 1) * 3) * width + component] = animation.interpolationType === 2 ? incoming : 3 * (incoming - rightValue);
    }
  }
  return values;
}

function animationTimes(animation, sequence) {
  const start = sequence.interval[0];
  const end = sequence.interval[1];
  const times = new Set([start, end]);
  for (const frame of animation.frames) if (frame >= start && frame <= end) times.add(frame);
  return [...times].sort((a, b) => a - b);
}

function objectMetadata(object, type) {
  const metadata = { objectType: type };
  for (const key of Object.keys(object)) {
    if (key === "animations") {
      metadata.animations = object.animations.filter((animation) => !CHANNELS[animation.name]).map((animation) => plain(animation));
    } else if (key !== "name" && key !== "objectId" && key !== "parentId") {
      metadata[key] = plain(object[key]);
    }
  }
  return metadata;
}

function computeRestMatrices(model, objects) {
  const matrices = objects.map(() => mat4.create());
  const visiting = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`Cycle in MDX hierarchy at object ${id}`);
    const object = objects[id];
    if (!object) return mat4.create();
    const pivot = model.pivotPoints[object.parentId] || [0, 0, 0];
    const local = mat4.fromTranslation(mat4.create(), pivot);
    if (object.parentId >= 0 && objects[object.parentId]) {
      visiting.add(id);
      const parent = visit(object.parentId);
      visiting.delete(id);
      return mat4.multiply(mat4.create(), parent, local);
    }
    return local;
  };
  for (let i = 0; i < objects.length; i++) matrices[i] = visit(i);
  return matrices;
}

function texturePath(texture) {
  return texture.path || REPLACEABLE[texture.replaceableId] || "";
}

export function convertModel(bytes, context) {
  const model = new MdlxModel();
  model.load(bytes.slice());
  const binary = new BinaryBuilder();
  const gltf = {
    asset: { version: "2.0", generator: "OpenWar3 MDX to glTF" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: `${model.name || "MDX"}_Zup_to_Yup`, rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: [] }],
    meshes: [],
    materials: [],
    textures: [],
    images: [],
    samplers: [],
    skins: [],
    animations: [],
    bufferViews: binary.bufferViews,
    accessors: binary.accessors,
    buffers: [],
    extensionsUsed: [],
  };
  const objects = [];
  const objectTypes = [];
  for (const [collection, type] of OBJECT_COLLECTIONS) {
    for (const object of model[collection]) {
      objects[object.objectId] = object;
      objectTypes[object.objectId] = type;
    }
  }
  const objectCount = objects.reduce((max, object, id) => object ? Math.max(max, id + 1) : max, 0);
  objects.length = objectCount;
  const nodeForObject = new Map();
  for (let id = 0; id < objects.length; id++) {
    const object = objects[id];
    if (!object) continue;
    const parentPivot = model.pivotPoints[object.parentId] || [0, 0, 0];
    const node = {
      name: object.name || `${objectTypes[id]}_${id}`,
      translation: Array.from(parentPivot),
      extras: { openwar3: { objectId: id, parentId: object.parentId, pivot: plain(model.pivotPoints[id] || [0, 0, 0]), ...objectMetadata(object, objectTypes[id]) } },
    };
    const index = gltf.nodes.push(node) - 1;
    nodeForObject.set(id, index);
  }
  for (let id = 0; id < objects.length; id++) {
    const object = objects[id];
    if (!object) continue;
    const index = nodeForObject.get(id);
    const parent = nodeForObject.get(object.parentId);
    if (parent !== undefined && parent !== index) gltf.nodes[parent].children ??= [];
    if (parent !== undefined && parent !== index) gltf.nodes[parent].children.push(index);
    else gltf.nodes[0].children.push(index);
  }

  let skin = -1;
  if (nodeForObject.size) {
    const restMatrices = computeRestMatrices(model, objects);
    const inverse = new Float32Array(nodeForObject.size * 16);
    let joint = 0;
    const joints = [];
    for (let id = 0; id < objects.length; id++) {
      if (!nodeForObject.has(id)) continue;
      joints.push(nodeForObject.get(id));
      const matrix = mat4.invert(mat4.create(), restMatrices[id]);
      inverse.set(matrix, joint * 16);
      joint++;
    }
    const jointForObject = new Map([...nodeForObject].map(([id, node], index) => [id, index]));
    skin = gltf.skins.push({
      joints,
      inverseBindMatrices: binary.accessor(inverse, "MAT4", 5126),
      extras: { openwar3: { jointObjectIds: [...jointForObject.keys()] } },
    }) - 1;
    gltf.skins[skin].extras.openwar3.jointForObject = Object.fromEntries(jointForObject);
  }

  const textureIndices = new Map();
  const unresolvedTextures = [];
  const materialIndices = new Map();
  const warnings = [];
  const imageForTexture = (textureId) => {
    if (textureIndices.has(textureId)) return textureIndices.get(textureId);
    const texture = model.textures[textureId];
    const path = texture ? texturePath(texture) : "";
    let gltfTexture = -1;
    if (path) {
      const resolved = context.resolveTexture(path, context.sourcePath);
      if (resolved) {
        const sampler = gltf.samplers.push({
          magFilter: 9729,
          minFilter: 9987,
          wrapS: texture.wrapMode & 1 ? 10497 : 33071,
          wrapT: texture.wrapMode & 2 ? 10497 : 33071,
        }) - 1;
        const image = gltf.images.push({ uri: resolved.uri, name: path, extras: { openwar3: { sourcePath: path, replaceableId: texture.replaceableId } } }) - 1;
        gltfTexture = gltf.textures.push({ source: image, sampler }) - 1;
      } else {
        unresolvedTextures.push(path);
      }
    }
    textureIndices.set(textureId, gltfTexture);
    return gltfTexture;
  };

  const materialFor = (materialId, layerId) => {
    const key = `${materialId}:${layerId}`;
    if (materialIndices.has(key)) return materialIndices.get(key);
    const source = model.materials[materialId];
    const layer = source?.layers[layerId];
    if (!source || !layer) return -1;
    const texture = imageForTexture(layer.textureId);
    const transparent = layer.filterMode === 1;
    const blended = layer.filterMode >= 2;
    const material = {
      name: `${model.name || "material"}_${materialId}_${layerId}`,
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, layer.alpha],
        metallicFactor: 0,
        roughnessFactor: 1,
        ...(texture >= 0 ? { baseColorTexture: { index: texture, texCoord: layer.coordId } } : {}),
      },
      alphaMode: transparent ? "MASK" : blended ? "BLEND" : "OPAQUE",
      ...(transparent ? { alphaCutoff: 0.5 } : {}),
      doubleSided: Boolean((source.flags & 2) || (layer.flags & 16)),
      extras: { openwar3: { materialId, layerId, material: plain(source, new Set(["layers"])), layer: plain(layer) } },
    };
    if (layer.flags & 1 || layer.flags & 256) {
      material.extensions = { KHR_materials_unlit: {} };
      if (!gltf.extensionsUsed.includes("KHR_materials_unlit")) gltf.extensionsUsed.push("KHR_materials_unlit");
    }
    const index = gltf.materials.push(material) - 1;
    materialIndices.set(key, index);
    return index;
  };

  for (let geosetId = 0; geosetId < model.geosets.length; geosetId++) {
    const geoset = model.geosets[geosetId];
    if (geoset.lod !== -1 && geoset.lod !== 0) continue;
    const vertexCount = geoset.vertices.length / 3;
    if (!vertexCount || !geoset.faces.length) continue;
    const position = binary.accessor(geoset.vertices, "VEC3", 5126, 34962, true);
    const normal = geoset.normals.length === geoset.vertices.length ? binary.accessor(geoset.normals, "VEC3", 5126, 34962) : -1;
    const uv = geoset.uvSets.map((set) => binary.accessor(set, "VEC2", 5126, 34962));
    const indicesArray = vertexCount > 65535 ? new Uint32Array(geoset.faces) : geoset.faces;
    const indices = binary.accessor(indicesArray, "SCALAR", vertexCount > 65535 ? 5125 : 5123, 34963);
    const attributes = { POSITION: position, ...(normal >= 0 ? { NORMAL: normal } : {}), ...Object.fromEntries(uv.map((accessor, i) => [`TEXCOORD_${i}`, accessor])) };
    let joints;
    let weights;
    const extended = [];
    if (skin >= 0) {
      const jointForObject = gltf.skins[skin].extras.openwar3.jointForObject;
      joints = new Uint16Array(vertexCount * 4);
      weights = new Float32Array(vertexCount * 4);
      if (geoset.skin.length >= vertexCount * 8) {
        for (let i = 0; i < vertexCount; i++) {
          let total = 0;
          for (let j = 0; j < 4; j++) total += geoset.skin[i * 8 + 4 + j];
          for (let j = 0; j < 4; j++) {
            joints[i * 4 + j] = jointForObject[geoset.skin[i * 8 + j]] ?? 0;
            weights[i * 4 + j] = total ? geoset.skin[i * 8 + 4 + j] / total : j === 0 ? 1 : 0;
          }
        }
      } else {
        const groups = [];
        let offset = 0;
        for (const size of geoset.matrixGroups) {
          groups.push(Array.from(geoset.matrixIndices.subarray(offset, offset + size)));
          offset += size;
        }
        for (let i = 0; i < vertexCount; i++) {
          const group = groups[geoset.vertexGroups[i]] || [];
          if (group.length > 4) {
            extended.push({ vertex: i, objectIds: group });
            warnings.push(`Geoset ${geosetId}: ${group.length} influences reduced to 4 in standard glTF`);
          }
          const count = Math.min(group.length, 4);
          for (let j = 0; j < count; j++) {
            joints[i * 4 + j] = jointForObject[group[j]] ?? 0;
            weights[i * 4 + j] = 1 / count;
          }
          if (!count) weights[i * 4] = 1;
        }
      }
      attributes.JOINTS_0 = binary.accessor(joints, "VEC4", 5123, 34962);
      attributes.WEIGHTS_0 = binary.accessor(weights, "VEC4", 5126, 34962);
    }
    const primitives = [];
    const sourceMaterial = model.materials[geoset.materialId];
    for (let layerId = 0; layerId < (sourceMaterial?.layers.length || 1); layerId++) {
      const material = materialFor(geoset.materialId, layerId);
      primitives.push({
        attributes,
        indices,
        mode: 4,
        ...(material >= 0 ? { material } : {}),
        extras: { openwar3: { layerId, filterMode: sourceMaterial?.layers[layerId]?.filterMode ?? 0 } },
      });
    }
    const mesh = gltf.meshes.push({
      name: `${model.name || "geoset"}_${geosetId}`,
      primitives,
      extras: { openwar3: { geosetId, materialId: geoset.materialId, selectionGroup: geoset.selectionGroup, selectionFlags: geoset.selectionFlags, extent: plain(geoset.extent), extendedInfluences: extended } },
    }) - 1;
    const node = { name: mesh.name ?? `geoset_${geosetId}`, mesh, ...(skin >= 0 ? { skin } : {}) };
    const nodeIndex = gltf.nodes.push(node) - 1;
    gltf.nodes[0].children.push(nodeIndex);
  }

  const sequences = [
    ...model.sequences.map((sequence, index) => ({ sequence, index, globalSequenceId: -1 })),
    ...model.globalSequences.map((duration, index) => ({ sequence: { name: `Global_${index}`, interval: new Uint32Array([0, duration]), nonLooping: 0 }, index, globalSequenceId: index })),
  ];
  for (const entry of sequences) {
    const animation = { name: entry.sequence.name || `Sequence_${entry.index}`, samplers: [], channels: [], extras: { openwar3: { ...plain(entry.sequence), globalSequenceId: entry.globalSequenceId } } };
    for (let id = 0; id < objects.length; id++) {
      const object = objects[id];
      if (!object || !nodeForObject.has(id)) continue;
      for (const source of object.animations) {
        const path = CHANNELS[source.name];
        if (!path) continue;
        if (entry.globalSequenceId === -1 && source.globalSequenceId !== -1) continue;
        if (entry.globalSequenceId !== -1 && source.globalSequenceId !== entry.globalSequenceId) continue;
        const times = animationTimes(source, entry.sequence);
        const indices = trackIndices(source, entry.sequence);
        const cubic = source.interpolationType > 1;
        const width = DEFAULTS[source.name].length;
        const input = new Float32Array(times.length);
        const output = cubic ? cubicTangents(source, entry.sequence, times, indices) : new Float32Array(times.length * width);
        for (let i = 0; i < times.length; i++) {
          input[i] = (times[i] - entry.sequence.interval[0]) / 1000;
          if (!cubic) output.set(sampleTrack(source, entry.sequence, times[i], indices), i * width);
          if (source.name === "KGTR") {
            const pivot = model.pivotPoints[object.parentId] || [0, 0, 0];
            const at = (cubic ? i * 3 + 1 : i) * width;
            output[at] += pivot[0];
            output[at + 1] += pivot[1];
            output[at + 2] += pivot[2];
          }
        }
        const inputAccessor = binary.accessor(input, "SCALAR", 5126, undefined, true);
        const outputAccessor = binary.accessor(output, path === "rotation" ? "VEC4" : "VEC3", 5126);
        const interpolation = cubic ? "CUBICSPLINE" : source.interpolationType === 0 ? "STEP" : "LINEAR";
        const sampler = animation.samplers.push({ input: inputAccessor, output: outputAccessor, interpolation }) - 1;
        animation.channels.push({
          sampler,
          target: { node: nodeForObject.get(id), path },
          extras: { openwar3: { sourceTrack: source.name, interpolationType: source.interpolationType, sourceKeyCount: source.frames.length, nativeKeys: true } },
        });
      }
    }
    if (animation.channels.length) gltf.animations.push(animation);
  }

  gltf.buffers.push({ byteLength: 0, uri: `${context.baseName}.bin` });
  gltf.extras = {
    openwar3: {
      format: "openwar3-mdx-v1",
      sourcePath: context.sourcePath,
      sourceArchive: context.sourceArchive,
      sourceOriginal: context.originalUri,
      mdxVersion: model.version,
      coordinateConversion: "Root rotates Warcraft Z-up to glTF Y-up; geometry and animation remain in MDX coordinates",
      standardGltfLimitations: ["Warcraft material filter modes", "billboards and inheritance flags", "emitters and event objects", "team-color replacement", "geoset visibility and color", "texture animations", "global sequences require simultaneous playback"],
      sequences: plain(model.sequences),
      globalSequences: plain(model.globalSequences),
      materials: plain(model.materials),
      textures: plain(model.textures),
      textureAnimations: plain(model.textureAnimations),
      geosetAnimations: plain(model.geosetAnimations),
      pivotPoints: plain(model.pivotPoints),
      cameras: plain(model.cameras),
      faceEffects: plain(model.faceEffects),
      unknownChunks: plain(model.unknownChunks),
      unresolvedTextures,
      warnings,
    },
  };
  const bin = binary.finish();
  gltf.buffers[0].byteLength = bin.byteLength;
  return { gltf, bin, model, warnings, unresolvedTextures };
}

export function validateGltf(gltf, bin) {
  const errors = [];
  if (gltf.asset?.version !== "2.0") errors.push("asset.version is not 2.0");
  if (gltf.buffers?.[0]?.byteLength !== bin.length) errors.push(`Buffer length ${bin.length} != ${gltf.buffers?.[0]?.byteLength}`);
  for (const [index, view] of (gltf.bufferViews || []).entries()) {
    if ((view.byteOffset || 0) + view.byteLength > bin.length) errors.push(`bufferView ${index} exceeds buffer`);
  }
  const readAccessor = (index) => {
    const accessor = gltf.accessors[index];
    if (!accessor) {
      errors.push(`Missing accessor ${index}`);
      return null;
    }
    const view = gltf.bufferViews[accessor.bufferView];
    if (!view) {
      errors.push(`Accessor ${index} has no bufferView`);
      return null;
    }
    const width = TYPE_SIZE[accessor.type];
    const component = COMPONENT_SIZE[accessor.componentType];
    if (!width || !component) {
      errors.push(`Accessor ${index} has invalid type`);
      return null;
    }
    const byteOffset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
    const stride = view.byteStride || width * component;
    if (byteOffset + (accessor.count - 1) * stride + width * component > (view.byteOffset || 0) + view.byteLength) errors.push(`Accessor ${index} exceeds bufferView`);
    return { accessor, view, width, component, byteOffset, stride };
  };
  const numberAt = (info, index, componentIndex) => {
    const at = info.byteOffset + index * info.stride + componentIndex * info.component;
    switch (info.accessor.componentType) {
      case 5121: return bin.readUInt8(at);
      case 5123: return bin.readUInt16LE(at);
      case 5125: return bin.readUInt32LE(at);
      case 5126: return bin.readFloatLE(at);
      default: throw new Error(`Unsupported validation component ${info.accessor.componentType}`);
    }
  };
  for (const [meshIndex, mesh] of (gltf.meshes || []).entries()) {
    for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
      const position = readAccessor(primitive.attributes.POSITION);
      if (!position) continue;
      const indexInfo = readAccessor(primitive.indices);
      if (indexInfo) {
        for (let i = 0; i < indexInfo.accessor.count; i++) {
          if (numberAt(indexInfo, i, 0) >= position.accessor.count) {
            errors.push(`Mesh ${meshIndex}/${primitiveIndex}: index outside POSITION`);
            break;
          }
        }
      }
      const joints = primitive.attributes.JOINTS_0;
      const weights = primitive.attributes.WEIGHTS_0;
      if (joints !== undefined) {
        const jointInfo = readAccessor(joints);
        const weightInfo = readAccessor(weights);
        const node = gltf.nodes.find((candidate) => candidate.mesh === meshIndex);
        const jointCount = node?.skin === undefined ? 0 : gltf.skins[node.skin].joints.length;
        if (jointInfo && weightInfo) {
          for (let i = 0; i < position.accessor.count; i++) {
            let sum = 0;
            for (let j = 0; j < 4; j++) {
              if (numberAt(jointInfo, i, j) >= jointCount) errors.push(`Mesh ${meshIndex}: invalid joint`);
              sum += numberAt(weightInfo, i, j);
            }
            if (Math.abs(sum - 1) > 0.0001) {
              errors.push(`Mesh ${meshIndex}: weights sum to ${sum}`);
              break;
            }
          }
        }
      }
    }
  }
  for (const [animationIndex, animation] of (gltf.animations || []).entries()) {
    for (const [samplerIndex, sampler] of animation.samplers.entries()) {
      const input = readAccessor(sampler.input);
      const output = readAccessor(sampler.output);
      const path = animation.channels.find((channel) => channel.sampler === samplerIndex)?.target.path;
      const components = path === "rotation" ? 4 : path === "weights" ? 1 : 3;
      const keyMultiplier = sampler.interpolation === "CUBICSPLINE" ? 3 : 1;
      if (input && output && output.accessor.count !== input.accessor.count * keyMultiplier) errors.push(`Animation ${animationIndex}/${samplerIndex}: key count mismatch`);
      if (output && output.width !== components && path !== "weights") errors.push(`Animation ${animationIndex}/${samplerIndex}: output width mismatch`);
      if (input) {
        for (let i = 1; i < input.accessor.count; i++) {
          if (numberAt(input, i, 0) < numberAt(input, i - 1, 0)) {
            errors.push(`Animation ${animationIndex}/${samplerIndex}: non-monotonic input`);
            break;
          }
        }
      }
    }
  }
  return errors;
}
