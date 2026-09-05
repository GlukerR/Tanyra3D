import fs from 'node:fs';
import path from 'node:path';

import * as gltfCore from '@gltf-transform/core';
import * as fns from '@gltf-transform/functions';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

import { AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline } from '../../core/contract.mjs';
import { loadCatalogs, render } from '../../core/i18n.mjs';
import {
  BASELINE_METRICS, BASELINE_SOFT, MB, collectMetrics, baselineSnapshot,
} from './metrics.mjs';
import { importForeign, isImportFormat, IMPORT_FORMATS } from './importers.mjs';
import { readSourceJson, sourceStamp } from './source-json.mjs';
import { deadSelectabilityNodes, readInteractivity } from './interactivity.mjs';
import { RULES } from './rules.mjs';
import { TOKTX } from './tools.mjs';
import { textureSlotsWire } from './media.mjs';
import { addressesNothing, arraysAddressedBy } from './carry.mjs';

import type { Document, NodeIO as NodeIOType } from '@gltf-transform/core';
import type { ExclusiveConflict, ReportArgs, ValidateArgs } from '../../core/types.mjs';
import type { GltfMetrics } from './metrics.mjs';
import type { ValidatorMessage } from 'gltf-validator';
import type { GltfContext, GltfOpts } from './types.mjs';

type GltfValidateArgs = Omit<ValidateArgs, 'ctx' | 'before' | 'after'> & {
  ctx: GltfContext;
  before: GltfMetrics;
  after: GltfMetrics;
};

type GltfReportArgs = Omit<ReportArgs, 'opts' | 'before' | 'after'> & {
  opts: GltfOpts;
  before: GltfMetrics;
  after: GltfMetrics;
};

type ExplainedMessage = ValidatorMessage & { explainedBy?: string };

type GroupedMessage = ExplainedMessage & { count: number; pointers: string[] };

interface HiddenRefs {
  bufferViews: Map<number, string>;
  buffers: Map<number, string>;
  accessors: Map<number, string>;
  images: Map<number, string>;
}

type GltfJson = Record<string, any>;

type InspectLike = ReturnType<typeof fns.inspect> | {
  scenes: { properties: unknown[] };
  meshes: { properties: unknown[] };
  materials: { properties: unknown[] };
  textures: { properties: unknown[] };
  animations: { properties: unknown[] };
};

type RawOpts = Record<string, unknown>;

interface ExclusiveGroupDef {
  ruleId: string;
  members: string[];
  priority: string[];
  enforce?: string[];
  titleKeys: Record<string, string>;
  engineExplains: string[];
}

await loadCatalogs(new URL('./messages/', import.meta.url));

const { NodeIO } = gltfCore;

let _ioPromise: Promise<NodeIOType> | null = null;
function createIO(): Promise<NodeIOType> {
  if (!_ioPromise) {
    _ioPromise = (async () => {
      await MeshoptEncoder.ready;
      await MeshoptDecoder.ready;
      return new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
          'draco3d.decoder': await draco3d.createDecoderModule(),
          'draco3d.encoder': await draco3d.createEncoderModule(),
          'meshopt.decoder': MeshoptDecoder,
          'meshopt.encoder': MeshoptEncoder,
        });
    })();
    _ioPromise.catch(() => { _ioPromise = null; });
  }
  return _ioPromise;
}

const ADVANCED_FEATURES = {
  safe: 'safe lossless cleanup: dedup, prune unused, weld, remove degenerate/orphan geometry',
  meshopt: 'Meshopt geometry compression',
  draco: 'Draco geometry compression (instead of Meshopt)',
  quantize: 'geometry quantization (KHR_mesh_quantization) — smaller geometry, no decoder needed',
  join: 'join meshes / flatten scene — fewer draw calls (structural, irreversible)',
  instance: 'GPU instancing (EXT_mesh_gpu_instancing) — repeated meshes as instances',
  resample: 'resample animations — drop redundant keyframes (lossless)',
  'strip-dead-interactivity': 'drop clickable marks with no handler in the behaviour graph (irreversible)',
  'keep-unused-uv': 'keep UV and other vertex data no material reads (for configurators)',
  ktx2: 'textures → KTX2 (needs browser/engine support)',
  webp: 'textures → WebP (EXT_texture_webp; smaller file, video memory unchanged)',
  'strip-colors': 'removal of painted vertex colors (lossy)',
  'resize-4096': 'downscale textures to 4096 px on the longer side (lossy)',
  'resize-2048': 'downscale textures to 2048 px on the longer side (lossy)',
  'resize-1024': 'downscale textures to 1024 px on the longer side (lossy)',
  'resize-512': 'downscale textures to 512 px on the longer side (lossy)',
};

const RESIZE_TARGETS: Record<string, number> = {
  'resize-4096': 4096,
  'resize-2048': 2048,
  'resize-1024': 1024,
  'resize-512': 512,
};

