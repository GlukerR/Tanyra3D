import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import fs from 'node:fs';
import path from 'node:path';
import * as fns from '@gltf-transform/functions';

import { optimizeFile } from '../optimize2.mjs';
import { orderRules } from '../core/engine.mjs';
import { localizeResult, render } from '../core/i18n.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { REPO_MODELS, modelPath, isPresent } from './helpers/model-files.mjs';
import { sourcePath } from './helpers/source-files.mjs';


const ADVANCED = Object.keys(gltfAddon.ADVANCED_FEATURES).filter((f) => f !== 'safe');
export const FLAG_SETS = [
  [],
  ['safe'],
  ...ADVANCED.map((f) => ['safe', f]),
  ['safe', 'join', 'instance'],
];

export const LOCAL_MODELS = [
  'parkergirl.glb',
  'RiggedSimple.glb',
  'MosquitoInAmber2.glb',
  'BoomBox.glb',
  'chibi_zenitsu.glb',
  'Production Many Materials 01.glb',
  'SheenWoodLeatherSofa.glb',
  'ToyCar.glb',
];
export const ALL_MODELS = [...REPO_MODELS, ...LOCAL_MODELS];

const ioPromise = gltfAddon.createIO();
const ruleById = new Map(RULES.map((r) => [r.meta.id, r]));


function eachMatrix(prefix, body, timeout = 120_000) {
  for (const name of ALL_MODELS) {
    for (const flags of FLAG_SETS) {
      const label = `${name} [${flags.join(',') || 'passthrough'}] — ${prefix}`;
      if (isPresent(name)) it(label, () => body(name, flags), timeout);
      else it.skip(`${label} [skipped: ${name} missing locally]`, () => {}, timeout);
    }
  }
}


const recId = (rec) => rec && rec.i18n && rec.i18n.text && rec.i18n.text.messageId;

const normOf = (flags) => gltfAddon.normalizeOpts({ advancedFeatures: flags, dryRun: true });

const gltfEn = (await import('../addons/gltf/messages/en.mjs')).default;
const gltfRu = (await import('../addons/gltf/messages/ru.mjs')).default;
const coreEn = (await import('../core/messages/en.mjs')).default;
const coreRu = (await import('../core/messages/ru.mjs')).default;
const CATALOG_KEYS = new Set([...Object.keys(gltfEn), ...Object.keys(gltfRu), ...Object.keys(coreEn), ...Object.keys(coreRu)]);

const EMITTED_IDS = new Set();

function collectEmitted(result) {
  for (const list of ['applied', 'skipped', 'findings', 'validation']) {
    for (const rec of result[list] || []) {
      const walk = (v) => {
        if (!v || typeof v !== 'object') return;
        if (typeof v.messageId === 'string') EMITTED_IDS.add(v.messageId);
        for (const x of Object.values(v)) walk(x);
      };
      walk(rec);
    }
  }
}

function staticMessageIds() {
  const files = [
    'addons/gltf/rules',
    'addons/gltf/index',
    'addons/gltf/importers',
    'core/engine',
    'core/contract',
  ].map(sourcePath);
  const out = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.resolve(f), 'utf8');
    for (const m of src.matchAll(/messageId:\s*'([^']+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/render\(\s*'([^']+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/vp\(\s*'(?:pass|info|fail)',\s*'([^']+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/titleKey:\s*'([^']+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/importError\(\s*'([^']+)'/g)) out.add(m[1]);
  }
  out.delete('pipeline');
  return out;
}


