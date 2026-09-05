import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as fns from '@gltf-transform/functions';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';

import { render } from '../../core/i18n.mjs';

import type { Accessor, Document, Mesh, Node, Primitive, Texture } from '@gltf-transform/core';

import type { FixDecision, FixOut, GltfContext, GltfRule } from './types.mjs';
import type { Finding, Message } from '../../core/types.mjs';

interface TextureSlotFns {
  listTextureSlots: (tex: Texture) => string[];
}

interface WebpCandidate {
  tex: Texture;
  name: string;
  mime: string;
  isData: boolean;
  failed?: string;
  fromGpu?: boolean;
  lossless?: boolean;
  how?: Ceiling['how'];
  sourceQ?: number;
}

interface AssetJson {
  extensionsUsed?: string[];
  [key: string]: unknown;
}
import { decodeKtx2 } from './ktx2-decode.mjs';
import { instanceStatic, unbakeCopies } from './instance.mjs';
import { type Ceiling, probeWebpCeiling, readCeiling, targetQuality } from './source-quality.mjs';
import { readSourceJson } from './source-json.mjs';
import { importNote } from './import-notes.mjs';
import { scanLods } from './lod-scan.mjs';
import { deadSelectabilityNodes, readInteractivity } from './interactivity.mjs';
import { collectMetrics, countTriangles, effectiveSkins, listSemantics, textureSize } from './metrics.mjs';
import { dropUnusedExceptUv } from './prune-attributes.mjs';
import { HAS_GLTF_CLI, TOKTX, runCli } from './tools.mjs';
import { hasOpaqueExtension } from './carry.mjs';

const DATA_SLOT_RE = /normal|occlusion|roughness/i;
const DATA_SLOT_GLOB = '*{normal,Normal,occlusion,Occlusion,metallicRoughness,Roughness}*';

const WEBP_UNKNOWN_CEILING = 90;

const KTX2_REASONS = new Set([
  'ktx2.invalid',
  'ktx2.hdr',
  'ktx2.multiface',
  'ktx2.transcodeStart',
  'ktx2.transcodeFailed',
  'ktx2.decodeFailed',
]);

const WEBP_QUALITY_DEFAULT = 100;

function webpShare(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return WEBP_QUALITY_DEFAULT;
  return Math.min(100, Math.max(0, Math.round(n)));
}

const COLOR_SLOT_RE = /color|emissive/i;

function isColorTexture(tex: Texture, listSlots: (tex: Texture) => string[]): boolean {
  const declared = tex.getGraph().listParentEdges(tex).some((e: { getAttributes: () => { isColor?: boolean } }) => e.getAttributes().isColor);
  return declared || COLOR_SLOT_RE.test(listSlots(tex).join(' '));
}

const KTX2_DFD_OFFSET_POS = 48;
const KHR_DF_PRIMARIES_UNSPECIFIED = 0;
const KHR_DF_TRANSFER_LINEAR = 1;
const KHR_DF_TRANSFER_SRGB = 2;

function relabelDataTextures(document: Document, functions: TextureSlotFns, out: { details: Message[] }): void {
  const relabeled = [];
  for (const tex of document.getRoot().listTextures()) {
    if (tex.getMimeType() !== 'image/ktx2') continue;
    if (isColorTexture(tex, functions.listTextureSlots)) continue;

    const image = tex.getImage();
    if (!image || image.byteLength < KTX2_DFD_OFFSET_POS + 4) continue;
    const buf = new Uint8Array(image);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dfd = view.getUint32(KTX2_DFD_OFFSET_POS, true);
    const transferPos = dfd + 14;
    if (!dfd || transferPos >= buf.length) continue;
    if (buf[transferPos] !== KHR_DF_TRANSFER_SRGB) continue;

    buf[transferPos] = KHR_DF_TRANSFER_LINEAR;
    buf[dfd + 13] = KHR_DF_PRIMARIES_UNSPECIFIED;
    tex.setImage(buf);
    relabeled.push(tex.getName() || functions.listTextureSlots(tex).join('+') || '—');
  }
  if (relabeled.length) {
    out.details.push({ messageId: 'ktx2.relabeled', data: { n: relabeled.length, list: relabeled.join(', ') } });
  }
}

const KNOWN_EXTENSIONS = new Set(ALL_EXTENSIONS.map((e) => e.EXTENSION_NAME));

const readAssetJson = (srcPath: string): AssetJson | null => readSourceJson(srcPath) as AssetJson | null;

function assetJson(ctx: GltfContext): AssetJson | null {
  const KEY = 'assetJson';
  if (ctx.cache && ctx.cache.has(KEY)) return ctx.cache.get(KEY) as AssetJson | null;
  let json: AssetJson | null;
  try {
    json = ctx.src ? readAssetJson(ctx.src) : null;
  } catch {
    json = null;
  }
  if (ctx.cache) ctx.cache.set(KEY, json);
  return json;
}

function unsupportedExtensions(ctx: GltfContext): string[] {
  const KEY = 'unsupportedExtensions';
  if (ctx.cache && ctx.cache.has(KEY)) return ctx.cache.get(KEY) as string[];
  const json = assetJson(ctx);
  const list = ((json && json.extensionsUsed) || []).filter((name: string) => !KNOWN_EXTENSIONS.has(name));
  if (ctx.cache) ctx.cache.set(KEY, list);
  return list;
}

function opaqueUnsupported(ctx: GltfContext): string[] {
  const KEY = 'opaqueUnsupported';
  if (ctx.cache && ctx.cache.has(KEY)) return ctx.cache.get(KEY) as string[];
  const list = hasOpaqueExtension(assetJson(ctx), unsupportedExtensions(ctx));
  if (ctx.cache) ctx.cache.set(KEY, list);
  return list;
}

function refuseIfOpaque(ctx: GltfContext): FixDecision | null {
  const list = opaqueUnsupported(ctx);
  if (!list.length) return null;
  return { safe: false, messageId: 'unsupportedExtension.refuse', data: { list: list.join(', '), n: list.length } };
}

function refuseIfUnsupported(ctx: GltfContext): FixDecision | null {
  const list = unsupportedExtensions(ctx);
  if (!list.length) return null;
  return { safe: false, messageId: 'unsupportedExtension.refuse', data: { list: list.join(', '), n: list.length } };
}

function refuseIfWouldEmptyScene(ctx: GltfContext): FixDecision | null {
  const root = ctx.document.getRoot();
  const nodes = root.listNodes();
  if (!nodes.length) return null;
  const hasDrawable = nodes.some((n: Node) => n.getMesh() || n.getCamera());
  if (hasDrawable) return null;
  return { safe: false, messageId: 'prune.refuse.wouldEmptyScene', data: { n: nodes.length } };
}

function sharedMeshes(document: Document): Set<Mesh> {
  const shared = new Set<Mesh>();
  for (const mesh of document.getRoot().listMeshes()) {
    let users = 0;
    for (const parent of mesh.listParents()) {
      if (parent.propertyType === 'Node') users++;
      if (users > 1) { shared.add(mesh); break; }
    }
  }
  return shared;
}

function variantMeshes(document: Document): Set<Mesh> {
  const kept = new Set<Mesh>();
  for (const mesh of document.getRoot().listMeshes()) {
    if (mesh.listPrimitives().some((p) => p.getExtension('KHR_materials_variants'))) kept.add(mesh);
  }
  return kept;
}


