import * as THREE from "three";

import { groupLevels, type LodCandidate } from "../../core/lod-grouping.mjs";

export interface LodLevel {
  name: string;
  triangles: number;
  texturePixels: number;
  objects: THREE.Object3D[];
}

export interface LodSet {
  source: 'extension' | 'names' | 'measured';
  levels: LodLevel[];
}

interface Candidate extends LodCandidate {
  obj: THREE.Object3D;
}

const triangleCount = (root: THREE.Object3D): number => {
  let tri = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const geom = mesh.geometry;
    if (!geom || !geom.attributes || !geom.attributes.position) return;
    tri += geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
  });
  return Math.round(tri);
};

const texturePixels = (root: THREE.Object3D): number => {
  const seen = new Set<unknown>();
  let px = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
        const tex = value as (THREE.Texture & { isTexture?: boolean }) | null;
        if (!tex || !tex.isTexture) continue;
        const img = tex.image as { width?: number; height?: number } | undefined;
        const w = img?.width || 0;
        const h = img?.height || 0;
        if (!w || !h || seen.has(img)) continue;
        seen.add(img);
        px += w * h;
      }
    }
  });
  return px;
};

function measure(obj: THREE.Object3D): Candidate | null {
  const triangles = triangleCount(obj);
  if (triangles <= 0) return null;
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    obj,
    name: obj.name || '',
    triangles,
    texturePixels: texturePixels(obj),
    size: [size.x, size.y, size.z],
    center: [center.x, center.y, center.z],
  };
}

async function fromExtension(gltf: {
  parser?: { json?: Record<string, unknown>; getDependency?: (t: string, i: number) => Promise<unknown> };
  scene?: THREE.Object3D;
}): Promise<LodSet | null> {
  const parser = gltf.parser;
  const json = parser?.json as { nodes?: Array<Record<string, unknown>> } | undefined;
  if (!parser?.getDependency || !json?.nodes) return null;

  let holder = -1;
  let ids: number[] = [];
  json.nodes.forEach((n, i) => {
    if (holder !== -1) return;
    const ext = (n.extensions as Record<string, { ids?: number[] }> | undefined)?.['MSFT_lod'];
    if (ext && Array.isArray(ext.ids) && ext.ids.length) { holder = i; ids = ext.ids; }
  });
  if (holder === -1) return null;

  const levels: LodLevel[] = [];
  for (const nodeIndex of [holder, ...ids]) {
    const obj = (await parser.getDependency('node', nodeIndex)) as THREE.Object3D | null;
    if (!obj) continue;
    levels.push({
      name: obj.name || '',
      triangles: triangleCount(obj),
      texturePixels: texturePixels(obj),
      objects: [obj],
    });
  }
  if (levels.length < 2) return null;
  return { source: 'extension', levels };
}

type Association = { nodes?: number; meshes?: number; primitives?: number };

function nodeFilter(assoc?: Map<unknown, Association>): (o: THREE.Object3D) => boolean {
  if (!assoc || typeof assoc.get !== 'function') return () => true;
  return (o) => assoc.get(o)?.nodes !== undefined;
}

function fromSiblings(scene: THREE.Object3D, isNode: (o: THREE.Object3D) => boolean): LodSet | null {
  let named: LodSet | null = null;
  let measured: LodSet | null = null;

  scene.traverse((parent) => {
    if (named) return;

    const cands: Candidate[] = [];
    for (const child of parent.children) {
      if (!isNode(child)) continue;
      const m = measure(child);
      if (m) cands.push(m);
    }

    const group = groupLevels(cands);
    if (!group) return;

    const set: LodSet = {
      source: group.source,
      levels: group.order.map((i) => {
        const c = cands[i]!;
        return {
          name: c.name,
          triangles: c.triangles,
          texturePixels: c.texturePixels,
          objects: [c.obj],
        };
      }),
    };
    if (group.source === 'names') named = set;
    else if (!measured) measured = set;
  });

  return named ?? measured;
}

export async function detectLods(gltf: { scene?: THREE.Object3D } & Record<string, unknown>): Promise<LodSet | null> {
  const byExtension = await fromExtension(gltf as Parameters<typeof fromExtension>[0]);
  if (byExtension) return byExtension;
  if (!gltf.scene) return null;
  const assoc = (gltf.parser as { associations?: Map<unknown, Association> } | undefined)?.associations;
  return fromSiblings(gltf.scene, nodeFilter(assoc));
}

export function showLod(set: LodSet, root: THREE.Object3D, index: number | 'all' | null): void {
  set.levels.forEach((level, i) => {
    const visible = index === 'all'
      ? true
      : index === null
        ? (set.source === 'extension' ? i === 0 : true)
        : i === index;
    for (const obj of level.objects) {
      if (visible && set.source === 'extension' && !obj.parent) root.add(obj);
      obj.visible = visible;
    }
  });
}