const EXCLUSIVE_FEATURES: Record<string, ExclusiveGroupDef> = {
  geometry: {
    ruleId: 'geometry/compress',
    members: ['meshopt', 'draco', 'quantize'],
    priority: ['draco', 'meshopt', 'quantize'],
    enforce: ['meshopt', 'draco'],
    titleKeys: { meshopt: 'feature.meshopt', draco: 'feature.draco', quantize: 'rule.geometryQuantize' },
    engineExplains: ['meshopt', 'draco'],
  },
  'texture-format': {
    ruleId: 'textures/webp',
    members: ['ktx2', 'webp'],
    priority: ['ktx2', 'webp'],
    enforce: ['ktx2', 'webp'],
    titleKeys: { ktx2: 'rule.texturesKtx2', webp: 'rule.texturesWebp' },
    engineExplains: ['ktx2', 'webp'],
  },
  'texture-size': {
    ruleId: 'textures/resize',
    members: ['resize-4096', 'resize-2048', 'resize-1024', 'resize-512'],
    priority: ['resize-4096', 'resize-2048', 'resize-1024', 'resize-512'],
    titleKeys: {
      'resize-4096': 'feature.resize4096',
      'resize-2048': 'feature.resize2048',
      'resize-1024': 'feature.resize1024',
      'resize-512': 'feature.resize512',
    },
    engineExplains: ['resize-4096', 'resize-2048', 'resize-1024', 'resize-512'],
  },
};

export function exclusiveGroups() {
  return Object.entries(EXCLUSIVE_FEATURES).map(([id, d]) => ({ id, members: [...d.members] }));
}

function enforceExclusives(adv: string[]): { adv: string[]; dropped: Map<string, string> } {
  const dropped = new Map<string, string>();
  for (const definition of Object.values(EXCLUSIVE_FEATURES)) {
    const enforce = definition.enforce;
    if (!enforce) continue;
    const asked = adv.filter((feature) => enforce.includes(feature));
    if (asked.length < 2) continue;
    const winner = asked[asked.length - 1]!;
    for (const loser of asked.slice(0, -1)) dropped.set(loser, winner);
  }
  return { adv: adv.filter((feature) => !dropped.has(feature)), dropped };
}

function exclusiveConflicts(requested: string[]): ExclusiveConflict[] {
  const conflicts: ExclusiveConflict[] = [];
  const asked = (feature: string) => requested.includes(feature);
  for (const [group, definition] of Object.entries(EXCLUSIVE_FEATURES)) {
    const selected = definition.enforce
      ? requested.filter((feature) => definition.enforce!.includes(feature)).pop()
      : definition.priority.find(asked);
    if (!selected) continue;
    const explains = definition.engineExplains || definition.members;
    const rejected = definition.members
      .filter((feature) => feature !== selected && asked(feature))
      .filter((feature) => explains.includes(feature));
    if (!rejected.length) continue;
    conflicts.push({
      group,
      ruleId: definition.ruleId,
      selected: { feature: selected, titleKey: definition.titleKeys[selected]! },
      rejected: rejected.map((feature) => ({ feature, titleKey: definition.titleKeys[feature]! })),
    });
  }
  return conflicts;
}

