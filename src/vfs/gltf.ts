import MdlxModel from "mdx-m3-viewer/dist/cjs/parsers/mdlx/model";
import Extent from "mdx-m3-viewer/dist/cjs/parsers/mdlx/extent";
import Sequence from "mdx-m3-viewer/dist/cjs/parsers/mdlx/sequence";
import Material from "mdx-m3-viewer/dist/cjs/parsers/mdlx/material";
import Layer from "mdx-m3-viewer/dist/cjs/parsers/mdlx/layer";
import Texture from "mdx-m3-viewer/dist/cjs/parsers/mdlx/texture";
import TextureAnimation from "mdx-m3-viewer/dist/cjs/parsers/mdlx/textureanimation";
import Geoset from "mdx-m3-viewer/dist/cjs/parsers/mdlx/geoset";
import GeosetAnimation from "mdx-m3-viewer/dist/cjs/parsers/mdlx/geosetanimation";
import Bone from "mdx-m3-viewer/dist/cjs/parsers/mdlx/bone";
import Light from "mdx-m3-viewer/dist/cjs/parsers/mdlx/light";
import Helper from "mdx-m3-viewer/dist/cjs/parsers/mdlx/helper";
import Attachment from "mdx-m3-viewer/dist/cjs/parsers/mdlx/attachment";
import ParticleEmitter from "mdx-m3-viewer/dist/cjs/parsers/mdlx/particleemitter";
import ParticleEmitter2 from "mdx-m3-viewer/dist/cjs/parsers/mdlx/particleemitter2";
import ParticleEmitterPopcorn from "mdx-m3-viewer/dist/cjs/parsers/mdlx/particleemitterpopcorn";
import RibbonEmitter from "mdx-m3-viewer/dist/cjs/parsers/mdlx/ribbonemitter";
import Camera from "mdx-m3-viewer/dist/cjs/parsers/mdlx/camera";
import EventObject from "mdx-m3-viewer/dist/cjs/parsers/mdlx/eventobject";
import CollisionShape from "mdx-m3-viewer/dist/cjs/parsers/mdlx/collisionshape";
import FaceEffect from "mdx-m3-viewer/dist/cjs/parsers/mdlx/faceeffect";
import { Animation, FloatAnimation, UintAnimation, Vector3Animation, Vector4Animation } from "mdx-m3-viewer/dist/cjs/parsers/mdlx/animations";
import { mat4, quat, vec3 } from "gl-matrix";
import { normalizeMpqPath, type DataSource } from "./types";

type Gltf = Record<string, any>;
type Reader = (path: string) => Uint8Array | null;
type AnimationInstance = Animation;
type GenericObject = Bone | Light | Helper | Attachment | ParticleEmitter | ParticleEmitter2 | ParticleEmitterPopcorn | RibbonEmitter | EventObject | CollisionShape;

const MODEL_EXTENSIONS = /\.(gltf|glb)$/i;
const CHANNELS: Record<string, string> = { translation: "KGTR", rotation: "KGRT", scale: "KGSC" };
const OBJECTS: Record<string, { collection: string; Ctor: new () => GenericObject }> = {
  bone: { collection: "bones", Ctor: Bone },
  light: { collection: "lights", Ctor: Light },
  helper: { collection: "helpers", Ctor: Helper },
  attachment: { collection: "attachments", Ctor: Attachment },
  particleEmitter: { collection: "particleEmitters", Ctor: ParticleEmitter },
  particleEmitter2: { collection: "particleEmitters2", Ctor: ParticleEmitter2 },
  particleEmitterPopcorn: { collection: "particleEmittersPopcorn", Ctor: ParticleEmitterPopcorn },
  ribbonEmitter: { collection: "ribbonEmitters", Ctor: RibbonEmitter },
  eventObject: { collection: "eventObjects", Ctor: EventObject },
  collisionShape: { collection: "collisionShapes", Ctor: CollisionShape },
};

function isGltfPath(path: string): boolean {
  return MODEL_EXTENSIONS.test(path);
}

