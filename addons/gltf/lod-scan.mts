import * as gltfCore from '@gltf-transform/core';

import { groupLevels, type LodCandidate } from '../../core/lod-grouping.mjs';

import type { Document, Material, Node, Texture } from '@gltf-transform/core';

export interface LodScan {
  source: 'names' | 'measured';
  nodes: number;
  levels: number;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const child of node.listChildren()) walk(child, visit);
}

function materialTextures(doc: Document): Map<Material, Set<Texture>> {
  const map = new Map<Material, Set<Texture>>();
  for (const tex of doc.getRoot().listTextures()) {
    for (const parent of tex.listParents()) {
      if (parent.propertyType !== 'Material') continue;
      const mat = parent as Material;
      let set = map.get(mat);
      if (!set) { set = new Set(); map.set(mat, set); }
      set.add(tex);
    }
  }
  return map;
}

function triangles(node: Node): number {
  let tri = 0;
  walk(node, (n) => {
    const mesh = n.getMesh();
    if (!mesh) return;
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0);
      tri += count / 3;
    }
  });
  return Math.round(tri);
}

function texturePixels(node: Node, byMaterial: Map<Material, Set<Texture>>): number {
  const seen = new Set<Texture>();
  let px = 0;
  walk(node, (n) => {
    const mesh = n.getMesh();
    if (!mesh) return;
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat) continue;
      for (const tex of byMaterial.get(mat) ?? []) {
        if (seen.has(tex)) continue;
        seen.add(tex);
        const size = tex.getSize();
        if (size) px += size[0] * size[1];
      }
    }
  });
  return px;
}

function box(node: Node): { size: [number, number, number]; center: [number, number, number] } | null {
  if (typeof gltfCore.getBounds !== 'function') return null;
  let bounds;
  try { bounds = gltfCore.getBounds(node); } catch { return null; }
  const { min, max } = bounds;
  if (!min || !max) return null;
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (!size.every((v) => Number.isFinite(v))) return null;
  return {
    size,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

export function scanLods(doc: Document): LodScan | null {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  if (!scene) return null;

  const byMaterial = materialTextures(doc);
  const triCache = new Map<Node, number>();
  const triOf = (n: Node) => {
    let v = triCache.get(n);
    if (v === undefined) { v = triangles(n); triCache.set(n, v); }
    return v;
  };

  let nodes = 0;
  let levels = 0;
  let named = false;

  const consider = (children: Node[]) => {
    const withGeometry = children.filter((c) => triOf(c) > 0);
    if (withGeometry.length < 2) return;

    const cands: LodCandidate[] = [];
    for (const child of withGeometry) {
      const b = box(child);
      if (!b) return;
      cands.push({
        name: child.getName() || '',
        triangles: triOf(child),
        texturePixels: texturePixels(child, byMaterial),
        size: b.size,
        center: b.center,
      });
    }

    const group = groupLevels(cands);
    if (!group) return;
    nodes++;
    levels = Math.max(levels, group.order.length);
    if (group.source === 'names') named = true;
  };

  consider(scene.listChildren());
  for (const child of scene.listChildren()) walk(child, (n) => consider(n.listChildren()));

  if (!nodes) return null;
  return { source: named ? 'names' : 'measured', nodes, levels };
}