function checkResultShape(result, where, violations) {
  if (!['ok', 'fail', 'skip'].includes(result.status)) {
    violations.push(`[1·форма] status=${JSON.stringify(result.status)} не из {ok,fail,skip}`);
  }
  for (const k of ['applied', 'skipped', 'findings', 'validation']) {
    if (!Array.isArray(result[k])) violations.push(`[1·форма] ${k} не массив: ${typeof result[k]}`);
  }
  if (result.status === 'ok') {
    for (const m of ['before', 'after']) {
      const met = result.metrics && result.metrics[m];
      if (!met) {
        violations.push(`[1·форма] metrics.${m} отсутствует при status ok`);
        continue;
      }
      for (const [k, v] of Object.entries(met)) {
        if (v === null || v === undefined) violations.push(`[1·форма] metrics.${m}.${k} = ${v}`);
        else if (typeof v === 'number' && Number.isNaN(v)) violations.push(`[1·форма] metrics.${m}.${k} = NaN`);
      }
    }
  }
  if (result.status === 'fail') {
    const hasError = typeof result.error === 'string' && result.error.length > 0;
    const hasFail = Array.isArray(result.validation) && result.validation.some((v) => v && v.level === 'fail');
    if (!hasError && !hasFail) {
      violations.push(`[1·форма] status fail без причины: нет error и нет level:'fail' в validation`);
    }
  }
}


function checkDidOrExplained(result, flags, where, violations) {
  if (result.status === 'fail') return;
  const o = normOf(flags);
  const ruleIds = {
    applied: new Set((result.applied || []).map((a) => a.ruleId)),
    skipped: new Set((result.skipped || []).map((s) => s.ruleId)),
  };
  for (const rule of RULES) {
    const enabled = rule.meta.enabled(o);
    if (!enabled) {
      if (ruleIds.applied.has(rule.meta.id)) {
        violations.push(`[2·сделал-объяснил] ${rule.meta.id} НЕ включён, но оказался в applied (flags=[${flags.join(',')}])`);
      }
      continue;
    }
    if (!rule.meta.feature) continue;
    if (!ruleIds.applied.has(rule.meta.id) && !ruleIds.skipped.has(rule.meta.id)) {
      violations.push(`[2·сделал-объяснил] ${rule.meta.id} включён (feature=${rule.meta.feature}), но молча исчез — нет ни applied, ни skipped`);
    }
  }
  for (const s of result.skipped || []) {
    if (!recId(s)) {
      violations.push(`[2·сделал-объяснил] skipped-запись ${s.ruleId || '?'} без i18n.text.messageId (причины нет)`);
    }
  }
}


function checkI18n(result, where, violations) {
  for (const list of ['applied', 'skipped', 'findings', 'validation']) {
    for (const rec of result[list] || []) {
      const id = recId(rec);
      if (!id) {
        violations.push(`[3·i18n] ${list}-запись ${rec.ruleId || rec.level || '?'} без i18n.text.messageId`);
        continue;
      }
      const inEn = id in gltfEn || id in coreEn;
      const inRu = id in gltfRu || id in coreRu;
      if (!inEn || !inRu) {
        violations.push(`[3·i18n] messageId '${id}' нет в обоих каталогах (en:${inEn}, ru:${inRu})`);
        continue;
      }
      try {
        render(id, rec.i18n.text.data || {}, 'ru');
        render(id, rec.i18n.text.data || {}, 'en');
      } catch (e) {
        violations.push(`[3·i18n] render('${id}') бросает: ${e.message}`);
      }
    }
  }

  const ru = localizeResult(result, 'ru');
  const en = localizeResult(result, 'en');
  for (const list of ['applied', 'skipped', 'findings', 'validation']) {
    const a = result[list] || [];
    const b = ru[list] || [];
    const c = en[list] || [];
    if (a.length !== b.length || a.length !== c.length) {
      violations.push(`[3·i18n] localizeResult изменил длину ${list}: ${a.length} → ru ${b.length} / en ${c.length}`);
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      const rec = a[i];
      if (!recId(rec)) continue;
      if (b[i].i18n?.text?.messageId !== c[i].i18n?.text?.messageId) {
        violations.push(`[3·i18n] ru/en messageId разошлись в ${list}[${i}]`);
      }
      if (JSON.stringify(b[i].i18n?.text?.data) !== JSON.stringify(c[i].i18n?.text?.data)) {
        violations.push(`[3·i18n] ru/en data разошлись в ${list}[${i}]`);
      }
      if (b[i].text === c[i].text && b[i].text === rec.text) {
        violations.push(`[3·i18n] ${list}[${i}] текст не изменился при смене языка (рецепт есть, перевод не сработал)`);
      }
    }
  }
  const anyRecipe = ['applied', 'skipped', 'findings', 'validation'].some(
    (l) => (result[l] || []).some(recId),
  );
  if (anyRecipe) {
    const txt = (l) => (l || []).map((r) => r.text).join('|');
    const same = ['applied', 'skipped', 'findings', 'validation'].every(
      (l) => txt(ru[l]) === txt(en[l]),
    );
    if (same) violations.push('[3·i18n] ru и en тексты полностью совпали — перевод не работает');
  }
}