interface SkinSet {
  joints: Accessor;
  weights: Accessor;
}

function skinSets(prim: Primitive): SkinSet[] {
  const out: SkinSet[] = [];
  for (let n = 0; ; n++) {
    const joints = prim.getAttribute(`JOINTS_${n}`);
    const weights = prim.getAttribute(`WEIGHTS_${n}`);
    if (!joints || !weights) break;
    out.push({ joints, weights });
  }
  return out;
}

function forEachSkin(document: Document, visit: (sets: SkinSet[], vertices: number) => void): void {
  const ids = new Map<object, number>();
  const idOf = (o: object): number => {
    let id = ids.get(o);
    if (id === undefined) { id = ids.size; ids.set(o, id); }
    return id;
  };
  const seen = new Set<string>();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const sets = skinSets(prim);
      if (!sets.length) continue;
      const key = sets.map((s) => `${idOf(s.joints)}:${idOf(s.weights)}`).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      visit(sets, sets[0]!.joints.getCount());
    }
  }
}

function fitInside(width: number, height: number, target: number): [number, number] {
  const scale = target / Math.max(width, height);
  const snap = (value: number, limit: number) => Math.max(1, Math.min(limit, Math.round(value / 4) * 4));
  if (width >= height) return [target, snap(height * scale, height)];
  return [snap(width * scale, width), target];
}

const NORMALIZED_MAX: Record<number, number> = { 5121: 255, 5123: 65535 };

function normalizedMaxOf(acc: Accessor): number | null {
  if (!acc.getNormalized()) return null;
  return NORMALIZED_MAX[acc.getComponentType()] ?? null;
}

function writeNormalizedWeights(sets: SkinSet[], index: number, rows: number[][], sum: number): void {
  const max = normalizedMaxOf(sets[0]!.weights);
  if (max === null) {
    for (let s = 0; s < sets.length; s++) {
      sets[s]!.weights.setElement(index, rows[s]!.map((v) => v / sum));
    }
    return;
  }

  const flat: number[] = [];
  for (const row of rows) for (const v of row) flat.push(v);

  const exact = flat.map((v) => (v / sum) * max);
  const ints = exact.map((v) => Math.floor(v));
  let rest = max - ints.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) ints[order[k]!.i]! += 1;

  let at = 0;
  for (let s = 0; s < sets.length; s++) {
    const row = rows[s]!.map(() => ints[at++]! / max);
    sets[s]!.weights.setElement(index, row);
  }
}

function readWeights(sets: SkinSet[], index: number, rows: number[][]): number {
  let sum = 0;
  for (let s = 0; s < sets.length; s++) {
    const row = rows[s]!;
    row.length = 0;
    sets[s]!.weights.getElement(index, row);
    for (const v of row) sum += v;
  }
  return sum;
}

function isIdentityNode(node: Node): boolean {
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  return t[0] === 0 && t[1] === 0 && t[2] === 0
    && r[0] === 0 && r[1] === 0 && r[2] === 0 && r[3] === 1
    && s[0] === 1 && s[1] === 1 && s[2] === 1;
}

function animatedNodes(document: Document): Set<Node> {
  const out = new Set<Node>();
  for (const anim of document.getRoot().listAnimations()) {
    for (const channel of anim.listChannels()) {
      const target = channel.getTargetNode();
      if (target) out.add(target);
    }
  }
  return out;
}

function rowsFor(sets: SkinSet[]): number[][] {
  return sets.map(() => []);
}

const WEIGHT_SUM_EPS = 1e-6;

function weightsAreUnit(sets: SkinSet[], rows: number[][], sum: number): boolean {
  const max = normalizedMaxOf(sets[0]!.weights);
  if (max === null) return Math.abs(sum - 1) <= WEIGHT_SUM_EPS;
  let ints = 0;
  for (const row of rows) for (const v of row) ints += Math.round(v * max);
  return ints === max;
}

function quantizeOptions(document: Document): { quantizationVolume?: 'scene' } {
  return document.getRoot().listSkins().length > 0 ? { quantizationVolume: 'scene' } : {};
}

type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

async function attempt<T>(fn: () => Promise<T> | T): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const err = e as { message?: string } | null | undefined;
    return { ok: false, reason: (err && err.message) || String(e) };
  }
}

