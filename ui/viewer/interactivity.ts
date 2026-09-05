import * as THREE from "three";

import { isClickable, isHiddenInFile } from "../../core/interactivity-rules.mjs";

function hiddenByParent(obj: THREE.Object3D): boolean {
  for (let p = obj.parent; p; p = p.parent) if (!p.visible) return true;
  return false;
}

export interface InteractivePart {
  name: string;
  nodeIndex: number;
  object: THREE.Object3D;
}

type Association = { nodes?: number };

export function findInteractive(gltf: {
  parser?: {
    json?: Record<string, unknown>;
    associations?: Map<unknown, Association>;
  };
  scene?: THREE.Object3D;
}): InteractivePart[] {
  const json = gltf.parser?.json as { nodes?: Array<Record<string, unknown>> } | undefined;
  const assoc = gltf.parser?.associations;
  if (!json?.nodes || !assoc || !gltf.scene) return [];

  const нажимаемые = new Set<number>();
  json.nodes.forEach((node, i) => {
    if (isClickable(node['extensions'])) нажимаемые.add(i);
  });
  if (!нажимаемые.size) return [];

  const parts: InteractivePart[] = [];
  gltf.scene.traverse((obj) => {
    const at = assoc.get(obj)?.nodes;
    if (at === undefined || !нажимаемые.has(at)) return;
    parts.push({
      name: obj.name || (json.nodes?.[at]?.['name'] as string) || '',
      nodeIndex: at,
      object: obj,
    });
  });
  return parts;
}

export function applyNodeVisibility(gltf: {
  parser?: { json?: Record<string, unknown>; associations?: Map<unknown, Association> };
  scene?: THREE.Object3D;
}): number {
  const json = gltf.parser?.json as { nodes?: Array<Record<string, unknown>> } | undefined;
  const assoc = gltf.parser?.associations;
  if (!json?.nodes || !assoc || !gltf.scene) return 0;

  const спрятанные = new Set<number>();
  json.nodes.forEach((node, i) => {
    if (isHiddenInFile(node['extensions'])) спрятанные.add(i);
  });
  if (!спрятанные.size) return 0;

  let n = 0;
  gltf.scene.traverse((obj) => {
    const at = assoc.get(obj)?.nodes;
    if (at === undefined || !спрятанные.has(at)) return;
    obj.visible = false;
    n += 1;
  });
  return n;
}

export class InteractivityHighlight extends THREE.Group {
  readonly isHelper = true;

  readonly color: number;

  constructor(parts: readonly InteractivePart[], color = 0x4ade80) {
    super();
    this.name = 'InteractivityHighlight';
    this.color = color;
    for (const part of parts) {
      const box = new THREE.BoxHelper(part.object, color) as THREE.BoxHelper & { _part?: InteractivePart };
      box._part = part;
      const material = box.material as THREE.LineBasicMaterial;
      material.depthTest = false;
      material.transparent = true;
      material.opacity = 0.9;
      box.renderOrder = 999;
      this.add(box);
    }
  }

  flash(part: InteractivePart, ms = 450): void {
    const at = this.children.findIndex((c) => (c as THREE.BoxHelper & { _part?: unknown })._part === part);
    const box = (at >= 0 ? this.children[at] : null) as THREE.BoxHelper | null;
    if (!box) return;
    const material = box.material as THREE.LineBasicMaterial;
    material.color.setHex(0xffffff);
    setTimeout(() => {
      if (box.parent) material.color.setHex(this.color);
    }, ms);
  }

  sync(): void {
    for (const child of this.children) {
      const box = child as THREE.BoxHelper & { _part?: InteractivePart };
      const obj = box._part?.object;
      if (!obj) continue;
      const видно = obj.visible && !hiddenByParent(obj);
      box.visible = видно;
      if (видно) box.update();
    }
  }

  dispose(): void {
    for (const child of this.children) {
      const box = child as THREE.BoxHelper;
      box.geometry?.dispose();
      (box.material as THREE.Material | undefined)?.dispose();
    }
    this.clear();
  }
}