function normalizeOpts(opts: RawOpts = {}): GltfOpts {
  const adv = [...new Set(((opts.advancedFeatures as unknown[]) || []).map(String))];
  const unknown = adv.filter((f) => !(f in ADVANCED_FEATURES));
  if (unknown.length) {
    throw new Error(`Unknown advancedFeatures: ${unknown.join(', ')}. Available: ${Object.keys(ADVANCED_FEATURES).join(', ')}.`);
  }
  const allMembers = Object.values(EXCLUSIVE_FEATURES).flatMap((d) => d.members);
  const requestedCodecs = adv.filter((feature) => allMembers.includes(feature));
  if (opts.codec === 'draco' && !requestedCodecs.includes('draco')) requestedCodecs.push('draco');
  const codecAsked = EXCLUSIVE_FEATURES.geometry!.enforce!;
  if (opts.compress && opts.codec !== 'draco' && !requestedCodecs.some((f) => codecAsked.includes(f))) {
    requestedCodecs.push('meshopt');
  }

  const conflicts = exclusiveConflicts(requestedCodecs);
  const { dropped } = enforceExclusives(requestedCodecs);
  const kept = adv.filter((feature) => !dropped.has(feature));

  const rawQuality = opts.webpQuality;
  const webpQuality = (typeof rawQuality === 'number'
    || (typeof rawQuality === 'string' && rawQuality.trim() !== ''))
    ? Number(rawQuality)
    : undefined;

  const draco = kept.includes('draco') || (opts.codec === 'draco' && !dropped.has('draco'));
  const compress = draco || kept.includes('meshopt') || (!!opts.compress && !dropped.has('meshopt'));

  return {
    advancedFeatures: kept,
    exclusiveConflicts: conflicts,
    safe: kept.includes('safe') || !!opts.safe,
    compress,
    codec: draco ? 'draco' : 'meshopt',
    quantize: adv.includes('quantize') || !!opts.quantize,
    join: (adv.includes('join') || !!opts.join) && !opts.keepParts,
    instance: adv.includes('instance') || !!opts.instance,
    resample: adv.includes('resample') || !!opts.resample,
    keepUnusedUv: adv.includes('keep-unused-uv') || !!opts.keepUnusedUv,
    stripDeadInteractivity: adv.includes('strip-dead-interactivity') || !!opts.stripDeadInteractivity,
    texMode: opts.texMode === 'mixed' ? 'mixed' : 'uastc',
    keepParts: !!opts.keepParts,
    noKtx: kept.includes('ktx2') ? false : (typeof opts.noKtx === 'boolean' ? opts.noKtx : true),
    noWebp: kept.includes('webp') ? false : (typeof opts.noWebp === 'boolean' ? opts.noWebp : true),
    webpQuality,
    stripColors: !!opts.stripColors || adv.includes('strip-colors'),
    maxTextureSize: (() => {
      const chosen = ['resize-4096', 'resize-2048', 'resize-1024', 'resize-512']
        .find((f) => adv.includes(f));
      if (chosen) return RESIZE_TARGETS[chosen]!;
      const direct = Number(opts.maxTextureSize);
      return Object.values(RESIZE_TARGETS).includes(direct) ? direct : 0;
    })(),
    dryRun: !!opts.dryRun,
    locale: typeof opts.locale === 'string' ? opts.locale : 'en',
    outDir: path.resolve(String(opts.outDir || 'output')),
    force: !!opts.force,
    onProgress: typeof opts.onProgress === 'function' ? opts.onProgress as GltfOpts['onProgress'] : null,
    log: typeof opts.log === 'function' ? opts.log as GltfOpts['log'] : () => {},
  };
}

const OUTPUT_RENAME = new RegExp(`\\.(gltf|${IMPORT_FORMATS.join('|')})$`, 'i');

function outputName(src: string): string {
  return path.basename(src).replace(OUTPUT_RENAME, '.glb');
}

const SHAPE_ARRAYS = [
  'scenes', 'nodes', 'meshes', 'materials', 'accessors',
  'textures', 'images', 'samplers', 'skins', 'animations', 'cameras',
];

interface CarriedSpot {
  path: Array<string | number>;
  name: string;
  value: unknown;
}

interface Carried {
  used: string[];
  required: string[];
  spots: CarriedSpot[];
  shape: Record<string, number>;
  names: Record<string, Array<string | null>>;
}

const shapeOf = (json: Record<string, unknown>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of SHAPE_ARRAYS) out[k] = Array.isArray(json[k]) ? (json[k] as unknown[]).length : -1;
  return out;
};

const namesOf = (json: Record<string, unknown>): Record<string, Array<string | null>> => {
  const out: Record<string, Array<string | null>> = {};
  for (const k of SHAPE_ARRAYS) {
    const arr = json[k];
    if (!Array.isArray(arr)) continue;
    out[k] = arr.map((el) => {
      const name = (el as { name?: unknown } | null)?.name;
      return typeof name === 'string' && name ? name : null;
    });
  }
  return out;
};

const sourceJson = readSourceJson;

function collectCarried(json: Record<string, unknown>, dropDeadSelectability = false): Carried | null {
  const known = new Set(ALL_EXTENSIONS.map((e) => e.EXTENSION_NAME));
  const used = ((json.extensionsUsed as string[]) || []).filter((n) => !known.has(n));
  if (!used.length) return null;
  const unknown = new Set(used);
  const required = ((json.extensionsRequired as string[]) || []).filter((n) => unknown.has(n));
  const мертвы = dropDeadSelectability ? new Set(deadSelectabilityNodes(json)) : null;

  const spots: CarriedSpot[] = [];
  const walk = (value: unknown, at: Array<string | number>) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...at, i]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    const ext = obj.extensions;
    if (ext && typeof ext === 'object') {
      for (const [name, payload] of Object.entries(ext as Record<string, unknown>)) {
        if (!unknown.has(name)) continue;
        if (мертвы && name === 'KHR_node_selectability'
          && at.length === 2 && at[0] === 'nodes' && typeof at[1] === 'number'
          && мертвы.has(at[1])) continue;
        spots.push({ path: at, name, value: payload });
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k !== 'extensions') walk(v, [...at, k]);
    }
  };
  walk(json, []);

  const снято = мертвы && !spots.some((sp) => sp.name === 'KHR_node_selectability');
  const без = (list: string[]) => (снято ? list.filter((n) => n !== 'KHR_node_selectability') : list);

  return {
    used: без(used), required: без(required), spots, shape: shapeOf(json), names: namesOf(json),
  };
}

