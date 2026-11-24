import type { DataSource } from "../vfs/types";
import { tilesetOverlay } from "../vfs/tileset";

/** The viewer calls the solver as (src, solverParams) — params carry the map's tileset letter
 *  once war3map.w3i is parsed. */
export type Solver = (src: unknown, params?: { tileset?: string }) => unknown;

/** The running map's archive, as the solver sees it. `epoch` moves on every mount, so a second
 *  map's `war3mapImported\x.mdx` is never handed the first map's bytes. */
export interface MapFileLayer {
  archive: DataSource | null;
  epoch: number;
}

/**
 * @param baseUrls the base SLKs, already minted before the viewer existed (and dropped from the
 *   map once the viewer has them).
 * @param created every blob URL minted, in order — the scene revokes them.
 */
export function createAssetSolver(vfs: DataSource, mapFiles: MapFileLayer, baseUrls: Map<string, string>, created: string[]): Solver {
  const blobUrls = new Map<string, string>();
  const pending = new Map<string, Promise<string | null>>();
  const overlay = tilesetOverlay(vfs);
  const mint = (key: string, bytes: Uint8Array): string => {
    let url = blobUrls.get(key);
    if (url === undefined) {
      url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      blobUrls.set(key, url);
      created.push(url);
    }
    return url;
  };
  const mintAsync = (key: string, read: () => Promise<Uint8Array | null>): Promise<string | null> => {
    const cached = blobUrls.get(key);
    if (cached) return Promise.resolve(cached);
    let promise = pending.get(key);
    if (!promise) {
      promise = read().then((bytes) => bytes ? mint(key, bytes) : null).catch(() => null);
      pending.set(key, promise);
    }
    return promise;
  };
  const prefersGltf = (source: DataSource, path: string): boolean => /\.mdx$/i.test(path) && source.exists(path.replace(/\.mdx$/i, ".gltf"));
  const fromInstall = (logical: string, tileset?: string): unknown => {
    const { key, source, path } = overlay(logical, tileset);
    const cached = baseUrls.get(key);
    if (cached) return cached;
    if (prefersGltf(source, path)) return mintAsync(key, () => source.read(path.replace(/\.mdx$/i, ".gltf")));
    const bytes = source.rawBytes(path);
    if (bytes) return mint(key, bytes);
    if (source.exists(path)) return mintAsync(key, () => source.read(path));
    return srcFallback(logical);
  };
  const srcFallback = (logical: string): string => logical;
  return (src, params) => {
    if (typeof src !== "string") return src;
    const logical = src.replace(/\//g, "\\");
    const map = mapFiles.archive;
    if (map) {
      const key = `map${mapFiles.epoch}:${logical.toLowerCase()}`;
      if (prefersGltf(map, logical)) return mintAsync(key, () => map.read(logical.replace(/\.mdx$/i, ".gltf")));
      const bytes = map.rawBytes(logical);
      if (bytes) return mint(key, bytes);
      if (map.exists(logical)) {
        return mintAsync(key, () => map.read(logical)).then((url) => url ?? fromInstall(logical, params?.tileset));
      }
    }
    return fromInstall(logical, params?.tileset);
  };
}
