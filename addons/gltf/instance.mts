import { MathUtils, type Document, type Mesh, type Node, type Primitive, type vec3, type vec4 } from '@gltf-transform/core';
import { EXTMeshGPUInstancing } from '@gltf-transform/extensions';

export interface InstanceStaticOptions { min: number }

export interface InstanceStaticResult {
  batches: number;
  instances: number;
  animatedSkipped: number;
}

function movingNodes(doc: Document): Set<Node> {
  const targets = new Set<Node>();
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      if (node) targets.add(node);
    }
  }
  if (!targets.size) return targets;

  const moving = new Set<Node>();
  const walk = (node: Node) => {
    moving.add(node);
    for (const child of node.listChildren()) walk(child);
  };
  for (const node of targets) walk(node);
  return moving;
}

const hasVolume = (prim: Primitive) => !!prim.getMaterial()?.getExtension('KHR_materials_volume');
const hasScale = (node: Node) => !MathUtils.eq(node.getWorldScale(), [1, 1, 1]);

export function instanceStatic(doc: Document, { min }: InstanceStaticOptions): InstanceStaticResult {
  const root = doc.getRoot();
  const moving = movingNodes(doc);
  const ext = doc.createExtension(EXTMeshGPUInstancing);

  const out: InstanceStaticResult = { batches: 0, instances: 0, animatedSkipped: 0 };

  for (const scene of root.listScenes()) {
    const byMesh = new Map<Mesh, Node[]>();
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      if (node.getExtension('EXT_mesh_gpu_instancing')) return;
      if (node.getSkin()) return;
      if (moving.has(node)) { out.animatedSkipped++; return; }
      const list = byMesh.get(mesh) || [];
      list.push(node);
      byMesh.set(mesh, list);
    });

    const emptied: Node[] = [];
    for (const [mesh, nodes] of byMesh) {
      if (nodes.length < min) continue;
      if (mesh.listPrimitives().some(hasVolume) && nodes.some(hasScale)) continue;

      const buffer = mesh.listPrimitives()[0]!.getAttribute('POSITION')!.getBuffer();
      const acc = (type: 'VEC3' | 'VEC4', size: number) => doc.createAccessor()
        .setType(type).setArray(new Float32Array(size * nodes.length)).setBuffer(buffer);
      const translation = acc('VEC3', 3);
      const rotation = acc('VEC4', 4);
      const scale = acc('VEC3', 3);
      const batch = ext.createInstancedMesh()
        .setAttribute('TRANSLATION', translation)
        .setAttribute('ROTATION', rotation)
        .setAttribute('SCALE', scale);

      let needT = false, needR = false, needS = false;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        let t: vec3, r: vec4, s: vec3;
        translation.setElement(i, (t = node.getWorldTranslation()));
        rotation.setElement(i, (r = node.getWorldRotation()));
        scale.setElement(i, (s = node.getWorldScale()));
        if (!MathUtils.eq(t, [0, 0, 0])) needT = true;
        if (!MathUtils.eq(r, [0, 0, 0, 1])) needR = true;
        if (!MathUtils.eq(s, [1, 1, 1])) needS = true;
      }
      if (!needT) translation.dispose();
      if (!needR) rotation.dispose();
      if (!needS) scale.dispose();

      const batchNode = doc.createNode().setMesh(mesh).setExtension('EXT_mesh_gpu_instancing', batch);
      scene.addChild(batchNode);

      if (!needT && !needR && !needS) {
        batchNode.dispose();
        batch.dispose();
        continue;
      }

      for (const node of nodes) { node.setMesh(null); emptied.push(node); }
      out.batches++;
      out.instances += nodes.length;
    }

    pruneEmptied(emptied);
  }

  if (!ext.listProperties().length) ext.dispose();
  return out;
}

function pruneEmptied(nodes: Node[]): void {
  let node: Node | undefined;
  while ((node = nodes.pop())) {
    if (node.listChildren().length || node.getCamera() || node.getMesh()
      || node.getSkin() || node.listExtensions().length) continue;
    const parent = node.getParentNode();
    if (parent) nodes.push(parent);
    node.dispose();
  }
}