function withGlbJson(
  glb: Uint8Array,
  patch: (json: GltfJson, hasBinChunk: boolean) => boolean,
): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return glb;
  const jsonLen = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) return glb;
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  } catch {
    return glb;
  }

  const rest = glb.subarray(20 + jsonLen);
  if (!patch(json, rest.length > 0)) return glb;

  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(encoded.length / 4) * 4).fill(0x20);
  padded.set(encoded);

  const out = new Uint8Array(12 + 8 + padded.length + rest.length);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x46546c67, true);
  ov.setUint32(4, 2, true);
  ov.setUint32(8, out.length, true);
  ov.setUint32(12, padded.length, true);
  ov.setUint32(16, 0x4e4f534a, true);
  out.set(padded, 20);
  out.set(rest, 20 + padded.length);
  return out;
}

function restoreCarried(json: Record<string, unknown>, carried: Carried | undefined): boolean {
  if (!carried) return false;

  const after = shapeOf(json);
  const afterNames = namesOf(json);

  const keepsIndexes = (k: string) => {
    const было = carried.names[k];
    const стало = afterNames[k];
    if (было && стало && стало.length >= было.length
      && было.every((n, i) => n !== null && n === стало[i])) return true;
    return !(k in carried.shape) || carried.shape[k] === after[k];
  };

  const intact = (value: unknown) => {
    if (addressesNothing(value)) return true;
    const names = arraysAddressedBy(value);
    const keys = names ? [...names] : SHAPE_ARRAYS;
    return keys.every(keepsIndexes);
  };

  const resolve = (at: Array<string | number>): Record<string, unknown> | null => {
    let cur: unknown = json;
    for (const step of at) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = (cur as Record<string | number, unknown>)[step];
    }
    return cur && typeof cur === 'object' && !Array.isArray(cur)
      ? cur as Record<string, unknown>
      : null;
  };

  let touched = false;
  let refused = 0;
  for (const spot of carried.spots) {
    if (!intact(spot.value)) { refused++; continue; }
    const owner = resolve(spot.path);
    if (!owner) continue;
    const bag = (owner.extensions ||= {}) as Record<string, unknown>;
    if (!(spot.name in bag)) { bag[spot.name] = spot.value; touched = true; }
  }
  if (refused) {
    console.warn(`[gltf] carried extensions not restored: ${refused} (addressed arrays shifted)`);
  }

  const declared = Array.isArray(json.extensionsUsed) ? json.extensionsUsed as string[] : [];
  if (carried.used.some((n) => !declared.includes(n))) touched = true;

  if (!touched) return false;

  const addNames = (key: 'extensionsUsed' | 'extensionsRequired', names: string[]) => {
    if (!names.length) return;
    const list = Array.isArray(json[key]) ? json[key] as string[] : (json[key] = [] as string[]);
    for (const n of names) if (!list.includes(n)) list.push(n);
    (list as string[]).sort();
  };
  addNames('extensionsUsed', carried.used);
  addNames('extensionsRequired', carried.required);
  return true;
}

const load = (io: NodeIOType, src: string) => (
  isImportFormat(src) ? importForeign(src) : readOrExplain(io, src)
);

const readBytes = (io: NodeIOType, bytes: Uint8Array) => io.readBinary(bytes);

function dropEmptyArrays(json: GltfJson, hasBinChunk: boolean): boolean {
  let touched = false;
  for (const scene of json.scenes || []) {
    if (Array.isArray(scene.nodes) && scene.nodes.length === 0) { delete scene.nodes; touched = true; }
  }
  for (const node of json.nodes || []) {
    if (Array.isArray(node.children) && node.children.length === 0) { delete node.children; touched = true; }
  }

  const noBinChunk = !hasBinChunk;
  const noViews = !Array.isArray(json.bufferViews) || json.bufferViews.length === 0;
  const allBuffersEmpty = Array.isArray(json.buffers)
    && json.buffers.length > 0
    && json.buffers.every((b: unknown) => b && typeof b === 'object' && Object.keys(b).length === 0);
  if (noBinChunk && noViews && allBuffersEmpty) { delete json.buffers; touched = true; }

  return touched;
}

// works around library ordering
function fixExtensionTextures(json: GltfJson): boolean {
  const РАСШИРЕНИЕ: Record<string, string> = {
    'image/webp': 'EXT_texture_webp',
    'image/ktx2': 'KHR_texture_basisu',
  };
  const textures = json.textures as Array<Record<string, unknown>> | undefined;
  const images = json.images as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(textures) || !Array.isArray(images)) return false;

  let touched = false;
  for (const tex of textures) {
    const source = tex.source;
    if (typeof source !== 'number') continue;
    const mime = images[source]?.mimeType;
    const имя = typeof mime === 'string' ? РАСШИРЕНИЕ[mime] : undefined;
    if (!имя) continue;
    const exts = (tex.extensions || {}) as Record<string, unknown>;
    exts[имя] = { source };
    tex.extensions = exts;
    delete tex.source;
    const used = json.extensionsUsed as string[] | undefined;
    if (!Array.isArray(used)) json.extensionsUsed = [имя];
    else if (!used.includes(имя)) used.push(имя);
    touched = true;
  }
  return touched;
}

