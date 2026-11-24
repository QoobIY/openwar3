import type { PickedInstall, InstallFiles } from "./opfs";
import { fetchInstallAnsi, lazyMapFile, type FileUrl } from "./remoteInstall";

interface MediaManifest {
  files: string[];
  customKeys: string | null;
}

const fileUrl: FileUrl = (path) => `/wc3/media-file?path=${encodeURIComponent(path)}`;

export async function loadMediaInstall(): Promise<PickedInstall | null> {
  const response = await fetch("/wc3/media-manifest.json");
  if (!response.ok) return null;
  const manifest = await response.json() as MediaManifest;
  if (!Array.isArray(manifest.files) || !manifest.files.length) return null;
  const files: InstallFiles = new Map();
  for (const path of manifest.files) {
    const file = lazyMapFile(fileUrl, path);
    files.set(path, file);
    if (path.toLowerCase().startsWith("files\\maps\\")) files.set(path.slice(6), file);
  }
  const customKeys = manifest.customKeys ? await fetchInstallAnsi(fileUrl, manifest.customKeys) : null;
  return { files, casc: null, customKeys, media: true };
}