function checkOrder(flags, where, violations) {
  const ordered = orderRules(RULES).map((r) => r.meta.id);
  const pos = new Map(ordered.map((id, i) => [id, i]));
  for (const rule of RULES) {
    for (const dep of rule.meta.runAfter || []) {
      if (!pos.has(dep)) violations.push(`[6·порядок] ${rule.meta.id}.runAfter → неизвестный id '${dep}'`);
      else if (pos.get(dep) >= pos.get(rule.meta.id)) {
        violations.push(`[6·порядок] orderRules: ${dep} не раньше ${rule.meta.id} — runAfter нарушен`);
      }
    }
  }
  const applied = (resultOf(flags).applied || []).map((a) => a.ruleId);
  const execSkipped = (resultOf(flags).skipped || [])
    .filter((s) => !s.kind || s.kind === 'nothing' || s.kind === 'cost')
    .map((s) => s.ruleId);
  for (const [label, seq] of [['applied', applied], ['skipped(exec)', execSkipped]]) {
    let last = -1;
    for (const id of seq) {
      if (!pos.has(id)) continue;
      if (pos.get(id) < last) {
        violations.push(`[6·порядок] ${label}: ${id} идёт раньше, чем разрешает runAfter`);
      }
      last = Math.max(last, pos.get(id));
    }
  }
}

const _resultCache = new Map();
async function runOnce(name, flags) {
  const key = `${name}\u0000${JSON.stringify(flags)}`;
  if (!_resultCache.has(key)) {
    const outDir = tmpOutDir();
    try {
      const result = await optimizeFile(modelPath(name), { advancedFeatures: flags, dryRun: true, outDir });
      _resultCache.set(key, result);
    } finally {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {  }
    }
  }
  return _resultCache.get(key);
}
const resultOf = (flags) => _resultCache.get(`${currentName}\u0000${JSON.stringify(flags)}`);