function resolvePath(sourcePath: string, uri: string): string {
  const decoded = decodeURIComponent(uri).replace(/\//g, "\\");
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) && !/^[a-z]:/i.test(decoded)) return decoded;
  const parts = decoded.startsWith("\\") ? [] : normalizeMpqPath(sourcePath).split("\\").slice(0, -1);
  for (const part of decoded.split("\\")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("\\");
}

function dataUri(uri: string): Uint8Array | null {
  const match = /^data:[^,]*,(.*)$/s.exec(uri);
  if (!match) return null;
  const base64 = /^data:[^,]*;base64,/i.test(uri);
  if (base64) {
    if (typeof atob !== "function") throw new Error("Base64 data URIs require atob()");
    const text = atob(match[1]);
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
  }
  return new TextEncoder().encode(decodeURIComponent(match[1]));
}

function parse(source: Uint8Array, sourcePath: string, read: Reader): { doc: Gltf; buffers: Uint8Array[] } {
  let doc: Gltf;
  let glbBuffer: Uint8Array | null = null;
  if (source.length >= 12 && new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(0, true) === 0x46546c67) {
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    if (view.getUint32(4, true) !== 2 || view.getUint32(8, true) > source.length) throw new Error(`${sourcePath}: unsupported GLB header`);
    let offset = 12;
    let json: Uint8Array | null = null;
    while (offset + 8 <= source.length) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const bytes = source.subarray(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a) json = bytes;
      else if (type === 0x004e4942) glbBuffer = bytes;
      offset += 8 + length + ((4 - (length % 4)) % 4);
    }
    if (!json) throw new Error(`${sourcePath}: GLB has no JSON chunk`);
    doc = JSON.parse(new TextDecoder().decode(json));
  } else {
    doc = JSON.parse(new TextDecoder().decode(source));
  }
  if (doc.asset?.version !== "2.0") throw new Error(`${sourcePath}: only glTF 2.0 is supported`);
  const buffers = (doc.buffers || []).map((buffer: Gltf, index: number) => {
    if (buffer.uri === undefined) {
      if (index === 0 && glbBuffer) return glbBuffer;
      throw new Error(`${sourcePath}: buffer ${index} has no GLB data`);
    }
    const embedded = dataUri(buffer.uri);
    const bytes = embedded || read(resolvePath(sourcePath, buffer.uri));
    if (!bytes) throw new Error(`${sourcePath}: cannot read buffer ${buffer.uri}`);
    if (buffer.byteLength > bytes.byteLength) throw new Error(`${sourcePath}: truncated buffer ${buffer.uri}`);
    return bytes;
  });
  return { doc, buffers };
}

const COMPONENTS: Record<number, { bytes: number; read: (view: DataView, offset: number) => number }> = {
  5120: { bytes: 1, read: (v, o) => v.getInt8(o) },
  5121: { bytes: 1, read: (v, o) => v.getUint8(o) },
  5122: { bytes: 2, read: (v, o) => v.getInt16(o, true) },
  5123: { bytes: 2, read: (v, o) => v.getUint16(o, true) },
  5125: { bytes: 4, read: (v, o) => v.getUint32(o, true) },
  5126: { bytes: 4, read: (v, o) => v.getFloat32(o, true) },
};
const WIDTHS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function accessor(doc: Gltf, buffers: Uint8Array[], index: number, integer = false): Float32Array | Uint32Array {
  const source = doc.accessors[index];
  if (!source || source.sparse) throw new Error(`Unsupported or missing accessor ${index}`);
  const view = doc.bufferViews[source.bufferView];
  const buffer = buffers[view.buffer];
  const component = COMPONENTS[source.componentType];
  const width = WIDTHS[source.type];
  if (!view || !buffer || !component || !width) throw new Error(`Invalid accessor ${index}`);
  const stride = view.byteStride || component.bytes * width;
  const start = (view.byteOffset || 0) + (source.byteOffset || 0);
  const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const out = integer ? new Uint32Array(source.count * width) : new Float32Array(source.count * width);
  for (let i = 0; i < source.count; i++) {
    for (let c = 0; c < width; c++) {
      let value = component.read(data, start + i * stride + c * component.bytes);
      if (source.normalized && !integer) {
        const max = source.componentType === 5121 ? 255 : source.componentType === 5123 ? 65535 : source.componentType === 5120 ? 127 : source.componentType === 5122 ? 32767 : 1;
        value = Math.max(value / max, -1);
      }
      out[i * width + c] = value;
    }
  }
  return out;
}

