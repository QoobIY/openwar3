const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const ROOT = path.join(__dirname, "..");
const { MediaDataSource } = require(path.join(ROOT, ".sim-build", "src", "vfs", "media.js"));
const { GltfDataSource } = require(path.join(ROOT, ".sim-build", "src", "vfs", "gltf.js"));
const MdlxModel = require("mdx-m3-viewer/dist/cjs/parsers/mdlx/model").default;

const root = path.join(ROOT, "media");
const relative = "gltf/UI/Glues/MainMenu/MainMenu3d_exp/MainMenu3d_exp.gltf";
if (!fs.existsSync(path.join(root, relative))) {
  console.log("ok skipped media VFS integration (media is absent)");
} else {
  void (async () => {
  const files = new Map();
  const handle = (relativePath) => ({ arrayBuffer: async () => fs.readFileSync(path.join(root, relativePath)) });
  const key = (p) => p.replace(/\//g, "\\");
  const sourcePath = key("gltf/UI/Glues/MainMenu/MainMenu3D_Exp/MainMenu3D_Exp.gltf");
  const doc = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  files.set(sourcePath, handle(relative));
  const binPath = key("gltf/UI/Glues/MainMenu/MainMenu3D_Exp/" + doc.buffers[0].uri);
  files.set(binPath, handle("gltf/UI/Glues/MainMenu/MainMenu3d_exp/" + doc.buffers[0].uri));
  for (const image of doc.images) {
    const uri = decodeURIComponent(image.uri).replace(/\//g, "\\");
    const parts = sourcePath.split("\\").slice(0, -1);
    for (const part of uri.split("\\")) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    const resolved = parts.join("\\");
    const actual = resolved.replace(/^gltf\\/i, "gltf/").replace(/\\/g, "/");
    files.set(resolved, handle(actual));
  }
  files.set("files\\Units\\UnitData.slk", handle("files/Units/UnitData.slk"));
  if (fs.existsSync(path.join(root, "core.zip"))) files.set("core.zip", handle("core.zip"));
  const source = new GltfDataSource(await MediaDataSource.open(files));
  const bytes = source.rawBytes("UI\\Glues\\MainMenu\\MainMenu3D_Exp\\MainMenu3D_Exp.mdx");
  const model = new MdlxModel();
  model.load(bytes);
  assert.ok(model.geosets.length > 0);
  const lazyModel = new MdlxModel();
  lazyModel.load(await source.read("UI\\Glues\\MainMenu\\MainMenu3D_Exp\\MainMenu3D_Exp.mdx"));
  assert.equal(lazyModel.geosets.length, model.geosets.length);
  assert.ok(source.exists("Units\\UnitData.slk"));
  assert.ok(source.rawBytes("Units\\UnitData.slk"));
  assert.ok(source.list().includes("Units\\UnitData.slk"));
  console.log(`ok media maps MDX to glTF and resolves case-insensitive external buffers (${model.geosets.length} geosets)`);
  })();
}