const writeBytes = async (
  io: NodeIOType,
  doc: Document,
  src?: string,
  opts?: { stripDeadInteractivity?: boolean },
) => {
  const bytes = await io.writeBinary(doc);
  const json = src ? sourceJson(src) : null;
  const carried = (json && collectCarried(json, !!opts?.stripDeadInteractivity)) || undefined;
  return withGlbJson(bytes, (out, hasBinChunk) => {
    const restored = restoreCarried(out, carried);
    const dropped = dropEmptyArrays(out, hasBinChunk);
    const fixed = fixExtensionTextures(out);
    return restored || dropped || fixed;
  });
};

function stripInputCompression(doc: Document): string[] {
  const stripped = [];
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression' || ext.extensionName === 'EXT_meshopt_compression') {
      stripped.push(ext.extensionName);
      ext.dispose();
    }
  }
  return stripped;
}

async function validate({ ctx, before, after, glbBytes, src, result, advancedPlannedIds, addFound, log }: GltfValidateArgs): Promise<void> {
  const v = result.validation;
  const locale = ctx.opts.locale;
  const vp = (level: 'pass' | 'info' | 'fail', messageId: string, data: Record<string, unknown> = {}) => v.push({
    level,
    text: render(messageId, data, locale),
    i18n: { text: { messageId, data } },
  });

  let materialsOk = true;
  for (const mesh of ctx.document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (mat && typeof mat.isDisposed === 'function' && mat.isDisposed()) materialsOk = false;
    }
  }

  if (before.triangles === 0) vp('info', 'check.geometryEmpty');
  else if (after.triangles > 0) vp('pass', 'check.geometryPresent');
  else vp('fail', 'check.geometryBroken');
  const trianglesBase = (ctx.cache.get('trianglesBeforeWeld') as number | undefined) ?? before.triangles;
  const degenerateRemoved = (ctx.cache.get('degenerateRemoved') as number | undefined) ?? 0;
  const triangleDelta = trianglesBase - after.triangles;
  if (triangleDelta === 0) vp('pass', 'check.trianglesUnchanged');
  else if (triangleDelta === degenerateRemoved) vp('info', 'check.trianglesDropped', { n: triangleDelta });
  else vp('fail', 'check.trianglesMismatch', { expected: trianglesBase - degenerateRemoved, got: after.triangles });
  for (const line of compareBaseline(ctx.baselineMetrics!, after, BASELINE_METRICS, { advancedPlannedIds, log, soft: BASELINE_SOFT })) {
    vp(line.level, line.messageId, line.data);
  }
  if (before.animations === after.animations) vp('pass', 'check.animationsPreserved', { n: after.animations });
  else vp('fail', 'check.animationsLost', { before: before.animations, after: after.animations });
  if (before.skins === after.skins) vp('pass', 'check.skinsPreserved', { n: after.skins });
  else vp('fail', 'check.skinsLost', { before: before.skins, after: after.skins });
  if (before.scenes === after.scenes) vp('pass', 'check.scenesPreserved', { n: after.scenes });
  else vp('fail', 'check.scenesLost', { before: before.scenes, after: after.scenes });
  const noGeometry = before.triangles === 0 && after.triangles === 0;
  if (noGeometry) {
    vp('info', 'check.boundsNoGeometry');
  } else if (before.bounds && after.bounds) {
    const diag = Math.hypot(...[0, 1, 2].map((i) => before.bounds!.max[i]! - before.bounds!.min[i]!));
    const eps = Math.max(1e-6, diag * 0.01);
    const ok = [0, 1, 2].every((i) =>
      Math.abs(before.bounds!.min[i]! - after.bounds!.min[i]!) <= eps && Math.abs(before.bounds!.max[i]! - after.bounds!.max[i]!) <= eps);
    if (ok) vp('pass', 'check.boundsUnchanged');
    else if (result.applied.some((a: { ruleId: string }) => a.ruleId === 'scene/instance')) {
      vp('info', 'check.boundsSkippedAfterInstance');
    } else if (after.skins > 0 && ctx.document.getRoot().listExtensionsUsed()
      .some((e: { extensionName: string }) => e.extensionName === 'KHR_mesh_quantization')) {
      vp('info', 'check.boundsSkinnedQuantized');
    } else vp('fail', 'check.boundsChanged');
  } else {
    vp('info', 'check.boundsNotComputed');
  }
  if (materialsOk) vp('pass', 'check.materialsResolve');
  else vp('fail', 'check.materialsBroken');
  try {
    const validator = await import('gltf-validator');
    const res = await validator.validateBytes(new Uint8Array(glbBytes));
    const errs = res.issues.numErrors;
    if (errs === 0) {
      vp('pass', 'check.validatorZeroErrors');
    } else {
      const inRes = await validator.validateBytes(new Uint8Array(fs.readFileSync(src)));
      const inErrs = inRes.issues.numErrors;
      if (inErrs > 0) addFound(ENGINE_META.inputValidation!, { messageId: 'engine.inputValidation.found', data: { n: inErrs } });
      if (errs <= inErrs) {
        vp('info', 'check.validatorErrorsRemain', { errs, inErrs });
        for (const m of res.issues.messages.filter((m) => m.severity === 0).slice(0, 3)) {
          vp('info', 'check.validatorExample', { code: m.code, pointer: m.pointer || '—' });
        }
      } else {
        vp('fail', 'check.validatorErrorsIncreased', { errs, inErrs });
      }
    }
  } catch {
    vp('info', 'check.validatorSkipped');
  }
}