function extent(raw: Gltf | undefined, positions?: Float32Array): Extent {
  const out = new Extent();
  if (raw) {
    out.min.set(raw.min || [0, 0, 0]);
    out.max.set(raw.max || [0, 0, 0]);
    out.boundsRadius = raw.boundsRadius || 0;
    return out;
  }
  if (positions?.length) {
    out.min.set([Infinity, Infinity, Infinity]);
    out.max.set([-Infinity, -Infinity, -Infinity]);
    for (let i = 0; i < positions.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        out.min[c] = Math.min(out.min[c], positions[i + c]);
        out.max[c] = Math.max(out.max[c], positions[i + c]);
      }
    }
    out.boundsRadius = Math.max(0, ...Array.from(out.min, (value, i) => Math.hypot(value, out.min[(i + 1) % 3], out.max[(i + 2) % 3])));
  }
  return out;
}

function animation(raw: Gltf): AnimationInstance {
  const name = raw.name as string;
  const scalar = new Set(["KMTA", "KMTE", "KFCA", "KGAO", "KLAS", "KLAE", "KLAI", "KLBI", "KLAV", "KATV", "KPEE", "KPEG", "KPLN", "KPLT", "KPEL", "KPES", "KPEV", "KP2S", "KP2R", "KP2L", "KP2G", "KP2E", "KP2N", "KP2W", "KP2V", "KPPA", "KPPE", "KPPL", "KPPS", "KPPV", "KRHA", "KRHB", "KRAL", "KRVS", "KCRL"]);
  const vector4 = new Set(["KGRT", "KTAR"]);
  const uint = new Set(["KMTF", "KFTC", "KRTX"]);
  const out = uint.has(name) ? new UintAnimation() : scalar.has(name) ? new FloatAnimation() : vector4.has(name) ? new Vector4Animation() : new Vector3Animation();
  Object.assign(out, raw);
  out.frames = raw.frames || [];
  out.values = (raw.values || []).map((value: number[]) => uint.has(name) ? new Uint32Array(value) : new Float32Array(value));
  out.inTans = (raw.inTans || []).map((value: number[]) => new Float32Array(value));
  out.outTans = (raw.outTans || []).map((value: number[]) => new Float32Array(value));
  return out;
}

function animated<T extends { animations: AnimationInstance[] }>(target: T, raw: Gltf): T {
  Object.assign(target, raw);
  target.animations = (raw.animations || []).map(animation);
  const floats = ["color", "ambientColor", "attenuation", "position", "targetPosition", "fresnelColor", "segmentScaling"];
  for (const key of floats) if (raw[key]) (target as Gltf)[key] = new Float32Array(raw[key]);
  if (raw.vertices) (target as Gltf).vertices = raw.vertices.map((value: number[]) => new Float32Array(value));
  if (raw.segmentColors) (target as Gltf).segmentColors = raw.segmentColors.map((value: number[]) => new Float32Array(value));
  if (raw.segmentAlphas) (target as Gltf).segmentAlphas = new Uint8Array(raw.segmentAlphas);
  if (raw.headIntervals) (target as Gltf).headIntervals = raw.headIntervals.map((value: number[]) => new Uint32Array(value));
  if (raw.tailIntervals) (target as Gltf).tailIntervals = raw.tailIntervals.map((value: number[]) => new Uint32Array(value));
  return target;
}

function reviveSequence(raw: Gltf): Sequence {
  const out = new Sequence();
  Object.assign(out, raw);
  out.interval = new Uint32Array(raw.interval || [0, 0]);
  out.extent = extent(raw.extent);
  return out;
}

function reviveMaterial(raw: Gltf): Material {
  const out = new Material();
  Object.assign(out, raw);
  out.layers = (raw.layers || []).map((layer: Gltf) => animated(new Layer(), layer));
  return out;
}

