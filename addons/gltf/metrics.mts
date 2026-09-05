import * as gltfCore from '@gltf-transform/core';
import * as fns from '@gltf-transform/functions';

import type { Document, Node, bbox } from '@gltf-transform/core';

export type GltfMetrics = {
  fileBytes: number;
  drawCalls: number;
  triangles: number;
  vertices: number;
  verticesStored: number;
  morphTargets: number;
  attributes: string;
  textureBytes: number;
  gpuBytes: number;
  textureMaxSize: number;
  uvWithoutTextures: number;
  meshes: number;
  materials: number;
  textures: number;
  nodes: number;
  scenes: number;
  animations: number;
  skins: number;
  bounds: bbox | null;
};

export type SceneGeometry = Pick<GltfMetrics, 'drawCalls' | 'triangles' | 'vertices' | 'morphTargets' | 'attributes'>;

export type BaselineSnapshot = {
  triangles: number;
  vertices: number;
  morphTargets: number;
  attributes: string;
  drawCalls: number;
  skins: number;
  nodes: number;
  animations: number;
};

interface InstancingExtension {
  listSemantics?: () => string[];
  getAttribute: (semantic: string) => { getCount: () => number } | null;
}

function instanceCountOf(node: Node): number {
  const ext = (typeof node.getExtension === 'function'
    ? node.getExtension('EXT_mesh_gpu_instancing')
    : null) as InstancingExtension | null;
  if (!ext) return 1;
  const sem = ext.listSemantics && ext.listSemantics()[0];
  const attr = sem && ext.getAttribute(sem);
  return (attr && attr.getCount()) || 1;
}

export function sceneGeometry(doc: Document): SceneGeometry {
  let drawCalls = 0;
  let triangles = 0;
  let vertices = 0;
  let morphTargets = 0;
  const semantics = new Set<string>();
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const instances = instanceCountOf(node);
      for (const prim of mesh.listPrimitives()) {
        drawCalls += 1;
        morphTargets += prim.listTargets().length;
        for (const s of prim.listSemantics()) semantics.add(s);
        const pos = prim.getAttribute('POSITION');
        if (pos) vertices += pos.getCount() * instances;
        if (prim.getMode() === 4) {
          const idx = prim.getIndices();
          triangles += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3) * instances;
        }
      }
    });
  }
  return { drawCalls, triangles, vertices, morphTargets, attributes: [...semantics].sort().join(',') };
}

function maxTextureSide(doc: Document): number {
  let max = 0;
  for (const tex of doc.getRoot().listTextures()) {
    const size = textureSize(tex.getImage(), tex.getMimeType());
    if (!size) continue;
    max = Math.max(max, size[0] || 0, size[1] || 0);
  }
  return max;
}

function storedVertices(doc: Document): number {
  const seen = new Set<object>();
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos || seen.has(pos)) continue;
      seen.add(pos);
      total += pos.getCount();
    }
  }
  return total;
}

export function textureSize(image: Uint8Array | null, mime: string | null): number[] | null {
  if (!image || !mime) return null;
  try {
    return gltfCore.ImageUtils.getSize(image, mime);
  } catch {
    return null;
  }
}

function uvWithoutTextures(doc: Document): number {
  const сКартами = new Set<unknown>();
  for (const tex of doc.getRoot().listTextures()) {
    for (const parent of tex.listParents()) сКартами.add(parent);
  }

  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (!prim.listSemantics().some((s) => s.startsWith('TEXCOORD_'))) continue;
      const material = prim.getMaterial();
      if (!material || !сКартами.has(material)) n += 1;
    }
  }
  return n;
}

export function collectMetrics(doc: Document, fileBytes: number): GltfMetrics {
  const root = doc.getRoot();
  const { drawCalls, triangles, vertices, morphTargets, attributes } = sceneGeometry(doc);
  let textureBytes = 0;
  let gpuBytes = 0;
  try {
    const report = fns.inspect(doc);
    for (const t of report.textures.properties) {
      textureBytes += t.size || 0;
      gpuBytes += t.gpuSize || 0;
    }
  } catch {
  }
  return {
    textureMaxSize: maxTextureSide(doc),
    uvWithoutTextures: uvWithoutTextures(doc),
    verticesStored: storedVertices(doc),
    fileBytes,
    drawCalls,
    triangles,
    vertices,
    morphTargets,
    attributes,
    textureBytes,
    gpuBytes,
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    nodes: root.listNodes().length,
    scenes: root.listScenes().length,
    animations: root.listAnimations().length,
    skins: effectiveSkins(doc),
    bounds: sceneBounds(doc),
  };
}

export function effectiveSkins(doc: Document): number {
  const used = new Set<unknown>();
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh) continue;
    if (mesh.listPrimitives().some((p) => p.getAttribute('JOINTS_0'))) used.add(skin);
  }
  return used.size;
}

function sceneBounds(doc: Document): bbox | null {
  if (typeof gltfCore.getBounds !== 'function') return null;
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  if (!scene) return null;
  try { return gltfCore.getBounds(scene); } catch { return null; }
}

export function countTriangles(doc: Document): number {
  return sceneGeometry(doc).triangles;
}

export const BASELINE_METRICS = ['triangles', 'vertices', 'drawCalls', 'skins', 'nodes', 'animations', 'morphTargets', 'attributes'];

export const BASELINE_SOFT = new Set(['vertices', 'nodes']);

export function baselineSnapshot(doc: Document): BaselineSnapshot {
  const { drawCalls, triangles, vertices, morphTargets, attributes } = sceneGeometry(doc);
  return {
    triangles,
    vertices,
    morphTargets,
    attributes,
    drawCalls,
    skins: effectiveSkins(doc),
    nodes: doc.getRoot().listNodes().length,
    animations: doc.getRoot().listAnimations().length,
  };
}

export function listSemantics(doc: Document): Set<string> {
  const out = new Set<string>();
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) for (const s of p.listSemantics()) out.add(s);
  return out;
}

export const MB = (b: number): string => (b / (1024 * 1024)).toFixed(2);