export const RULES: GltfRule[] = [
  {
    meta: {
      id: 'scene/lod-levels', category: 'scene', title: 'Levels of detail', titleKey: 'rule.sceneLodLevels',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: [],
      reversible: true, dataLoss: 'none',
      enabled: () => true,
    },
    analyze(ctx) {
      const json = assetJson(ctx);
      if (json && (json.extensionsUsed || []).includes('MSFT_lod')) {
        let nodes = 0;
        let deepest = 0;
        for (const node of (json.nodes || []) as Array<{ extensions?: Record<string, { ids?: unknown[] }> }>) {
          const ids = node.extensions?.['MSFT_lod']?.ids;
          if (!Array.isArray(ids) || !ids.length) continue;
          nodes++;
          deepest = Math.max(deepest, ids.length + 1);
        }
        if (nodes) return [{ messageId: 'lod.found', data: { nodes, levels: deepest } }];
      }

      const found = scanLods(ctx.document);
      if (!found) return [];
      const data = { nodes: found.nodes, levels: found.levels };
      if (found.source === 'names') return [{ messageId: 'lod.likelyNames', data }];
      return [{ messageId: 'lod.likelyMeasured', data }];
    },
  },

  {
    meta: {
      id: 'scene/interactivity', category: 'scene', title: 'Interactivity', titleKey: 'rule.sceneInteractivity',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: [],
      reversible: true, dataLoss: 'none',
      enabled: () => true,
    },
    analyze(ctx) {
      const found = readInteractivity(assetJson(ctx));
      if (!found) return [];
      const { clickable, handlers, animations, changes, silent } = found;
      const actions = animations + changes;
      const out: Finding[] = [];
      if (clickable) out.push({ messageId: 'interactivity.found', data: { clickable, handlers, actions } });
      else out.push({ messageId: 'interactivity.foundNoClicks', data: { handlers, actions } });
      if (silent) out.push({ messageId: 'interactivity.silentParts', data: { n: silent } });
      return out;
    },
  },

  {
    meta: {
      id: 'import/textures-attached', category: 'scene', title: 'Textures picked up from neighbouring files', titleKey: 'rule.importTexturesAttached',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: [],
      reversible: true, dataLoss: 'none',
      enabled: () => true,
    },
    analyze(ctx) {
      const note = importNote(ctx.document);
      if (!note || !note.attached.length) return [];
      const SLOT_NAME = {
        baseColor: { messageId: 'slot.baseColor', data: {} },
        normal: { messageId: 'slot.normal', data: {} },
        roughness: { messageId: 'slot.roughness', data: {} },
        metallic: { messageId: 'slot.metallic', data: {} },
        occlusion: { messageId: 'slot.occlusion', data: {} },
        emissive: { messageId: 'slot.emissive', data: {} },
      } as Record<string, { messageId: string; data: Record<string, unknown> }>;
      return note.attached.map((a) => ({
        messageId: 'import.textureAttached',
        data: { slot: SLOT_NAME[a.slot] ?? a.slot, file: a.file },
      }));
    },
  },

  {
    meta: {
      id: 'import/not-carried', category: 'scene', title: 'Not carried over from the source', titleKey: 'rule.importNotCarried',
      severity: 'warn', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: [],
      reversible: true, dataLoss: 'none',
      enabled: () => true,
    },
    analyze(ctx) {
      const note = importNote(ctx.document);
      if (!note) return [];

      const out: Finding[] = [];
      if (note.missingTextures.length) {
        out.push(note.missingTextures.length === 1
          ? { messageId: 'import.textureMissing', data: { name: note.missingTextures[0]! } }
          : { messageId: 'import.textureMissing.many', data: { n: note.missingTextures.length } });
      }
      if (note.animations) out.push({ messageId: 'import.animationsDropped', data: { n: note.animations } });
      if (note.skins) out.push({ messageId: 'import.skinsDropped', data: { n: note.skins } });
      return out;
    },
  },

  {
    meta: {
      id: 'scene/morph-targets', category: 'scene', title: 'Morph targets', titleKey: 'rule.sceneMorphTargets',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: [],
      reversible: true, dataLoss: 'none',
      enabled: () => true,
    },
    analyze(ctx) {
      const root = ctx.document.getRoot();

      let meshes = 0;
      let deepest = 0;
      for (const mesh of root.listMeshes()) {
        let most = 0;
        for (const prim of mesh.listPrimitives()) most = Math.max(most, prim.listTargets().length);
        if (!most) continue;
        meshes++;
        deepest = Math.max(deepest, most);
      }
      if (!meshes) return [];

      let animated = false;
      for (const anim of root.listAnimations()) {
        if (anim.listChannels().some((ch) => ch.getTargetPath() === 'weights')) { animated = true; break; }
      }

      return [{
        messageId: animated ? 'morph.found.animated' : 'morph.found.still',
        data: { meshes, forms: deepest },
      }];
    },
  },

  {
    meta: {
      id: 'structure/dedup', category: 'materials', title: 'Duplicate resources (dedup)', titleKey: 'rule.structureDedup',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: ['texture', 'material', 'accessor'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || { safe: true, messageId: 'dedup.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, acc: root.listAccessors().length };
      await ctx.document.transform(fns.dedup());
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, acc: root.listAccessors().length };
      const out: { found: Message[]; details: Message[] } = { found: [], details: [] };
      if (b.tex > a.tex) { out.found.push({ messageId: 'dedup.found.textures', data: { n: b.tex - a.tex } }); out.details.push({ messageId: 'dedup.done.textures', data: { n: b.tex - a.tex } }); }
      if (b.mat > a.mat) { out.found.push({ messageId: 'dedup.found.materials', data: { n: b.mat - a.mat } }); out.details.push({ messageId: 'dedup.done.materials', data: { n: b.mat - a.mat } }); }
      if (b.acc > a.acc) { out.found.push({ messageId: 'dedup.found.accessors', data: { n: b.acc - a.acc } }); out.details.push({ messageId: 'dedup.done.accessors', data: { n: b.acc - a.acc } }); }
      return out;
    },
  },

  {
    meta: {
      id: 'structure/prune-unused', category: 'scene', title: 'Unused resources (prune)', titleKey: 'rule.structurePruneUnused',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['structure/dedup'], touches: ['texture', 'material', 'accessor', 'node'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || refuseIfWouldEmptyScene(ctx) || { safe: true, messageId: 'prune.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const semBefore = listSemantics(ctx.document);
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      const держимРазвёртку = !!ctx.opts.keepUnusedUv;
      if (держимРазвёртку) dropUnusedExceptUv(ctx.document);
      await ctx.document.transform(fns.prune({ keepAttributes: держимРазвёртку, keepLeaves: false }));
      const semAfter = listSemantics(ctx.document);
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      const out: { found: Message[]; details: Message[] } = { found: [], details: [] };
      const removedSem = [...semBefore].filter((s) => !semAfter.has(s));
      if (removedSem.length === 1) {
        out.found.push({ messageId: 'prune.found.attribute', data: { sem: removedSem[0] } });
        out.details.push({ messageId: 'prune.done.attribute', data: { sem: removedSem[0] } });
      } else if (removedSem.length > 1) {
        const data = { n: removedSem.length, list: removedSem.join(', ') };
        out.found.push({ messageId: 'prune.found.attributes', data });
        out.details.push({ messageId: 'prune.done.attributes', data });
      }
      if (b.tex > a.tex) { out.found.push({ messageId: 'prune.found.textures', data: { n: b.tex - a.tex } }); out.details.push({ messageId: 'prune.done.textures', data: { n: b.tex - a.tex } }); }
      if (b.mat > a.mat) { out.found.push({ messageId: 'prune.found.materials', data: { n: b.mat - a.mat } }); out.details.push({ messageId: 'prune.done.materials', data: { n: b.mat - a.mat } }); }
      if (b.skins > a.skins && b.effSkins === a.effSkins) {
        out.found.push({ messageId: 'prune.found.emptySkins', data: { n: b.skins - a.skins } });
        out.details.push({ messageId: 'prune.done.emptySkins', data: { n: b.skins - a.skins } });
      }
      return out;
    },
  },

  {
    meta: {
      id: 'attributes/vertex-colors', category: 'attributes', title: 'Vertex colors (COLOR_n)', titleKey: 'rule.attributesVertexColors',
      severity: 'warn', fixSafety: 'numeric', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['accessor'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe || o.stripColors,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      return { safe: true, messageId: 'vertexColors.safe', data: {} };
    },
    fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      const el: number[] = [];
      const buckets = new Map<string, { sem: string; kind: string; meshes: string[] }>();
      const note = (sem: string, kind: string, meshName: string) => {
        const key = `${sem}|${kind}`;
        if (!buckets.has(key)) buckets.set(key, { sem, kind, meshes: [] });
        buckets.get(key)!.meshes.push(meshName);
      };
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          for (const sem of prim.listSemantics()) {
            if (!sem.startsWith('COLOR_')) continue;
            const acc = prim.getAttribute(sem);
            let allWhite = true;
            const n = acc!.getCount();
            for (let i = 0; i < n; i++) {
              acc!.getElement(i, el);
              if (el.some((v: number) => v < 0.999)) { allWhite = false; break; }
            }
            const meshName = mesh.getName() || '—';
            if (allWhite) {
              prim.setAttribute(sem, null);
              note(sem, 'white', meshName);
            } else if (ctx.opts.stripColors) {
              prim.setAttribute(sem, null);
              note(sem, 'stripped', meshName);
            } else {
              note(sem, 'painted', meshName);
            }
          }
        }
      }
      for (const b of buckets.values()) {
        const one = b.meshes.length === 1;
        const data = one
          ? { sem: b.sem, mesh: b.meshes[0] }
          : { sem: b.sem, n: b.meshes.length, list: b.meshes.join(', ') };
        const id = (base: string) => (one ? base : `${base}.many`);
        if (b.kind === 'white') {
          out.found.push({ messageId: id('vertexColors.found.white'), data });
          out.details.push({ messageId: id('vertexColors.done.white'), data });
        } else if (b.kind === 'stripped') {
          out.found.push({ messageId: id('vertexColors.found.painted'), data });
          out.irreversibleSafety = 'lossy';
          (out.irreversible ??= []).push({ messageId: id('vertexColors.stripped'), data });
        } else {
          out.found.push({ messageId: id('vertexColors.found.painted'), data });
          out.skipped.push({ messageId: id('vertexColors.skipped'), data });
        }
      }
      return out;
    },
  },

  {
    meta: {
      id: 'skin/joints-dedupe', category: 'geometry', title: 'Duplicate joint per vertex', titleKey: 'rule.skinJointsDedupe',
      severity: 'warn', fixSafety: 'provable', tier: 'basic', runAfter: ['attributes/vertex-colors'], touches: ['accessor'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'skinJoints.safe', data: {} }; },
    fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      let vertices = 0;
      let merged = 0;

      forEachSkin(ctx.document, (sets, count) => {
        const jrows = rowsFor(sets);
        const wrows = rowsFor(sets);
        for (let i = 0; i < count; i++) {
          for (let s = 0; s < sets.length; s++) {
            jrows[s]!.length = 0;
            sets[s]!.joints.getElement(i, jrows[s]!);
            wrows[s]!.length = 0;
            sets[s]!.weights.getElement(i, wrows[s]!);
          }
          const firstAt = new Map<number, [number, number]>();
          let touched = false;
          for (let s = 0; s < sets.length; s++) {
            for (let c = 0; c < jrows[s]!.length; c++) {
              const joint = jrows[s]![c]!;
              const weight = wrows[s]![c]!;
              if (weight === 0) continue;
              const seen = firstAt.get(joint);
              if (seen === undefined) { firstAt.set(joint, [s, c]); continue; }
              wrows[seen[0]]![seen[1]] = wrows[seen[0]]![seen[1]]! + weight;
              wrows[s]![c] = 0;
              jrows[s]![c] = 0;
              merged++;
              touched = true;
            }
          }
          if (!touched) continue;
          for (let s = 0; s < sets.length; s++) {
            sets[s]!.joints.setElement(i, jrows[s]!);
            sets[s]!.weights.setElement(i, wrows[s]!);
          }
          vertices++;
        }
      });

      if (vertices) {
        out.found.push({ messageId: 'skinJoints.found.duplicate', data: { n: vertices, joints: merged } });
        out.details.push({ messageId: 'skinJoints.done.duplicate', data: { n: vertices, joints: merged } });
      }
      return out;
    },
  },

  {
    meta: {
      id: 'skin/weights-normalize', category: 'geometry', title: 'Skin weights normalization', titleKey: 'rule.skinWeightsNormalize',
      severity: 'warn', fixSafety: 'numeric', tier: 'basic', runAfter: ['skin/joints-dedupe'], touches: ['accessor'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'skinWeights.safe', data: {} }; },
    fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      let fixed = 0;
      let zeroSum = 0;

      forEachSkin(ctx.document, (sets, count) => {
        const rows = rowsFor(sets);
        for (let i = 0; i < count; i++) {
          const sum = readWeights(sets, i, rows);
          if (!(sum > 0)) { zeroSum++; continue; }
          if (weightsAreUnit(sets, rows, sum)) continue;
          writeNormalizedWeights(sets, i, rows, sum);
          fixed++;
        }
      });

      if (fixed) {
        out.found.push({ messageId: 'skinWeights.found', data: { n: fixed } });
        out.details.push({ messageId: 'skinWeights.done', data: { n: fixed } });
      }
      if (zeroSum) out.skipped.push({ messageId: 'skinWeights.skipped.zeroSum', data: { n: zeroSum } });
      return out;
    },
  },

  {
    meta: {
      id: 'skin/zero-weight-joints', category: 'geometry', title: 'Joints referenced with zero weight', titleKey: 'rule.skinZeroWeightJoints',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['skin/weights-normalize'], touches: ['accessor'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'skinZeroJoints.safe', data: {} }; },
    fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      let cleared = 0;
      let vertices = 0;

      forEachSkin(ctx.document, (sets, count) => {
        const jrows = rowsFor(sets);
        const wrows = rowsFor(sets);
        for (let i = 0; i < count; i++) {
          let touched = false;
          for (let s = 0; s < sets.length; s++) {
            jrows[s]!.length = 0;
            sets[s]!.joints.getElement(i, jrows[s]!);
            wrows[s]!.length = 0;
            sets[s]!.weights.getElement(i, wrows[s]!);
            for (let c = 0; c < jrows[s]!.length; c++) {
              if (wrows[s]![c] !== 0 || jrows[s]![c] === 0) continue;
              jrows[s]![c] = 0;
              cleared++;
              touched = true;
            }
          }
          if (!touched) continue;
          for (let s = 0; s < sets.length; s++) sets[s]!.joints.setElement(i, jrows[s]!);
          vertices++;
        }
      });

      if (cleared) {
        out.found.push({ messageId: 'skinZeroJoints.found', data: { n: cleared, vertices } });
        out.details.push({ messageId: 'skinZeroJoints.done', data: { n: cleared, vertices } });
      }
      return out;
    },
  },

  {
    meta: {
      id: 'scene/skinned-mesh-root', category: 'scene', title: 'Skinned mesh outside the scene root', titleKey: 'rule.sceneSkinnedMeshRoot',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['skin/zero-weight-joints'], touches: ['node'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) {
      return refuseIfUnsupported(ctx) || { safe: true, messageId: 'skinnedRoot.safe', data: {} };
    },
    fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      const root = ctx.document.getRoot();
      const animated = animatedNodes(ctx.document);
      let moved = 0;
      let refused = 0;

      for (const node of root.listNodes()) {
        if (!node.getSkin() || !node.getMesh()) continue;
        const parent = node.getParentNode();
        if (!parent) continue;

        let provable = !node.listChildren().length && isIdentityNode(node);
        let top: Node = parent;
        for (let p: Node | null = parent; p && provable; p = p.getParentNode()) {
          top = p;
          if (!isIdentityNode(p) || animated.has(p)) provable = false;
        }
        if (!provable) { refused++; continue; }

        const scene = root.listScenes().find((s) => s.listChildren().includes(top));
        if (!scene) { refused++; continue; }

        parent.removeChild(node);
        scene.addChild(node);
        moved++;
      }

      if (moved) {
        out.found.push({ messageId: 'skinnedRoot.found', data: { n: moved } });
        out.details.push({ messageId: 'skinnedRoot.done', data: { n: moved } });
      }
      if (refused) out.skipped.push({ messageId: 'skinnedRoot.skipped.notProvable', data: { n: refused } });
      return out;
    },
  },

  {
    meta: {
      id: 'geometry/weld', category: 'geometry', title: 'Vertex weld', titleKey: 'rule.geometryWeld',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['skin/zero-weight-joints'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) { return refuseIfOpaque(ctx) || { safe: true, messageId: 'weld.safe', data: {} }; },
    async fix(finding, ctx) {
      ctx.cache.set('trianglesBeforeWeld', countTriangles(ctx.document));
      let vb = 0, va = 0;
      for (const m of ctx.document.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); if (pos) vb += pos.getCount(); }
      await ctx.document.transform(fns.weld());
      for (const m of ctx.document.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); if (pos) va += pos.getCount(); }
      if (vb > va) {
        return { found: [{ messageId: 'weld.found', data: { n: vb - va } }], details: [{ messageId: 'weld.done', data: { before: vb, after: va } }] };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'geometry/degenerate-triangles', category: 'geometry', title: 'Degenerate triangles', titleKey: 'rule.geometryDegenerate',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['geometry/weld'], touches: ['geometry'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'degenerate.safe', data: {} }; },
    fix(finding, ctx) {
      const trisBefore = countTriangles(ctx.document);
      const prims = [];
      const shareCount = new Map<object, number>();
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          if (prim.getMode() !== 4) continue;
          const indices = prim.getIndices();
          if (!indices) continue;
          prims.push(prim);
          shareCount.set(indices, (shareCount.get(indices) || 0) + 1);
        }
      }
      const patched = new Set();
      for (const prim of prims) {
        const indices = prim.getIndices()!;
        const pos = prim.getAttribute('POSITION');
        const p = pos ? pos.getArray() : null;
        const morphed = prim.listTargets().length > 0;
        const joints = prim.getAttribute('JOINTS_0');
        const weights = prim.getAttribute('WEIGHTS_0');
        const rigSame = (a: number, b: number): boolean => {
          for (const acc of [joints, weights]) {
            if (!acc) continue;
            const arr = acc.getArray();
            if (!arr) continue;
            const n = acc.getElementSize();
            for (let c = 0; c < n; c++) if (arr[a * n + c] !== arr[b * n + c]) return false;
          }
          return true;
        };
        const onePoint = (a: number, b: number): boolean => {
          if (a === b) return true;
          if (!p || morphed) return false;
          if (p[a * 3] !== p[b * 3] || p[a * 3 + 1] !== p[b * 3 + 1] || p[a * 3 + 2] !== p[b * 3 + 2]) return false;
          return rigSame(a, b);
        };
        const sharedAccessor = (shareCount.get(indices) || 1) > 1;
        const arr = indices.getArray()!;
        const out: number[] = [];
        let cutByPosition = false;
        for (let i = 0; i + 2 < arr.length; i += 3) {
          const a = arr[i]!, b = arr[i + 1]!, c = arr[i + 2]!;
          if (a === b || b === c || a === c) continue;
          if (onePoint(a, b) || onePoint(b, c) || onePoint(a, c)) { cutByPosition = true; continue; }
          out.push(a, b, c);
        }
        if (out.length === arr.length) { patched.add(indices); continue; }
        if (sharedAccessor && cutByPosition) {
          const own = indices.clone();
          own.setArray(new (arr.constructor as Uint32ArrayConstructor)(out));
          prim.setIndices(own);
          continue;
        }
        if (patched.has(indices)) continue;
        indices.setArray(new (arr.constructor as Uint32ArrayConstructor)(out));
        patched.add(indices);
      }
      const sceneRemoved = trisBefore - countTriangles(ctx.document);
      ctx.cache.set('degenerateRemoved', sceneRemoved);
      if (sceneRemoved > 0) {
        return {
          found: [{ messageId: 'degenerate.found', data: { n: sceneRemoved } }],
          details: [{ messageId: 'degenerate.done', data: { n: sceneRemoved } }],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'geometry/orphan-vertices', category: 'geometry', title: 'Orphan vertices', titleKey: 'rule.geometryOrphan',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['geometry/degenerate-triangles'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (typeof fns.compactPrimitive !== 'function') {
        return { safe: false, messageId: 'orphan.unavailable', data: {} };
      }
      return { safe: true, messageId: 'orphan.safe', data: {} };
    },
    fix(finding, ctx) {
      let before = 0;
      let after = 0;
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION');
          if (!pos || !prim.getIndices()) continue;
          before += pos.getCount();
          fns.compactPrimitive(prim);
          after += prim.getAttribute('POSITION')!.getCount();
        }
      }
      if (before > after) {
        return {
          found: [{ messageId: 'orphan.found', data: { n: before - after } }],
          details: [{ messageId: 'orphan.done', data: { n: before - after } }],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'scene/join', category: 'scene', title: 'Mesh join (flatten + join)', titleKey: 'rule.sceneJoin',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['geometry/orphan-vertices', 'scene/instance'], touches: ['geometry', 'node'],
      reversible: false, dataLoss: 'significant',
      reversalNoteKey: 'reversal.join',
      feature: 'join',
      enabled: (o) => o.join,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || { safe: true, messageId: 'join.safe', data: {} }; },
    async fix(finding, ctx) {
      const m = () => { const r = collectMetrics(ctx.document, 0); return { drawCalls: r.drawCalls, nodes: r.nodes, meshes: r.meshes }; };
      const b = m();

      await ctx.document.transform(fns.flatten());
      const shared = sharedMeshes(ctx.document);
      const variants = variantMeshes(ctx.document);
      const spared = new Set([...shared, ...variants]);
      await ctx.document.transform(fns.join({ filter: (node) => !spared.has(node.getMesh()!) }));

      const a = m();

      const keptShared = shared.size
        ? [{ messageId: 'join.keptShared', data: { meshes: shared.size } }]
        : [];
      const keptVariants = variants.size
        ? [{ messageId: 'join.keptVariants', data: { meshes: variants.size } }]
        : [];

      if (b.drawCalls > a.drawCalls || b.nodes > a.nodes || b.meshes > a.meshes) {
        const details = [{ messageId: 'join.done', data: { dcBefore: b.drawCalls, dcAfter: a.drawCalls, nodesBefore: b.nodes, nodesAfter: a.nodes } }];
        return { found: [{ messageId: 'join.found', data: { drawCalls: b.drawCalls, nodes: b.nodes } }], details, skipped: [...keptShared, ...keptVariants] };
      }
      return { skipped: [...keptShared, ...keptVariants] };
    },
  },

  {
    meta: {
      id: 'scene/instance', category: 'scene', title: 'GPU instancing', titleKey: 'rule.sceneInstance',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['node', 'mesh'],
      reversible: true, dataLoss: 'none',
      reversalNoteKey: 'reversal.instance',
      feature: 'instance',
      enabled: (o) => o.instance,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || { safe: true }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = { nodes: root.listNodes().length, dc: collectMetrics(ctx.document, 0).drawCalls };
      const unbaked = unbakeCopies(ctx.document);
      const res = instanceStatic(ctx.document, { min: 2 });
      const a = { nodes: root.listNodes().length, dc: collectMetrics(ctx.document, 0).drawCalls };
      if (res.batches > 0) {
        const details: Message[] = [
          { messageId: 'instance.done', data: { dcBefore: b.dc, dcAfter: a.dc, nodesBefore: b.nodes, nodesAfter: a.nodes } },
        ];
        if (unbaked.merged) {
          details.push({ messageId: 'instance.unbaked', data: { n: unbaked.merged, groups: unbaked.groups } });
        }
        return { found: [{ messageId: 'instance.found', data: {} }], details };
      }
      return {
        skipped: [{
          messageId: res.animatedSkipped ? 'instance.skipped.animated' : 'instance.skipped.nothing',
          data: { n: res.animatedSkipped },
        }],
      };
    },
  },

  {
    meta: {
      id: 'interactivity/strip-dead', category: 'scene', title: 'Clickable marks with no handler', titleKey: 'rule.interactivityStripDead',
      severity: 'info', fixSafety: 'provable', tier: 'advanced', runAfter: [], touches: ['node'],
      reversible: false, dataLoss: 'significant',
      feature: 'strip-dead-interactivity',
      enabled: (o) => o.stripDeadInteractivity,
    },
    analyze(ctx) {
      const dead = deadSelectabilityNodes(assetJson(ctx)).length;
      if (!dead) return [{ messageId: 'pipeline', data: {} }];
      return [{ messageId: 'interactivityStripDead.found', data: { n: dead } }];
    },
    canFix() { return { safe: true }; },
    fix(finding, ctx) {
      const json = assetJson(ctx);
      const dead = deadSelectabilityNodes(json).length;
      if (!dead) return { skipped: [{ messageId: 'interactivityStripDead.skipped.none', data: {} }] };
      const left = (readInteractivity(json)?.clickable ?? 0) - dead;
      return { details: [{ messageId: 'interactivityStripDead.done', data: { n: dead, left } }] };
    },
  },

  {
    meta: {
      id: 'animation/resample', category: 'performance', title: 'Resample animations', titleKey: 'rule.animationResample',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['accessor'],
      reversible: false, dataLoss: 'none',
      feature: 'resample',
      enabled: (o) => o.resample,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      if (!root.listAnimations().length) return { skipped: [{ messageId: 'resample.skipped.noAnimations', data: {} }] };
      const bytes = () => root.listAccessors().reduce((s, a) => { const arr = a.getArray(); return s + (arr ? arr.byteLength : 0); }, 0);
      const before = bytes();
      await ctx.document.transform(fns.resample());
      const after = bytes();
      if (after < before) return { details: [{ messageId: 'resample.done', data: { pct: Math.round((before - after) / before * 100) } }] };
      return { skipped: [{ messageId: 'resample.skipped.minimal', data: {} }] };
    },
  },

  {
    meta: {
      id: 'structure/prune-final', category: 'scene', title: 'Cleanup of orphaned resources', titleKey: 'rule.structurePruneFinal',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['scene/join', 'geometry/orphan-vertices'], touches: ['accessor', 'node'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe || o.join || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || refuseIfWouldEmptyScene(ctx) || { safe: true, messageId: 'pruneFinal.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = root.listAccessors().length;
      const держимРазвёртку = !!ctx.opts.keepUnusedUv;
      if (держимРазвёртку) dropUnusedExceptUv(ctx.document);
      await ctx.document.transform(fns.prune({ keepAttributes: держимРазвёртку }));
      const a = root.listAccessors().length;
      const details: Message[] = [];
      if (держимРазвёртку) details.push({ messageId: 'prune.done.keptUv', data: {} });
      if (b > a) details.push({ messageId: 'pruneFinal.done', data: { n: b - a } });
      return details.length ? { details } : {};
    },
  },

  {
    meta: {
      id: 'textures/flat', category: 'textures', title: 'Single-colour textures', titleKey: 'rule.texturesFlat',
      severity: 'info', fixSafety: 'provable', tier: 'basic',
      runAfter: ['structure/dedup'], touches: ['texture'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'flat.safe', data: {} }; },
    async fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      const sharp = (await import('sharp')).default;

      let n = 0;
      let failed = 0;
      let vramSaved = 0;
      for (const tex of ctx.document.getRoot().listTextures()) {
        const img = tex.getImage();
        if (!img || !img.byteLength) continue;
        if (tex.getMimeType() === 'image/ktx2') continue;

        const res = await attempt(async () => {
          const meta = await sharp(Buffer.from(img)).metadata();
          const w = meta.width || 0;
          const h = meta.height || 0;
          if (w <= 1 && h <= 1) return null;
          const px = w * h;
          if (px > 4096 && img.byteLength / px > 0.05) return null;

          const stats = await sharp(Buffer.from(img)).stats();
          if (!stats.channels.every((c) => c.min === c.max)) return null;
          const one = await sharp(Buffer.from(img)).resize(1, 1, { kernel: 'nearest' }).png().toBuffer();
          return { one, w, h, channels: stats.channels.length };
        });
        if (!res.ok) { failed += 1; continue; }
        if (!res.value) continue;

        const { one, w, h, channels } = res.value;
        vramSaved += Math.round(w * h * channels * 4 / 3);
        tex.setImage(new Uint8Array(one)).setMimeType('image/png');
        n += 1;
      }

      if (failed) out.skipped.push({ messageId: 'flat.skipped.failed', data: { n: failed } });

      if (!n) return out;

      const mimesNow = ctx.document.getRoot().listTextures().map((t) => t.getMimeType());
      if (!mimesNow.some((m) => m === 'image/webp')) {
        for (const used of ctx.document.getRoot().listExtensionsUsed()) {
          if (used.extensionName === 'EXT_texture_webp') used.dispose();
        }
      }

      out.found.push({ messageId: 'flat.found', data: { n } });
      out.details.push({ messageId: 'flat.done', data: { n, vramMb: Math.round(vramSaved / 1048576) } });
      return out;
    },
  },

  {
    meta: {
      id: 'textures/resize', category: 'textures', title: 'Texture downscale', titleKey: 'rule.texturesResize',
      severity: 'warn', fixSafety: 'lossy', tier: 'advanced',
      featureGroup: 'texture-size',
      runAfter: ['structure/prune-final'], touches: ['texture'],
      reversible: false, dataLoss: 'significant',
      enabled: (o) => o.maxTextureSize > 0,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, force: true, messageId: 'resize.safe', data: {} }; },
    async fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      const target = ctx.opts.maxTextureSize;

      const RESIZABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

      const big: { tex: Texture; mime: string; w: number; h: number }[] = [];
      let compressed = 0;
      let unreadable = 0;

      for (const tex of ctx.document.getRoot().listTextures()) {
        const image = tex.getImage();
        const mime = tex.getMimeType();
        if (!image || !mime) continue;
        if (!RESIZABLE.has(mime)) { compressed++; continue; }
        const size = textureSize(image, mime);
        if (!size) { unreadable++; continue; }
        if (Math.max(size[0]!, size[1]!) <= target) continue;
        big.push({ tex, mime, w: size[0]!, h: size[1]! });
      }

      if (compressed) out.skipped.push({ messageId: 'resize.skipped.compressed', data: { n: compressed } });
      if (unreadable) out.skipped.push({ messageId: 'resize.skipped.unreadable', data: { n: unreadable } });
      if (!big.length) return out;

      const sharp = (await import('sharp')).default;
      let done = 0;
      let failed = 0;
      let bytesBefore = 0;
      let bytesAfter = 0;

      for (const c of big) {
        const before = c.tex.getImage()!;
        const res = await attempt(async () => {
          const [w, h] = fitInside(c.w, c.h, target);
          const pipeline = sharp(Buffer.from(before)).resize({ width: w, height: h, fit: 'fill' });
          const encoded = c.mime === 'image/png' ? await pipeline.png().toBuffer()
            : c.mime === 'image/jpeg' ? await pipeline.jpeg({ quality: 90 }).toBuffer()
              : await pipeline.webp({ quality: 90 }).toBuffer();
          c.tex.setImage(new Uint8Array(encoded));
          return encoded;
        });
        if (!res.ok) { failed++; continue; }
        bytesBefore += before.byteLength;
        bytesAfter += res.value.byteLength;
        done++;
      }

      if (done) {
        out.found.push({ messageId: 'resize.found', data: { n: done, px: target } });
        out.irreversibleSafety = 'lossy';
        (out.irreversible ??= []).push({
          messageId: 'resize.done',
          data: { n: done, px: target, kb: Math.max(0, Math.round((bytesBefore - bytesAfter) / 1024)) },
        });
      }
      if (failed) out.skipped.push({ messageId: 'resize.skipped.failed', data: { n: failed } });
      return out;
    },
  },

  {
    meta: {
      id: 'textures/ktx2', category: 'textures', title: 'Textures → KTX2/UASTC', titleKey: 'rule.texturesKtx2',
      severity: 'warn', fixSafety: 'perceptual', tier: 'advanced', feature: 'ktx2',
      runAfter: ['structure/prune-final', 'textures/resize'], touches: ['texture'],
      reversible: true, dataLoss: 'minor',
      reversalNoteKey: 'reversal.ktx2',
      enabled: (opts) => !opts.noKtx,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (!TOKTX || !HAS_GLTF_CLI) {
        return { safe: false, messageId: 'ktx2.noTools', data: {} };
      }
      return { safe: true, messageId: 'ktx2.safe', data: {} };
    },
    async fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      const imageBytes = () => {
        let n = 0;
        for (const tex of ctx.document.getRoot().listTextures()) {
          const img = tex.getImage();
          if (img) n += img.byteLength;
        }
        return n;
      };
      const imgBefore = imageBytes();
      const dataTex = [];
      const colorTex = [];
      const toPng = new Map();
      const alreadyKtx2 = [];
      let pngFailed = 0;
      for (const tex of ctx.document.getRoot().listTextures()) {
        const mime = tex.getMimeType();
        const name = tex.getName() || '';
        if (mime === 'image/ktx2') {
          alreadyKtx2.push(name || '—');
          continue;
        }
        if (mime === 'image/webp' || mime === 'image/jpeg') {
          const sharp = (await import('sharp')).default;
          const conv = await attempt(async () => {
            const png = await sharp(Buffer.from(tex.getImage()!)).png().toBuffer();
            tex.setImage(png);
            tex.setMimeType('image/png');
          });
          if (!conv.ok) { pngFailed++; continue; }
          toPng.set(mime, (toPng.get(mime) || 0) + 1);
        }
        const slots = fns.listTextureSlots(tex).join(' ');
        if (DATA_SLOT_RE.test(slots)) dataTex.push(name);
        else colorTex.push(name);
      }
      if (alreadyKtx2.length === 1) out.skipped.push({ messageId: 'ktx2.skipped.already', data: { name: alreadyKtx2[0] } });
      else if (alreadyKtx2.length > 1) out.skipped.push({ messageId: 'ktx2.skipped.already.many', data: { n: alreadyKtx2.length } });
      for (const [mime, n] of toPng) {
        out.details.push({ messageId: 'ktx2.done.toPng', data: { n, from: mime.replace('image/', '') } });
      }
      if (pngFailed) out.skipped.push({ messageId: 'ktx2.skipped.toPngFailed', data: { n: pngFailed } });
      const needKtx = dataTex.length + colorTex.length;
      if (needKtx === 0) {
        ctx.log(render('ktx2.log.skipped', {}, ctx.opts.locale));
        return out;
      }
      out.found.push({ messageId: 'ktx2.found', data: { n: needKtx } });
      const mixed = ctx.opts.texMode === 'mixed';
      ctx.log(render('ktx2.log.encoding', { n: needKtx, mixed }, ctx.opts.locale));
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-ktx2-'));
      const tmpA = path.join(tmpDir, `_tmp_${ctx.dstName}`);
      const tmpB = path.join(tmpDir, `_tmp2_${ctx.dstName}`);
      const tmpC = path.join(tmpDir, `_tmp3_${ctx.dstName}`);
      try {
        await ctx.io.write(tmpA, ctx.document);
        let cur = tmpA;
        if (mixed) {
          if (dataTex.length) { await runCli(['uastc', cur, tmpB, '--slots', DATA_SLOT_GLOB, '--level', '2', '--zstd', '18']); cur = tmpB; }
          if (colorTex.length) { await runCli(['etc1s', cur, tmpC, '--slots', `!(${DATA_SLOT_GLOB})`, '--quality', '255']); cur = tmpC; }
        } else {
          await runCli(['uastc', cur, tmpB, '--level', '2', '--zstd', '18']);
          cur = tmpB;
        }
        ctx.document = await ctx.io.read(cur);
        relabelDataTextures(ctx.document, fns, out);
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {  }
      }
      if (mixed) {
        const named = (list: string[]) => list.filter(Boolean).join(', ');
        if (colorTex.length) out.details.push({ messageId: 'ktx2.done.color', data: { n: colorTex.length, list: named(colorTex) } });
        if (dataTex.length) out.details.push({ messageId: 'ktx2.done.data', data: { n: dataTex.length, list: named(dataTex) } });
      } else {
        out.details.push({ messageId: 'ktx2.done.uastc', data: { n: needKtx } });
      }

      const imgAfter = imageBytes();
      if (imgBefore > 0 && imgAfter > imgBefore * 2) {
        out.cost = [{
          messageId: 'ktx2.grewFile',
          data: {
            beforeKb: Math.round(imgBefore / 1024),
            afterKb: Math.round(imgAfter / 1024),
            pct: Math.round((imgAfter - imgBefore) / imgBefore * 100),
          },
        }];
      }
      return out;
    },
  },

  {
    meta: {
      id: 'textures/webp', category: 'textures', title: 'Textures → WebP', titleKey: 'rule.texturesWebp',
      severity: 'warn', fixSafety: 'perceptual', tier: 'advanced', feature: 'webp',
      runAfter: ['structure/prune-final', 'textures/resize'], touches: ['texture'],
      reversible: true, dataLoss: 'minor',
      reversalNoteKey: 'reversal.webp',
      enabled: (opts) => !opts.noWebp,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'webp.safe', data: {} }; },
    async fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };

      const share = webpShare(ctx.opts.webpQuality);
      const atCeiling = share >= 100;

      const cands: WebpCandidate[] = [];
      let alreadyTarget = 0;
      for (const tex of ctx.document.getRoot().listTextures()) {
        const image = tex.getImage();
        if (!image || !image.byteLength) continue;
        if (atCeiling && tex.getMimeType() === 'image/webp') { alreadyTarget += 1; continue; }
        cands.push({
          tex,
          name: tex.getName() || '—',
          mime: tex.getMimeType() || '',
          isData: DATA_SLOT_RE.test(fns.listTextureSlots(tex).join(' ')),
        });
      }
      const reportAlreadyTarget = () => {
        if (alreadyTarget) out.details.push({ messageId: 'webp.alreadyTarget', data: { n: alreadyTarget } });
      };
      if (!cands.length) { reportAlreadyTarget(); return out; }

      const sharp = (await import('sharp')).default;

      const imageBytes = () => ctx.document.getRoot().listTextures()
        .reduce((sum, t) => sum + (t.getImage()?.byteLength || 0), 0);
      const gpuBytes = async (): Promise<number> => {
        const res = await attempt(() => {
          let total = 0;
          for (const t of fns.inspect(ctx.document).textures.properties) total += t.gpuSize || 0;
          return total;
        });
        return res.ok ? res.value : 0;
      };
      const bytesBefore = imageBytes();
      const vramBefore = await gpuBytes();

      await Promise.all(cands.map(async (c) => {
        const src = c.tex.getImage()!;
        const res = await attempt(async () => {
          let pipeline;
          if (c.mime === 'image/ktx2') {
            const { image, reason } = await decodeKtx2(src);
            if (!image) throw new Error(reason || 'ktx2.decodeFailed');
            c.fromGpu = true;
            pipeline = sharp(Buffer.from(image.data), {
              raw: { width: image.width, height: image.height, channels: 4 },
            });
          } else {
            pipeline = sharp(Buffer.from(src));
          }
          const ceiling = readCeiling(src, c.mime);
          if (ceiling.how === 'probe') {
            ceiling.q = await probeWebpCeiling(
              src.byteLength,
              (q) => sharp(Buffer.from(src)).webp({ quality: q }).toBuffer(),
            );
          }
          if (ceiling.how === 'unknown') ceiling.q = WEBP_UNKNOWN_CEILING;
          c.how = ceiling.how;
          if (ceiling.q !== null) c.sourceQ = ceiling.q;

          c.lossless = ceiling.how === 'lossless' && atCeiling;
          const q = targetQuality(ceiling, share);
          const encoded = await (c.lossless
            ? pipeline.webp({ lossless: true })
            : pipeline.webp(c.isData ? { quality: q, smartSubsample: true } : { quality: q })
          ).toBuffer();
          c.tex.setImage(new Uint8Array(encoded)).setMimeType('image/webp');
        });
        if (!res.ok) c.failed = res.reason;
      }));

      const ext = ctx.document.createExtension(EXTTextureWebP);
      const mimesNow = ctx.document.getRoot().listTextures().map((t) => t.getMimeType());
      if (mimesNow.some((m) => m === 'image/webp')) ext.setRequired(true);
      else ext.dispose();

      if (!mimesNow.some((m) => m === 'image/ktx2')) {
        for (const used of ctx.document.getRoot().listExtensionsUsed()) {
          if (used.extensionName === 'KHR_texture_basisu') used.dispose();
        }
      }

      const ok = cands.filter((c) => !c.failed);
      const color = ok.filter((c) => !c.isData);
      const data = ok.filter((c) => c.isData && c.lossless);
      const dataLossy = ok.filter((c) => c.isData && !c.lossless && c.how !== 'lossless');
      const dataByChoice = ok.filter((c) => c.isData && !c.lossless && c.how === 'lossless');
      const fromGpu = ok.filter((c) => c.fromGpu);
      const failed = cands.filter((c) => c.failed);

      reportAlreadyTarget();
      out.found.push({ messageId: 'webp.found', data: { n: cands.length } });

      const known = ok.filter((c) => c.sourceQ !== undefined && c.how !== 'unknown');
      if (known.length) {
        const qs = known.map((c) => c.sourceQ!);
        const min = Math.min(...qs);
        const max = Math.max(...qs);
        const qData = { n: known.length, q: min, min, max };
        if (min === max) out.details.push({ messageId: 'webp.sourceQuality', data: qData });
        else out.details.push({ messageId: 'webp.sourceQuality.range', data: qData });
      }
      const unknownCeiling = ok.filter((c) => c.how === 'unknown');
      if (unknownCeiling.length) {
        out.details.push({ messageId: 'webp.ceilingUnknown', data: { n: unknownCeiling.length, q: WEBP_UNKNOWN_CEILING } });
      }
      if (!atCeiling) out.details.push({ messageId: 'webp.quality', data: { share } });
      if (color.length) out.details.push({ messageId: 'webp.done.color', data: { n: color.length } });
      if (data.length) out.details.push({ messageId: 'webp.done.data', data: { n: data.length } });
      if (dataLossy.length) out.details.push({ messageId: 'webp.done.dataLossy', data: { n: dataLossy.length } });
      if (dataByChoice.length) out.details.push({ messageId: 'webp.done.dataByChoice', data: { n: dataByChoice.length, share } });
      if (fromGpu.length) out.details.push({ messageId: 'webp.done.fromGpu', data: { n: fromGpu.length } });
      for (const c of failed) {
        const known = c.failed && KTX2_REASONS.has(c.failed);
        out.skipped.push({
          messageId: 'webp.skipped.failed',
          data: { name: c.name, reason: known ? { messageId: c.failed!, data: {} } : c.failed },
        });
      }

      const cost: { messageId: string; data: Record<string, unknown> }[] = [];
      const bytesAfter = imageBytes();
      if (bytesBefore > 0 && bytesAfter > bytesBefore * 2) {
        cost.push({
          messageId: 'webp.grewFile',
          data: {
            beforeKb: Math.round(bytesBefore / 1024),
            afterKb: Math.round(bytesAfter / 1024),
            pct: Math.round((bytesAfter - bytesBefore) / bytesBefore * 100),
          },
        });
      }
      const vramAfter = await gpuBytes();
      if (vramBefore > 0 && vramAfter > vramBefore * 2) {
        cost.push({
          messageId: 'webp.grewVram',
          data: {
            beforeMb: Math.round(vramBefore / 1048576),
            afterMb: Math.round(vramAfter / 1048576),
            pct: Math.round((vramAfter - vramBefore) / vramBefore * 100),
          },
        });
      }
      if (cost.length) out.cost = cost;
      return out;
    },
  },

  {
    meta: {
      id: 'geometry/compress', category: 'geometry', title: 'Geometry compression', titleKey: 'rule.geometryCompress',
      severity: 'info', fixSafety: 'numeric', tier: 'advanced', runAfter: ['textures/ktx2', 'structure/prune-final'], touches: ['geometry', 'accessor'],
      reversible: true, dataLoss: 'none',
      reversalNoteKey: 'reversal.compress',
      feature: 'meshopt',
      enabled: (o) => o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'compress.safe', data: {} }; },
    async fix(finding, ctx) {
      if (ctx.opts.codec === 'draco') {
        await ctx.document.transform(fns.draco());
      } else {
        await ctx.document.transform(fns.meshopt({
          encoder: MeshoptEncoder,
          ...quantizeOptions(ctx.document),
        }));
      }
      return { details: [{ messageId: 'compress.done', data: { codec: ctx.opts.codec } }] };
    },
  },

  {
    meta: {
      id: 'geometry/quantize', category: 'geometry', title: 'Geometry quantization', titleKey: 'rule.geometryQuantize',
      severity: 'info', fixSafety: 'numeric', tier: 'advanced',
      runAfter: ['textures/ktx2', 'structure/prune-final'], touches: ['geometry', 'accessor'],
      reversible: true, dataLoss: 'minor',
      reversalNoteKey: 'reversal.quantize',
      feature: 'quantize',
      enabled: (o) => o.quantize,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'quantize.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();

      if (ctx.opts.compress) {
        return { skipped: [{ messageId: 'quantize.skipped.compressed', data: { codec: ctx.opts.codec } }] };
      }
      if (root.listExtensionsUsed().some((e) => e.extensionName === 'KHR_mesh_quantization')) {
        return { skipped: [{ messageId: 'quantize.skipped.already', data: {} }] };
      }

      const geomBytes = () => {
        let n = 0;
        for (const a of root.listAccessors()) n += a.getArray()?.byteLength || 0;
        return n;
      };
      const before = geomBytes();

      const hasSkins = root.listSkins().length > 0;
      await ctx.document.transform(fns.quantize(quantizeOptions(ctx.document)));

      const after = geomBytes();
      const details: Message[] = [{
        messageId: 'quantize.done',
        data: { pct: before > 0 ? Math.round((before - after) / before * 100) : 0 },
      }];
      if (hasSkins) details.push({ messageId: 'quantize.done.scene', data: {} });
      return { details };
    },
  },
];