function imageExtension(image: Gltf, bytes: Uint8Array): string {
  if (image.mimeType === "image/jpeg") return ".jpg";
  if (image.mimeType === "image/png") return ".png";
  if (bytes.length >= 4 && bytes[0] === 137 && bytes[1] === 80) return ".png";
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 216) return ".jpg";
  return ".png";
}

function nodeParent(doc: Gltf): number[] {
  const parents = new Array<number>(doc.nodes?.length || 0).fill(-1);
  for (const [index, node] of (doc.nodes || []).entries()) {
    for (const child of node.children || []) if (parents[child] === -1) parents[child] = index;
  }
  return parents;
}

function convertedTrack(path: string, channel: Gltf, sampler: Gltf, buffers: Uint8Array[], doc: Gltf, parentPivot: ArrayLike<number>, globalSequenceId: number, sequenceStart: number): AnimationInstance {
  const source = channel.extras?.openwar3 || {};
  const name = source.sourceTrack || CHANNELS[path];
  const input = accessor(doc, buffers, sampler.input);
  const output = accessor(doc, buffers, sampler.output);
  const cubic = sampler.interpolation === "CUBICSPLINE";
  const width = path === "rotation" ? 4 : 3;
  const raw: Gltf = {
    name,
    interpolationType: source.interpolationType ?? (sampler.interpolation === "STEP" ? 0 : cubic ? 2 : 1),
    globalSequenceId,
    frames: [],
    values: [],
    inTans: [],
    outTans: [],
  };
  for (let i = 0; i < input.length; i++) {
    raw.frames.push(Math.round(sequenceStart + input[i] * 1000));
    const center = (cubic ? i * 3 + 1 : i) * width;
    const value = Array.from(output.subarray(center, center + width));
    if (path === "translation") for (let c = 0; c < 3; c++) value[c] -= parentPivot[c] || 0;
    raw.values.push(value);
    if (cubic) {
      const incoming = Array.from(output.subarray(i * 3 * width, i * 3 * width + width));
      const outgoing = Array.from(output.subarray((i * 3 + 2) * width, (i * 3 + 2) * width + width));
      const centerValue = Array.from(output.subarray(center, center + width));
      raw.inTans.push(raw.interpolationType === 3 ? incoming.map((v, c) => centerValue[c] + v / 3) : incoming);
      raw.outTans.push(raw.interpolationType === 3 ? outgoing.map((v, c) => centerValue[c] + v / 3) : outgoing);
    }
  }
  return animation(raw);
}

function staticTrack(name: string, frames: number[], value: ArrayLike<number>): AnimationInstance {
  return animation({ name, interpolationType: 1, globalSequenceId: -1, frames, values: frames.map(() => Array.from(value)), inTans: [], outTans: [] });
}