function diffLine(label: string, before: number, after: number, fmt: (v: number) => string | number = (v) => v) {
  return `| ${label} | ${fmt(before)} | ${fmt(after)} |`;
}

const LEVEL_PREFIX: Record<string, string> = { pass: '✅', info: 'ℹ', fail: '❌' };

function writeReport({ name, result, before, after, assetWritten, opts }: GltfReportArgs): string {
  const report = result;
  const flags = (opts.keepParts ? ' · no join' : '')
    + (opts.noKtx ? ' · no KTX2' : ` · textures: ${opts.texMode}`)
    + (opts.stripColors ? ' · strip-vertex-colors' : '')
    + (opts.dryRun ? ' · **DRY-RUN**' : '');
  const t = (key: string, data: Record<string, unknown> = {}) => render(key, data, opts.locale);
  const lines = [
    `# ${t('report.title', { name })}`,
    '',
    t('report.meta', { date: new Date().toISOString().slice(0, 10), codec: opts.codec, tier: AUTOFIX_MAX_TIER, flags }),
    '',
    `## ${t('report.section.found')}`,
    '',
    ...(report.findings.length ? report.findings.map((f: { text: string }) => `- ✓ ${f.text}`) : [`- ${t('report.found.none')}`]),
    '',
    `## ${t('report.section.skipped')}`,
    '',
    ...(report.skipped.length ? report.skipped.map((s: { text: string }) => `- ${s.text}`) : [`- ${t('report.none')}`]),
    '',
    `## ${t('report.section.applied')}`,
    '',
    ...(report.applied.length ? report.applied.map((a: { text: string }) => `- ${a.text}`) : [`- ${t('report.none')}`]),
    '',
    `## ${t('report.section.validation')}`,
    '',
    ...report.validation.map((s: { level: string; text: string }) => `- ${LEVEL_PREFIX[s.level]} ${s.text}`),
    ...(assetWritten ? [] : [
      '',
      opts.dryRun ? t('report.dryRun') : t('report.notWritten'),
    ]),
    '',
    `## ${t('report.section.improvements')}`,
    '',
    `| ${t('report.col.metric')} | ${t('report.col.before')} | ${t('report.col.after')} |`,
    '|---|---|---|',
    diffLine(t('report.metric.file'), before.fileBytes, after.fileBytes, (v) => `${MB(v)} MB`),
    diffLine(t('report.metric.gpuBytes'), before.gpuBytes, after.gpuBytes, (v) => `${MB(v)} MB`),
    diffLine(t('report.metric.textureBytes'), before.textureBytes, after.textureBytes, (v) => `${MB(v)} MB`),
    diffLine(t('report.metric.drawCalls'), before.drawCalls, after.drawCalls),
    diffLine(t('report.metric.triangles'), before.triangles, after.triangles),
    diffLine(t('report.metric.vertices'), before.vertices, after.vertices),
    diffLine(t('report.metric.verticesStored'), before.verticesStored, after.verticesStored),
    diffLine(t('report.metric.meshes'), before.meshes, after.meshes),
    diffLine(t('report.metric.materials'), before.materials, after.materials),
    diffLine(t('report.metric.textures'), before.textures, after.textures),
    diffLine(t('report.metric.nodes'), before.nodes, after.nodes),
    '',
  ];
  const reportName = name.replace(/\.(glb|gltf)$/i, opts.dryRun ? '.dryrun.report.md' : '.report.md');
  fs.writeFileSync(path.join(opts.outDir, reportName), lines.join('\n'), 'utf8');
  return reportName;
}