let currentName = '';
describe('Контракт движка — матрица: форма · сделал-объяснил · переводимость · порядок', () => {
  eachMatrix('контракт', async (name, flags) => {
    currentName = name;
    const result = await runOnce(name, flags);
    const violations = [];
    const where = `${name} [${flags.join(',') || 'passthrough'}]`;
    checkResultShape(result, where, violations);
    checkDidOrExplained(result, flags, where, violations);
    checkI18n(result, where, violations);
    checkOrder(flags, where, violations);
    collectEmitted(result);
    expect(violations, `${where}:\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('матрица непустая: модели × наборы флагов', () => {
    expect(ALL_MODELS.length).toBeGreaterThanOrEqual(11);
    expect(FLAG_SETS.length).toBeGreaterThanOrEqual(10);
  });
});


function drawnTriangles(doc) {
  let triangles = 0;
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const ext = typeof node.getExtension === 'function' ? node.getExtension('EXT_mesh_gpu_instancing') : null;
      const sem = ext && ext.listSemantics && ext.listSemantics()[0];
      const attr = sem && ext.getAttribute(sem);
      const instances = (attr && attr.getCount()) || 1;
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() === 4) triangles += fns.getGLPrimitiveCount(prim) * instances;
      }
    });
  }
  return triangles;
}

function documentCounts(doc) {
  const root = doc.getRoot();
  let morphs = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      morphs += prim.listTargets().length;
    }
  }
  return {
    triangles: drawnTriangles(doc),
    meshes: root.listMeshes().length,
    nodes: root.listNodes().length,
    materials: root.listMaterials().length,
    animations: root.listAnimations().length,
    skins: root.listSkins().length,
    morphTargets: morphs,
  };
}

describe('Контракт движка — раздел 5: метрики не врут о записанном файле', () => {
  eachMatrix('метрики vs файл', async (name, flags) => {
    const outDir = tmpOutDir();
    try {
      const result = await optimizeFile(modelPath(name), { advancedFeatures: flags, dryRun: false, outDir });
      if (result.status !== 'ok' || !result.file.written) {
        return;
      }
      const io = await ioPromise;
      const doc = await io.read(result.file.dst);
      const dc = documentCounts(doc);
      const a = result.metrics && result.metrics.after;
      const violations = [];
      const where = `${name} [${flags.join(',') || 'passthrough'}]`;
      if (a.triangles !== dc.triangles) {
        violations.push(`[5·файл] triangles: метрика ${a.triangles}, файл ${dc.triangles}`);
      }
      for (const k of ['meshes', 'nodes', 'materials', 'animations', 'skins', 'morphTargets']) {
        if (a[k] !== dc[k]) violations.push(`[5·файл] ${k}: метрика ${a[k]}, документ ${dc[k]}`);
      }
      const disk = fs.statSync(result.file.dst).size;
      if (a.fileBytes !== disk) violations.push(`[5·файл] fileBytes: метрика ${a.fileBytes}, диск ${disk}`);
      expect(violations, `${where}:\n  ${violations.join('\n  ')}`).toEqual([]);
    } finally {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {  }
    }
  });
});


describe('Контракт движка — раздел 4: необратимость заявлена честно', () => {
  it('reversalNoteKey, если он есть, — непустой ключ', () => {
    const broken = RULES
      .filter((r) => r.meta.reversalNoteKey !== undefined && (typeof r.meta.reversalNoteKey !== 'string' || !r.meta.reversalNoteKey.trim()))
      .map((r) => r.meta.id);
    expect(broken).toEqual([]);
  });

  it('reversible:true не сочетается с dataLoss:"significant" (значимая потеря — необратимо)', () => {
    const reversibleButSignificant = RULES
      .filter((r) => r.meta.reversible === true && r.meta.dataLoss === 'significant')
      .map((r) => r.meta.id);
    expect(reversibleButSignificant).toEqual([]);
  });

  it('у каждого расширения профиля есть правило, и оно знает цену', () => {
    const profiles = fs.readdirSync('profiles').filter((f) => f.endsWith('.json')).sort();
    expect(profiles.length).toBeGreaterThan(0);

    const featureRule = (extId) => {
      if (extId === 'draco') return ruleById.get('geometry/compress');
      return RULES.find((r) => r.meta.feature === extId);
    };

    const problems = [];
    for (const pf of profiles) {
      const profile = JSON.parse(fs.readFileSync(path.join('profiles', pf), 'utf8'));
      for (const ext of profile.availableExtensions || []) {
        const rule = featureRule(ext.id);
        if (!rule) continue;

        for (const поле of ['reversible', 'dataLoss']) {
          if (поле in ext) {
            problems.push(`${pf}:${ext.id}.${поле} — факт правила ${rule.meta.id} снова скопирован в профиль`);
          }
        }
        if (typeof rule.meta.reversible !== 'boolean') {
          problems.push(`${pf}:${ext.id} — правило ${rule.meta.id} не говорит reversible`);
        }
        if (!['none', 'minor', 'significant'].includes(rule.meta.dataLoss)) {
          problems.push(`${pf}:${ext.id} — правило ${rule.meta.id} не говорит dataLoss`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});


const ORPHAN_EXCLUSIONS = {
  'vertexColors.found.white.many': 'собирается из vertexColors.found.white + .many (правило attributes/vertex-colors)',
  'vertexColors.found.painted.many': 'собирается из vertexColors.found.painted + .many',
  'vertexColors.done.white.many': 'собирается из vertexColors.done.white + .many',
  'vertexColors.stripped.many': 'собирается из vertexColors.stripped + .many',
  'vertexColors.skipped.many': 'собирается из vertexColors.skipped + .many',
  'ktx2.skipped.already.many': 'собирается из ktx2.skipped.already + .many',


  'ktx2.log.skipped': 'пишется в лог правила (ctx.log), не в отчёт',
  'ktx2.log.encoding': 'пишется в лог правила (ctx.log), не в отчёт',

  'report.title': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.meta': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.section.found': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.section.skipped': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.section.applied': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.section.validation': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.section.improvements': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.found.none': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.none': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.dryRun': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.notWritten': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.col.metric': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.col.before': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.col.after': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.file': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.gpuBytes': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.textureBytes': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.drawCalls': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.triangles': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.vertices': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.verticesStored': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.meshes': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.materials': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.textures': 'рамка .md-отчёта — writeReport, вне RunResult',
  'report.metric.nodes': 'рамка .md-отчёта — writeReport, вне RunResult',

  'reversal.join': 'meta.reversalNoteKey правила — вне записей отчёта',
  'reversal.instance': 'meta.reversalNoteKey правила — вне записей отчёта',
  'reversal.ktx2': 'meta.reversalNoteKey правила — вне записей отчёта',
  'reversal.webp': 'meta.reversalNoteKey правила — вне записей отчёта',
  'reversal.compress': 'meta.reversalNoteKey правила — вне записей отчёта',
  'reversal.quantize': 'meta.reversalNoteKey правила — вне записей отчёта',

  'feature.meshopt': 'подпись выбранного кодека в engine.feature.exclusive',
  'feature.draco': 'подпись выбранного кодека в engine.feature.exclusive',
  'feature.resize4096': 'подпись выбранного размера в engine.feature.exclusive',
  'feature.resize2048': 'подпись выбранного размера в engine.feature.exclusive',
  'feature.resize1024': 'подпись выбранного размера в engine.feature.exclusive',
  'feature.resize512': 'подпись выбранного размера в engine.feature.exclusive',

  'ktx2.invalid': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',
  'ktx2.hdr': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',
  'ktx2.multiface': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',
  'ktx2.transcodeStart': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',
  'ktx2.transcodeFailed': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',
  'ktx2.decodeFailed': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',

  'rule.attributesVertexColors': 'titleKey правила без meta.feature — рендерится только при отказе/пропуске правила',
  'rule.geometryWeld': 'titleKey правила без meta.feature — рендерится только при отказе/пропуске правила',
  'rule.geometryDegenerate': 'titleKey правила без meta.feature — рендерится только при отказе/пропуске правила',
  'rule.geometryOrphan': 'titleKey правила без meta.feature — рендерится только при отказе/пропуске правила',
};

describe('Контракт движка — раздел 3: ключей-сирот в каталогах нет', () => {
  it('каждый ключ каталога возвращается правилом или объяснён в исключениях', () => {
    const staticIds = staticMessageIds();
    const uncovered = [...CATALOG_KEYS]
      .filter((k) => !EMITTED_IDS.has(k) && !staticIds.has(k) && !(k in ORPHAN_EXCLUSIONS))
      .sort();
    expect(uncovered, `Ключи-сироты (нет ни в отчётах матрицы, ни в коде, ни в исключениях):\n  ${uncovered.join('\n  ')}`).toEqual([]);
  });

  it('каждый статически упомянутый messageId существует в каталоге (нет битых ссылок)', () => {
    const staticIds = staticMessageIds();
    const dangling = [...staticIds].filter((k) => !CATALOG_KEYS.has(k)).sort();
    expect(dangling, `messageId, на которые ссылается код, но которых нет в каталогах:\n  ${dangling.join('\n  ')}`).toEqual([]);
  });

  it('все исключения — реальные ключи каталога (опечатка в исключении ловится)', () => {
    const bogus = Object.keys(ORPHAN_EXCLUSIONS).filter((k) => !CATALOG_KEYS.has(k));
    expect(bogus).toEqual([]);
  });

  it('симметрия каталогов en↔ru не сломана (вспомогательная, см. locale-keys-symmetry)', () => {
    const gltfMissing = Object.keys(gltfEn).filter((k) => !(k in gltfRu));
    const ruMissing = Object.keys(gltfRu).filter((k) => !(k in gltfEn));
    const coreMissing = Object.keys(coreEn).filter((k) => !(k in coreRu));
    expect([...gltfMissing, ...ruMissing, ...coreMissing]).toEqual([]);
  });
});

afterAll(cleanupTmpOutDirs);