export function convertGltf(source: Uint8Array, sourcePath: string, read: Reader): { bytes: Uint8Array; files: Map<string, Uint8Array> } {
  const { doc, buffers } = parse(source, sourcePath, read);
  const metadata = doc.extras?.openwar3;
  if (metadata?.sourceOriginal) {
    const original = read(resolvePath(sourcePath, metadata.sourceOriginal));
    if (original && original.length >= 4 && String.fromCharCode(...original.subarray(0, 4)) === "MDLX") return { bytes: original, files: new Map() };
  }

  const model = new MdlxModel();
  model.version = 800;
  model.name = metadata?.sourcePath?.split("\\").pop()?.replace(/\.mdx$/i, "") || sourcePath.split("\\").pop()?.replace(/\.(gltf|glb)$/i, "") || "glTF";
  const files = new Map<string, Uint8Array>();
  const imagePaths: string[] = (doc.images || []).map((image: Gltf, index: number) => {
    let bytes: Uint8Array | null = null;
    let path = "";
    if (image.uri) {
      const embedded = dataUri(image.uri);
      path = resolvePath(sourcePath, image.uri);
      bytes = embedded || read(path);
    } else if (image.bufferView !== undefined) {
      const view = doc.bufferViews[image.bufferView];
      const buffer = buffers[view.buffer];
      bytes = buffer.subarray((view.byteOffset || 0) + (image.byteOffset || 0), (view.byteOffset || 0) + (image.byteOffset || 0) + view.byteLength);
    }
    if (!bytes) throw new Error(`${sourcePath}: cannot read image ${image.uri || index}`);
    if (!image.uri || dataUri(image.uri) || image.bufferView !== undefined) {
      path = `${sourcePath}#image${index}${imageExtension(image, bytes)}`;
      files.set(normalizeMpqPath(path), bytes);
    }
    return normalizeMpqPath(path);
  });

  if (metadata?.materials && metadata?.textures) {
    model.materials = metadata.materials.map(reviveMaterial);
    model.textures = metadata.textures.map((raw: Gltf) => {
      const texture = Object.assign(new Texture(), raw);
      if (texture.path) {
        const imageIndex = (doc.images || []).findIndex((image: Gltf) => normalizeMpqPath(image.extras?.openwar3?.sourcePath || "") === normalizeMpqPath(raw.path));
        if (imageIndex >= 0) texture.path = imagePaths[imageIndex];
      }
      return texture;
    });
  } else {
    model.textures = (doc.textures || []).map((texture: Gltf) => Object.assign(new Texture(), { path: imagePaths[texture.source], wrapMode: 0 }));
    model.materials = (doc.materials || []).map((raw: Gltf) => {
      const material = new Material();
      material.flags = raw.doubleSided ? 2 : 0;
      const layer = new Layer();
      layer.filterMode = raw.alphaMode === "MASK" ? 1 : raw.alphaMode === "BLEND" ? 2 : 0;
      layer.flags = raw.doubleSided ? 16 : 0;
      if (raw.extensions?.KHR_materials_unlit) layer.flags |= 1;
      layer.alpha = raw.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1;
      layer.textureId = raw.pbrMetallicRoughness?.baseColorTexture?.index ?? -1;
      layer.coordId = raw.pbrMetallicRoughness?.baseColorTexture?.texCoord ?? 0;
      material.layers.push(layer);
      return material;
    });
  }
  if (!model.materials.length) model.materials.push(reviveMaterial({ layers: [{}] }));
  model.textureAnimations = (metadata?.textureAnimations || []).map((raw: Gltf) => animated(new TextureAnimation(), raw));
  model.geosetAnimations = (metadata?.geosetAnimations || []).map((raw: Gltf) => animated(new GeosetAnimation(), raw));
  model.sequences = (metadata?.sequences || []).map(reviveSequence);
  if (!metadata && !model.sequences.length) {
    const sequence = new Sequence();
    sequence.name = "Stand";
    sequence.interval = new Uint32Array([0, 1000]);
    sequence.extent = extent(undefined);
    model.sequences.push(sequence);
  }
  model.globalSequences = (metadata?.globalSequences || []).slice();
  model.pivotPoints = (metadata?.pivotPoints || []).map((pivot: number[]) => new Float32Array(pivot));

  const parents = nodeParent(doc);
  const nodeObjects = new Map<number, GenericObject>();
  const openWar3 = Boolean(metadata);
  let nextId = 0;
  for (const [nodeIndex, node] of (doc.nodes || []).entries()) {
    const raw = node.extras?.openwar3;
    if (openWar3 && !raw) continue;
    const joint = (doc.skins || []).some((skin: Gltf) => skin.joints.includes(nodeIndex));
    const metadataType = raw?.objectType || (typeof raw?.type === "string" ? raw.type : raw?.attenuation ? "light" : raw?.vertices ? "collisionShape" : "");
    const type = metadataType || (joint ? "bone" : node.mesh === undefined ? "helper" : "");
    const definition = OBJECTS[type];
    if (!definition) continue;
    const object = animated(new definition.Ctor(), raw || {});
    object.name = node.name || `${type}_${nodeIndex}`;
    object.objectId = raw?.objectId ?? nextId;
    nextId = Math.max(nextId, object.objectId + 1);
    object.parentId = raw?.parentId ?? -1;
    object.animations = (raw?.animations || []).map(animation);
    if (object instanceof EventObject) object.tracks = new Uint32Array(raw?.tracks || []);
    nodeObjects.set(nodeIndex, object);
    (model as Gltf)[definition.collection].push(object);
    model.pivotPoints[object.objectId] = new Float32Array(raw?.pivot || node.translation || [0, 0, 0]);
  }
  if (!openWar3) {
    const pivots = new Map<GenericObject, Float32Array>();
    for (const object of nodeObjects.values()) pivots.set(object, model.pivotPoints[object.objectId]);
    nextId = 0;
    for (const { collection } of Object.values(OBJECTS)) {
      for (const object of (model as Gltf)[collection] as GenericObject[]) {
        object.objectId = nextId++;
        model.pivotPoints[object.objectId] = pivots.get(object)!;
      }
    }
    model.pivotPoints.length = nextId;
  }
  for (const [nodeIndex, object] of nodeObjects) {
    if (openWar3) continue;
    let parent = parents[nodeIndex];
    while (parent >= 0 && !nodeObjects.has(parent)) parent = parents[parent];
    object.parentId = parent >= 0 ? nodeObjects.get(parent)!.objectId : -1;
  }

  if (!openWar3) {
    const conversion = new Helper();
    conversion.name = "glTF_Yup_to_MDX_Zup";
    conversion.objectId = nextId++;
    conversion.parentId = -1;
    model.helpers.push(conversion);
    model.pivotPoints[conversion.objectId] = new Float32Array(3);
    for (const object of nodeObjects.values()) if (object.parentId === -1) object.parentId = conversion.objectId;
    const frames = model.sequences.map((sequence) => sequence.interval[0]);
    conversion.animations.push(staticTrack("KGRT", frames.length ? frames : [0], [Math.SQRT1_2, 0, 0, Math.SQRT1_2]));
  }

  const objectForJoint = (skinIndex: number, jointIndex: number): number => {
    const skin = doc.skins[skinIndex];
    const objectId = skin.extras?.openwar3?.jointObjectIds?.[jointIndex];
    if (objectId !== undefined) return objectId;
    const node = skin.joints[jointIndex];
    return nodeObjects.get(node)?.objectId ?? 0;
  };

  for (const node of doc.nodes || []) {
    if (node.mesh === undefined) continue;
    const mesh = doc.meshes[node.mesh];
    const geosetMeta = mesh.extras?.openwar3;
    const primitives = openWar3 ? mesh.primitives.slice(0, 1) : mesh.primitives;
    for (const primitive of primitives) {
      const positions = accessor(doc, buffers, primitive.attributes.POSITION) as Float32Array;
      const vertexCount = positions.length / 3;
      if (vertexCount > 65535) throw new Error(`${sourcePath}: geoset has more than 65535 vertices`);
      const geoset = new Geoset();
      geoset.vertexGroups = new Uint8Array(vertexCount);
      geoset.vertices = positions;
      geoset.normals = primitive.attributes.NORMAL === undefined ? new Float32Array(vertexCount * 3) : accessor(doc, buffers, primitive.attributes.NORMAL) as Float32Array;
      const uvKeys = Object.keys(primitive.attributes).filter((key) => /^TEXCOORD_\d+$/.test(key)).sort();
      geoset.uvSets = uvKeys.map((key) => accessor(doc, buffers, primitive.attributes[key]) as Float32Array);
      const indices = primitive.indices === undefined ? Uint32Array.from({ length: vertexCount }, (_, i) => i) : accessor(doc, buffers, primitive.indices, true) as Uint32Array;
      geoset.faces = new Uint16Array(indices);
      geoset.faceTypeGroups = new Uint32Array([4]);
      geoset.faceGroups = new Uint32Array([indices.length]);
      geoset.materialId = geosetMeta?.materialId ?? primitive.material ?? 0;
      geoset.selectionGroup = geosetMeta?.selectionGroup ?? 0;
      geoset.selectionFlags = geosetMeta?.selectionFlags ?? 0;
      geoset.extent = extent(undefined, positions);
      const groups: number[][] = [];
      const groupIndices = new Map<string, number>();
      const groupFor = (joints: number[]): number => {
        const key = joints.join(",");
        let index = groupIndices.get(key);
        if (index === undefined) {
          index = groups.length;
          groupIndices.set(key, index);
          groups.push(joints);
        }
        return index;
      };
      if (node.skin !== undefined && primitive.attributes.JOINTS_0 !== undefined) {
        const joints = accessor(doc, buffers, primitive.attributes.JOINTS_0, true) as Uint32Array;
        const weights = accessor(doc, buffers, primitive.attributes.WEIGHTS_0) as Float32Array;
        for (let i = 0; i < vertexCount; i++) {
          const influences: number[] = [];
          for (let j = 0; j < 4; j++) if (weights[i * 4 + j] > 0) influences.push(objectForJoint(node.skin, joints[i * 4 + j]));
          geoset.vertexGroups[i] = groupFor(influences.length ? influences : [0]);
        }
      } else {
        const fallback = nodeObjects.values().next().value?.objectId ?? 0;
        const group = groupFor([fallback]);
        geoset.vertexGroups.fill(group);
      }
      for (const extra of geosetMeta?.extendedInfluences || []) geoset.vertexGroups[extra.vertex] = groupFor(extra.objectIds);
      geoset.matrixGroups = new Uint32Array(groups.map((group) => group.length));
      geoset.matrixIndices = new Uint32Array(groups.flat());
      model.geosets.push(geoset);
    }
  }

  for (const [index, gltfAnimation] of (doc.animations || []).entries()) {
    const rawSequence = gltfAnimation.extras?.openwar3;
    const globalSequenceId = rawSequence?.globalSequenceId ?? -1;
    let sequenceStart = rawSequence?.interval?.[0] ?? 0;
    if (globalSequenceId === -1 && !rawSequence) {
      let end = 0;
      for (const sampler of gltfAnimation.samplers) {
        const input = accessor(doc, buffers, sampler.input);
        if (input.length) end = Math.max(end, input[input.length - 1] * 1000);
      }
      const sequence = new Sequence();
      sequence.name = gltfAnimation.name || `Animation_${index}`;
      sequence.interval = new Uint32Array([0, Math.round(end)]);
      sequence.extent = extent(undefined);
      model.sequences.push(sequence);
    } else if (globalSequenceId === -1 && !model.sequences.some((sequence) => sequence.name === gltfAnimation.name)) {
      model.sequences.push(reviveSequence(rawSequence));
    }
    for (const channel of gltfAnimation.channels || []) {
      const path = channel.target.path;
      if (!CHANNELS[path]) continue;
      const object = nodeObjects.get(channel.target.node);
      if (!object) continue;
      const sampler = gltfAnimation.samplers[channel.sampler];
      const pivot = model.pivotPoints[object.parentId] || [0, 0, 0];
      object.animations.push(convertedTrack(path, channel, sampler, buffers, doc, pivot, globalSequenceId, sequenceStart));
    }
  }

  if (!openWar3) {
    const frames = model.sequences.map((sequence) => sequence.interval[0]);
    for (const [nodeIndex, object] of nodeObjects) {
      const node = doc.nodes[nodeIndex];
      if (node.matrix) {
        const matrix = mat4.clone(node.matrix);
        const rotation = quat.create();
        const scale = vec3.create();
        mat4.getRotation(rotation, matrix);
        mat4.getScaling(scale, matrix);
        object.animations.push(staticTrack("KGRT", frames.length ? frames : [0], rotation));
        object.animations.push(staticTrack("KGSC", frames.length ? frames : [0], scale));
      } else {
        if (node.rotation) object.animations.push(staticTrack("KGRT", frames.length ? frames : [0], node.rotation));
        if (node.scale) object.animations.push(staticTrack("KGSC", frames.length ? frames : [0], node.scale));
      }
    }
  }

  model.cameras = (metadata?.cameras || []).map((raw: Gltf) => animated(new Camera(), raw));
  model.faceEffects = (metadata?.faceEffects || []).map((raw: Gltf) => Object.assign(new FaceEffect(), raw));
  model.extent = extent(metadata?.extent, model.geosets.length ? model.geosets[0].vertices : undefined);
  return { bytes: model.saveMdx(), files };
}

