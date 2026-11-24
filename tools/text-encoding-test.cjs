const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');

const {
  configureWar3TextEncoding,
  decodeWar3Text,
  detectWar3TextEncoding,
  encodeWar3Text,
  war3TextEncoding,
} = require(join(REPO, ".sim-build", "src", "vfs", "textEncoding.js"));
const { loadCommandStrings } = require(join(REPO, ".sim-build", "src", "data", "commandStrings.js"));
const { setCustomKeys, customKeysText } = require(join(REPO, ".sim-build", "src", "data", "customKeys.js"));
const { encodeAnsi } = require(join(REPO, ".sim-build", "src", "data", "customKeysDoc.js"));

let failed = 0;
function ok(what, condition) {
  console.log(`${condition ? "ok   " : "FAIL "} ${what}`);
  if (!condition) failed++;
}

function source(files = {}) {
  return {
    label: "encoding-test",
    exists: (path) => Object.hasOwn(files, path),
    read: async (path) => {
      if (!Object.hasOwn(files, path)) throw new Error(`missing ${path}`);
      return files[path];
    },
    rawBytes: (path) => files[path] ?? null,
    list: () => Object.keys(files),
  };
}

const empty = source();
ok("a Western install keeps windows-1252", detectWar3TextEncoding([new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65])]) === "windows-1252");
ok("ruRU is explicit even before localized samples are inspected", configureWar3TextEncoding(empty, "ruRU") === "windows-1251");

const russianText = "Русский язык, шэю. Привет мир! Южный";
const russianBytes = encodeWar3Text(russianText);
ok("Cyrillic survives an encode/decode round trip", decodeWar3Text(russianBytes) === russianText);
ok("Russian MPQ samples select windows-1251", detectWar3TextEncoding([russianBytes]) === "windows-1251");

const installFiles = {
  "UI\\FrameDef\\GlobalStrings.fdf": russianBytes,
  "Units\\commandstrings.txt": encodeWar3Text("[Errors]\r\nNogold=Недостаточно золота.\r\n"),
};
const install = source(installFiles);
ok("an MPQ mount configures its detected code page", configureWar3TextEncoding(install) === "windows-1251");
ok("the real command-string loader reads Russian", loadCommandStrings(install).get("Nogold") === "Недостаточно золота.");

setCustomKeys(encodeWar3Text("[ogru]\r\nTip=Огр\r\n"), null);
ok("CustomKeys bytes are decoded with the install", customKeysText() === "[ogru]\r\nTip=Огр\r\n");
ok("CustomKeys save uses the same code page", decodeWar3Text(encodeAnsi(customKeysText())) === customKeysText());
setCustomKeys(null, null);

const menuText = "Одиночная игра\nКампания\nЛокальная сеть\nОпции\nВыход";
const utf8Bytes = new TextEncoder().encode(menuText);
ok("UTF-8 Russian is not mistaken for a legacy code page", detectWar3TextEncoding([utf8Bytes]) === "utf-8");
const utf8InstallFiles = {
  "UI\\FrameDef\\GlobalStrings.fdf": utf8Bytes,
  "Units\\commandstrings.txt": new TextEncoder().encode("[Errors]\r\nNogold=Недостаточно золота.\r\n"),
};
const utf8Install = source(utf8InstallFiles);
ok("a UTF-8 MPQ mount selects UTF-8", configureWar3TextEncoding(utf8Install) === "utf-8");
ok("the menu example from the screenshot decodes correctly", decodeWar3Text(utf8Bytes) === menuText);
ok("the real command-string loader reads UTF-8 Russian", loadCommandStrings(utf8Install).get("Nogold") === "Недостаточно золота.");
setCustomKeys(new TextEncoder().encode("[ogru]\r\nTip=Огр\r\n"), null);
const utf8Keys = customKeysText();
ok("UTF-8 CustomKeys are saved as UTF-8", Buffer.from(encodeAnsi(utf8Keys)).equals(Buffer.from(new TextEncoder().encode(utf8Keys))));
setCustomKeys(null, null);

configureWar3TextEncoding(empty);
const westernText = "Grüße — €";
ok("windows-1252 still round-trips Western text", decodeWar3Text(encodeWar3Text(westernText)) === westernText);
ok("the default is restored for the next install", war3TextEncoding() === "windows-1252");

if (failed) process.exitCode = 1;

async function checkRealMpqMount() {
  const { loadProfile } = require(join(REPO, ".sim-build", "src", "vfs", "loader.js"));
  const { DEFAULT_PROFILE } = require(join(REPO, ".sim-build", "src", "vfs", "profiles.js"));
  const mpqMod = require("mdx-m3-viewer/dist/cjs/parsers/mpq");
  const Archive = (mpqMod.default ?? mpqMod).Archive;
  const archive = (name, files) => {
    const a = new Archive();
    a.hashTable.addEmpties(16 - a.hashTable.entries.length);
    for (const [path, bytes] of Object.entries(files)) {
      if (!a.set(path, bytes)) throw new Error(`could not add ${path}`);
    }
    const bytes = a.save();
    return [name.toLowerCase(), { name, arrayBuffer: async () => bytes.slice().buffer }];
  };
  const files = new Map([
    archive("war3.mpq", { "dummy.txt": new Uint8Array([0]) }),
    archive("war3x.mpq", installFiles),
  ]);
  const loaded = await loadProfile({ files, casc: null, customKeys: null }, DEFAULT_PROFILE);
  ok("loadProfile detects Russian inside real MPQ archives", war3TextEncoding() === "windows-1251");
  ok("a Russian string survives the complete MPQ mount", loadCommandStrings(loaded.vfs).get("Nogold") === "Недостаточно золота.");

  const utf8Files = new Map([
    archive("war3.mpq", { "dummy.txt": new Uint8Array([0]) }),
    archive("war3x.mpq", utf8InstallFiles),
  ]);
  const loadedUtf8 = await loadProfile({ files: utf8Files, casc: null, customKeys: null }, DEFAULT_PROFILE);
  ok("loadProfile detects UTF-8 inside real MPQ archives", war3TextEncoding() === "utf-8");
  ok("a UTF-8 Russian string survives the complete MPQ mount", loadCommandStrings(loadedUtf8.vfs).get("Nogold") === "Недостаточно золота.");
}

void checkRealMpqMount().then(() => {
  if (failed) process.exitCode = 1;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