function parseGltfJson(bytes: Buffer): GltfJson | null {
  try {
    const GLB_MAGIC = 0x46546c67;
    if (bytes.length >= 20 && bytes.readUInt32LE(0) === GLB_MAGIC) {
      const jsonLength = bytes.readUInt32LE(12);
      return JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
    }
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

function referencesHiddenInExtensions(json: GltfJson, unsupported: Set<string>): HiddenRefs {
  const refs: HiddenRefs = { bufferViews: new Map(), buffers: new Map(), accessors: new Map(), images: new Map() };
  const add = (kind: keyof HiddenRefs, index: unknown, ext: string) => { if (Number.isInteger(index)) refs[kind].set(index as number, ext); };

  if (unsupported.has('KHR_draco_mesh_compression')) {
    for (const mesh of json.meshes || []) {
      for (const prim of mesh.primitives || []) {
        const d = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
        if (d) add('bufferViews', d.bufferView, 'KHR_draco_mesh_compression');
      }
    }
  }
  if (unsupported.has('EXT_meshopt_compression')) {
    for (const bv of json.bufferViews || []) {
      const m = bv.extensions && bv.extensions.EXT_meshopt_compression;
      if (m) add('buffers', m.buffer, 'EXT_meshopt_compression');
    }
  }
  if (unsupported.has('EXT_mesh_gpu_instancing')) {
    for (const node of json.nodes || []) {
      const i = node.extensions && node.extensions.EXT_mesh_gpu_instancing;
      for (const idx of Object.values((i && i.attributes) || {})) add('accessors', idx, 'EXT_mesh_gpu_instancing');
    }
  }
  if (unsupported.has('KHR_texture_basisu')) {
    for (const tex of json.textures || []) {
      const b = tex.extensions && tex.extensions.KHR_texture_basisu;
      if (b) add('images', b.source, 'KHR_texture_basisu');
    }
  }
  return refs;
}

function explanationFor(message: ValidatorMessage, refs: HiddenRefs, json: GltfJson, unsupported: Set<string>): string | null {
  const pointer = String(message.pointer || '');

  if (message.code === 'UNUSED_OBJECT') {
    const hit = /^\/(bufferViews|buffers|accessors|images)\/(\d+)$/.exec(pointer);
    if (hit) return refs[hit[1] as keyof HiddenRefs].get(Number(hit[2])) || null;
    return null;
  }

  if (unsupported.has('KHR_texture_basisu')) {
    const images = json.images || [];
    const isKtx2 = (i: number) => images[i] && images[i].mimeType === 'image/ktx2';
    const mime = /^\/images\/(\d+)\/mimeType$/.exec(pointer);
    if (message.code === 'VALUE_NOT_IN_LIST' && mime && isKtx2(Number(mime[1]))) return 'KHR_texture_basisu';
    const img = /^\/images\/(\d+)$/.exec(pointer);
    if (message.code === 'IMAGE_UNRECOGNIZED_FORMAT' && img && isKtx2(Number(img[1]))) return 'KHR_texture_basisu';
  }
  return null;
}

function unsupportedExtName(message: ValidatorMessage): string | null {
  const hit = /'([^']+)'/.exec(message.message || '');
  return hit ? hit[1]! : null;
}

function explainValidatorBlindSpots(json: GltfJson | null, messages: ExplainedMessage[]): ExplainedMessage[] {
  if (!json || !messages.length) return messages;
  const unsupported = new Set<string>();
  for (const m of messages) {
    if (m.code !== 'UNSUPPORTED_EXTENSION') continue;
    const name = unsupportedExtName(m);
    if (name) unsupported.add(name);
  }
  if (!unsupported.size) return messages;

  const refs = referencesHiddenInExtensions(json, unsupported);
  return messages.map((m): ExplainedMessage => {
    if (m.code === 'UNSUPPORTED_EXTENSION') {
      const name = unsupportedExtName(m);
      return name ? { ...m, explainedBy: name } : m;
    }
    const by = explanationFor(m, refs, json, unsupported);
    return by ? { ...m, explainedBy: by } : m;
  });
}

const VALIDATION_EXAMPLES = 5;