function gltfDocument(source: Uint8Array): Gltf {
  if (source.length >= 20 && new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(0, true) === 0x46546c67) {
    const length = new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(source.subarray(20, 20 + length)));
  }
  return JSON.parse(new TextDecoder().decode(source));
}

export class GltfDataSource implements DataSource {
  private cache = new Map<string, Uint8Array | null>();
  private pending = new Map<string, Promise<Uint8Array | null>>();
  private virtual = new Map<string, Uint8Array>();

  constructor(private inner: DataSource) {}

  get label(): string {
    return `gltf[${this.inner.label}]`;
  }

  exists(path: string): boolean {
    const normalized = normalizeMpqPath(path);
    if (this.virtual.has(normalized) || this.inner.exists(normalized)) return true;
    return isGltfPath(normalized) && this.inner.exists(normalized.replace(MODEL_EXTENSIONS, ".mdx"));
  }

  private async prefetch(source: Uint8Array, sourcePath: string): Promise<void> {
    const doc = gltfDocument(source);
    const dependencies = new Set<string>();
    for (const buffer of doc.buffers || []) if (buffer.uri && !dataUri(buffer.uri)) dependencies.add(resolvePath(sourcePath, buffer.uri));
    for (const image of doc.images || []) if (image.uri && !dataUri(image.uri)) dependencies.add(resolvePath(sourcePath, image.uri));
    await Promise.all([...dependencies].map((path) => this.inner.read(path)));
    const original = doc.extras?.openwar3?.sourceOriginal;
    if (original) await this.inner.read(resolvePath(sourcePath, original)).catch(() => null);
  }

