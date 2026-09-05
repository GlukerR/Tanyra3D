import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

import gltfAddon from '../../addons/gltf/index.mjs';
import { effectiveSkins, sceneGeometry } from '../../addons/gltf/metrics.mjs';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { modelPath, REPO_MODELS } from './model-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'fixtures', 'models');

const KNOWN_EXTENSIONS = new Set(ALL_EXTENSIONS.map((e) => e.EXTENSION_NAME));

const HEAVY_BYTES = 50 * 1024 * 1024;

const EDGE_NAME_RE = /[а-яА-ЯёЁ]|\s|[^\x20-\x7E]/;

function readAssetJson(srcPath) {
  const buf = fs.readFileSync(srcPath);
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x46546c67) {
    let off = 12;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32LE(off);
      const type = buf.readUInt32LE(off + 4);
      if (type === 0x4e4f534a) return JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
      off += 8 + len;
    }
    return null;
  }
  return JSON.parse(buf.toString('utf8'));
}

function sharedMeshCount(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    let users = 0;
    for (const parent of mesh.listParents()) {
      if (parent.propertyType === 'Node') users += 1;
      if (users > 1) { n += 1; break; }
    }
  }
  return n;
}

function attributeSemantics(doc) {
  const out = new Set();
  for (const m of doc.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) for (const s of p.listSemantics()) out.add(s);
  }
  return out;
}

async function situationsOfFile(name) {
  const classes = [];
  if (EDGE_NAME_RE.test(name)) classes.push('edge-name');

  let json;
  try {
    if (fs.statSync(modelPath(name)).size > HEAVY_BYTES) classes.push('heavy');
    json = readAssetJson(modelPath(name));
  } catch {
    classes.push('broken');
    return classes;
  }

  const io = await gltfAddon.createIO();
  let doc;
  try {
    doc = await io.read(modelPath(name));
  } catch {
    classes.push('broken');
    return classes;
  }
  const root = doc.getRoot();
  const geo = sceneGeometry(doc);
  const textures = root.listTextures();
  const used = new Set(root.listExtensionsUsed().map((e) => e.extensionName));
  const declared = new Set(json.extensionsUsed || []);
  const unknown = [...declared].filter((x) => !KNOWN_EXTENSIONS.has(x));

  if (geo.triangles === 0) classes.push('no-geometry');
  if (textures.length === 0) classes.push('no-textures');
  if (textures.length > 0 && geo.triangles === 0) classes.push('textures-only');
  if (effectiveSkins(doc) >= 1) classes.push('skinned');
  if (geo.morphTargets >= 1) classes.push('morphed');
  if (root.listAnimations().length >= 1) classes.push('animated');
  if (sharedMeshCount(doc) >= 1) classes.push('shared-geometry');
  if (used.has('EXT_mesh_gpu_instancing')) classes.push('preinstanced');
  if (used.has('KHR_draco_mesh_compression')) classes.push('precompressed-draco');
  if (used.has('EXT_meshopt_compression')) classes.push('precompressed-meshopt');
  if (used.has('KHR_mesh_quantization')) classes.push('prequantized');
  const mimes = textures.map((t) => t.getMimeType() || '');
  if (mimes.includes('image/webp')) classes.push('pre-webp');
  if (mimes.includes('image/ktx2')) classes.push('pre-ktx2');
  if (attributeSemantics(doc).has('COLOR_0')) classes.push('vertex-colors');
  if (root.listScenes().length >= 2) classes.push('multi-scene');
  if (unknown.length) classes.push('unknown-extension');

  return classes;
}

const ALL_NAMES = fs.readdirSync(FIXTURES_DIR).filter((f) => /\.(glb|gltf)$/i.test(f));
const NAME_SITUATIONS = new Map();
const CLASSIFICATION = new Map();
for (const name of ALL_NAMES) {
  const sit = await situationsOfFile(name);
  NAME_SITUATIONS.set(name, sit);
  for (const c of sit) {
    if (!CLASSIFICATION.has(c)) CLASSIFICATION.set(c, []);
    CLASSIFICATION.get(c).push(name);
  }
}

export function situationsOf(modelName) {
  return NAME_SITUATIONS.get(modelName) || [];
}

export function modelsWith(classId) {
  return CLASSIFICATION.get(classId) || [];
}

export function eachSituation(classId, prefix, body, timeout) {
  const reps = modelsWith(classId);
  if (!reps.length) {
    it.skip(`${prefix} [${classId}: представитель класса отсутствует на диске]`, () => {}, timeout);
    return;
  }
  for (const m of reps) it(`${m} — ${prefix}`, () => body(m), timeout);
}

export const SITUATION_IDS = [
  'no-geometry', 'no-textures', 'textures-only', 'skinned', 'morphed', 'animated',
  'shared-geometry', 'preinstanced', 'precompressed-draco', 'precompressed-meshopt',
  'prequantized', 'pre-webp', 'pre-ktx2', 'vertex-colors', 'multi-scene',
  'unknown-extension', 'broken', 'heavy', 'edge-name',
];

export const KNOWN_HOLES = {
  heavy: 'нет модели >50 МБ в fixtures/: тяжёлые модели живут в input/ (стресс — tests/heavy-stress-input.test.mjs) и у клиентов, в fixtures не добавляем',
};

export function situationCoverage() {
  return SITUATION_IDS.map((id) => ({
    id,
    onDisk: modelsWith(id),
    inGit: modelsWith(id).filter((n) => REPO_MODELS.has(n)),
  }));
}

export const LOCAL_ONLY = {
};