export interface UnbakeResult {
  groups: number;
  merged: number;
}

function shapeKey(mesh: Mesh): string | null {
  const prims = mesh.listPrimitives();
  if (prims.length !== 1) return null;
  const prim = prims[0]!;
  if (prim.listTargets().length) return null;
  if (prim.getAttribute('JOINTS_0')) return null;

  const pos = prim.getAttribute('POSITION');
  if (!pos || !pos.getCount()) return null;
  const o = pos.getElement(0, []);
  const parts: string[] = [String(prim.getMode()), prim.getMaterial()?.getName() ?? ''];
  const rel = new Float32Array(pos.getCount() * 3);
  for (let i = 0; i < pos.getCount(); i++) {
    const v = pos.getElement(i, []);
    rel[i * 3] = v[0]! - o[0]!;
    rel[i * 3 + 1] = v[1]! - o[1]!;
    rel[i * 3 + 2] = v[2]! - o[2]!;
  }
  parts.push(Buffer.from(rel.buffer, rel.byteOffset, rel.byteLength).toString('base64'));

  for (const name of prim.listSemantics().filter((n) => n !== 'POSITION').sort()) {
    const a = prim.getAttribute(name)!;
    const arr = a.getArray();
    parts.push(name, Buffer.from(arr!.buffer, arr!.byteOffset, arr!.byteLength).toString('base64'));
  }
  const idx = prim.getIndices();
  if (idx) {
    const arr = idx.getArray()!;
    parts.push('I', Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64'));
  }
  return parts.join('|');
}

function anchor(mesh: Mesh): vec3 {
  const v: number[] = [];
  mesh.listPrimitives()[0]!.getAttribute('POSITION')!.getElement(0, v);
  return [v[0]!, v[1]!, v[2]!];
}

function applyRS(node: Node, o: vec3): vec3 {
  const [x, y, z] = o;
  const s = node.getScale();
  const [qx, qy, qz, qw] = node.getRotation();
  const sx = x * s[0], sy = y * s[1], sz = z * s[2];
  const tx = 2 * (qy * sz - qz * sy);
  const ty = 2 * (qz * sx - qx * sz);
  const tz = 2 * (qx * sy - qy * sx);
  return [
    sx + qw * tx + (qy * tz - qz * ty),
    sy + qw * ty + (qz * tx - qx * tz),
    sz + qw * tz + (qx * ty - qy * tx),
  ];
}

export function unbakeCopies(doc: Document): UnbakeResult {
  const root = doc.getRoot();
  const out: UnbakeResult = { groups: 0, merged: 0 };

  const owners = new Map<Mesh, Node[]>();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const list = owners.get(mesh) || [];
    list.push(node);
    owners.set(mesh, list);
  }

  const byShape = new Map<string, Mesh[]>();
  for (const [mesh, nodes] of owners) {
    if (nodes.length !== 1) continue;
    if (nodes[0]!.listChildren().length) continue;
    if (nodes[0]!.getSkin()) continue;
    const key = shapeKey(mesh);
    if (!key) continue;
    const list = byShape.get(key) || [];
    list.push(mesh);
    byShape.set(key, list);
  }

  for (const meshes of byShape.values()) {
    if (meshes.length < 2) continue;
    const canon = meshes[0]!;
    const base = anchor(canon);
    out.groups++;
    for (let i = 1; i < meshes.length; i++) {
      const mesh = meshes[i]!;
      const node = owners.get(mesh)![0]!;
      const a = anchor(mesh);
      const o: vec3 = [a[0] - base[0], a[1] - base[1], a[2] - base[2]];
      const shift = applyRS(node, o);
      const t = node.getTranslation();
      node.setTranslation([t[0] + shift[0], t[1] + shift[1], t[2] + shift[2]]);
      node.setMesh(canon);
      mesh.dispose();
      out.merged++;
    }
  }
  return out;
}