  async read(path: string): Promise<Uint8Array> {
    let normalized = normalizeMpqPath(path);
    if (/\.mdx$/i.test(normalized)) {
      const convertedPath = normalized.replace(/\.mdx$/i, ".gltf");
      if (this.inner.exists(convertedPath)) normalized = convertedPath;
    }
    if (!isGltfPath(normalized)) return this.inner.read(normalized);
    if (this.cache.has(normalized)) {
      const cached = this.cache.get(normalized);
      if (cached) return cached;
    }
    let promise = this.pending.get(normalized);
    if (!promise) {
      promise = (async () => {
        const source = await this.inner.read(normalized).catch(() => null);
        if (source) await this.prefetch(source, normalized);
        return this.rawBytes(normalized);
      })();
      this.pending.set(normalized, promise);
    }
    const bytes = await promise;
    if (!bytes) throw new Error(`${this.label}: file not found or unreadable: ${path}`);
    return bytes;
  }

  rawBytes(path: string): Uint8Array | null {
    let normalized = normalizeMpqPath(path);
    const virtual = this.virtual.get(normalized);
    if (virtual) return virtual;
    if (/\.mdx$/i.test(normalized)) {
      const convertedPath = normalized.replace(/\.mdx$/i, ".gltf");
      if (this.inner.exists(convertedPath)) normalized = convertedPath;
    }
    if (!isGltfPath(normalized)) return this.inner.rawBytes(normalized);
    if (this.cache.has(normalized)) return this.cache.get(normalized)!;
    let converted: Uint8Array | null = null;
    const source = this.inner.rawBytes(normalized);
    if (source) {
      try {
        const result = convertGltf(source, normalized, (dependency) => this.inner.rawBytes(normalizeMpqPath(dependency)));
        converted = result.bytes;
        for (const [path, bytes] of result.files) this.virtual.set(path, bytes);
      } catch (error) {
        console.warn(`[gltf] ${normalized}: conversion failed, trying MDX fallback`, error);
      }
    }
    if (!converted) converted = this.inner.rawBytes(normalized.replace(MODEL_EXTENSIONS, ".mdx"));
    this.cache.set(normalized, converted);
    return converted;
  }

  list(): string[] {
    return [...new Set([...this.inner.list(), ...this.virtual.keys()])].sort();
  }

  openArchive(path: string): DataSource | null {
    const archive = this.inner.openArchive?.(path);
    return archive ? new GltfDataSource(archive) : null;
  }
}