function groupValidation(messages: ExplainedMessage[], examples: number = VALIDATION_EXAMPLES): GroupedMessage[] {
  const groups = new Map<string, GroupedMessage>();
  for (const m of messages) {
    if (!m) continue;
    const key = `${m.code}|${m.severity}|${m.explainedBy || ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { ...m, count: 0, pointers: [] };
      groups.set(key, g);
    }
    g.count += 1;
    if (g.pointers.length < examples && m.pointer) g.pointers.push(m.pointer);
  }
  return [...groups.values()];
}

const referencedCache = new Map<string, { uri: string; full: string }[]>();

function referencedResources(srcPath: string): { uri: string; full: string }[] {
  if (!/\.gltf$/i.test(srcPath)) return [];
  const stamp = sourceStamp(srcPath);
  const known = referencedCache.get(stamp);
  if (known) return known;
  const json: any = readSourceJson(srcPath);
  if (!json) return [];
  const dir = path.dirname(srcPath);
  const seen = new Set<string>();
  const out: { uri: string; full: string }[] = [];
  for (const item of [...(json.buffers || []), ...(json.images || [])]) {
    const uri = item && item.uri;
    if (!uri || typeof uri !== 'string' || /^data:/i.test(uri)) continue;
    let rel = uri;
    try { rel = decodeURIComponent(uri); } catch {  }
    const full = path.resolve(dir, rel);
    if (seen.has(full)) continue;
    seen.add(full);
    out.push({ uri, full });
  }
  referencedCache.clear();
  referencedCache.set(stamp, out);
  return out;
}

function sourceBytes(srcPath: string): number {
  const own = fs.statSync(srcPath).size;
  let extra = 0;
  for (const r of referencedResources(srcPath)) {
    try { extra += fs.statSync(r.full).size; } catch {  }
  }
  return own + extra;
}

function missingResources(srcPath: string): string[] {
  return referencedResources(srcPath).filter((r) => !fs.existsSync(r.full)).map((r) => r.uri);
}

async function readOrExplain(io: NodeIOType, srcPath: string) {
  try {
    return await io.read(srcPath);
  } catch (e: any) {
    const gone = missingResources(srcPath);
    if (!gone.length) throw e;
    const err: Error & { i18n?: { messageId: string; data: Record<string, unknown> } } =
      new Error(render('io.missingResources', { names: gone.join(', ') }));
    err.i18n = { messageId: 'io.missingResources', data: { names: gone.join(', ') } };
    err.cause = e;
    throw err;
  }
}

async function inspect(srcPath: string): Promise<Record<string, unknown>> {
  const io = await createIO();
  const bytes = fs.readFileSync(srcPath);
  const foreign = isImportFormat(srcPath);
  const doc = foreign ? await importForeign(srcPath) : await readOrExplain(io, srcPath);
  const asset = doc.getRoot().getAsset() || {};
  const extensions = doc.getRoot().listExtensionsUsed().map((e: { extensionName: string }) => e.extensionName);

  let rawGenerator = '';
  try { rawGenerator = parseGltfJson(bytes)?.asset?.generator || ''; } catch {  }

  let metadata: InspectLike = { scenes: { properties: [] }, meshes: { properties: [] }, materials: { properties: [] }, textures: { properties: [] }, animations: { properties: [] } };
  try { metadata = fns.inspect(doc); } catch {  }

  let validation: ExplainedMessage[] = [];
  if (foreign) return foreignInspect(doc, srcPath);
  try {
    const validator = await import('gltf-validator');
    const res = await validator.validateBytes(new Uint8Array(bytes));
    validation = (res && res.issues && res.issues.messages) || [];
    validation = explainValidatorBlindSpots(parseGltfJson(bytes), validation);
    validation = groupValidation(validation);
  } catch {  }

  let metrics = null;
  try { metrics = collectMetrics(doc, sourceBytes(srcPath)); } catch {  }

  let interactivity = null;
  try { interactivity = readInteractivity(parseGltfJson(bytes)); } catch {  }

  return {
    format: 'gltf',
    asset: { version: asset.version || '', generator: rawGenerator || asset.generator || '' },
    extensions,
    metadata,
    metrics,
    validation,
    interactivity,
  };
}

function foreignInspect(doc: Document, srcPath: string): Record<string, unknown> {
  let metadata: InspectLike = { scenes: { properties: [] }, meshes: { properties: [] }, materials: { properties: [] }, textures: { properties: [] }, animations: { properties: [] } };
  try { metadata = fns.inspect(doc); } catch {  }
  let metrics = null;
  try { metrics = collectMetrics(doc, fs.statSync(srcPath).size); } catch {  }
  return {
    format: 'gltf',
    sourceFormat: path.extname(srcPath).toLowerCase().replace(/^\./, ''),
    asset: { version: '', generator: '' },
    extensions: [],
    metadata,
    metrics,
    validation: [],
  };
}

function mimeFromUri(uri: string): string {
  const ext = (String(uri).split('.').pop() || '').toLowerCase();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    ktx2: 'image/ktx2', bin: 'application/octet-stream',
  }[ext] || 'application/octet-stream';
}

async function toJSON(srcPath: string): Promise<Record<string, unknown>> {
  const io = await createIO();
  const doc = isImportFormat(srcPath) ? await importForeign(srcPath) : await readOrExplain(io, srcPath);
  const { json, resources } = await io.writeJSON(doc, {});
  const inline = (uri: string, mime: string) => {
    const bytes = resources && resources[uri];
    if (!bytes) return uri;
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  };
  for (const b of json.buffers || []) if (b.uri) b.uri = inline(b.uri, 'application/octet-stream');
  for (const img of json.images || []) if (img.uri) img.uri = inline(img.uri, img.mimeType || mimeFromUri(img.uri));
  return json as unknown as Record<string, unknown>;
}

const gltfAddon = {
  formats: ['glb', 'gltf', ...IMPORT_FORMATS],
  rules: RULES,
  BASELINE_METRICS,
  ADVANCED_FEATURES,
  exclusiveGroups,
  textureSlots: textureSlotsWire,
  TOKTX,
  outputName,
  normalizeOpts,
  createIO,
  load,
  writeBytes,
  readBytes,
  collectMetrics,
  sourceBytes,
  baselineMetrics: baselineSnapshot,
  stripInputCompression,
  validate,
  writeReport,
  inspect,
  toJSON,
};

export default gltfAddon;
