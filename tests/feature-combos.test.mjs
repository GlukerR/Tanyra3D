import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import fs from 'node:fs';
import path from 'node:path';

import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import { TOKTX, HAS_GLTF_CLI } from '../addons/gltf/tools.mjs';
import { modelPath, eachModel } from './helpers/model-files.mjs';
import { densityViolations, DENSITY_LIMIT } from './helpers/report-density.mjs';

const RULES_FEATURES = [...new Set(RULES.map((r) => r.meta.feature).filter(Boolean))];
const FEATURES = [...new Set([...RULES_FEATURES, 'draco'])];
const GEOMETRY_CODECS = ['meshopt', 'draco', 'quantize'];
const TEXTURE_FORMATS = ['ktx2', 'webp'];
const STRUCTURE = ['join', 'instance'];

const PAIRS = [];
for (let i = 0; i < FEATURES.length; i++) {
  for (let j = i + 1; j < FEATURES.length; j++) {
    PAIRS.push([FEATURES[i], FEATURES[j]]);
  }
}

const TRIPLES = [];
for (const g of GEOMETRY_CODECS) {
  for (const t of TEXTURE_FORMATS) {
    for (const s of STRUCTURE) TRIPLES.push([g, t, s]);
  }
}

const MUTEX_PAIRS = [
  ['ktx2', 'webp'],
  ...GEOMETRY_CODECS.flatMap((a, i) => GEOMETRY_CODECS.slice(i + 1).map((b) => [a, b])),
];

const TOKTX_OK = Boolean(TOKTX && HAS_GLTF_CLI);

const featureRuleId = (f) => {
  if (f === 'draco') return 'geometry/compress';
  const rule = RULES.find((r) => r.meta.feature === f);
  return rule ? rule.meta.id : null;
};


const hasApplied = (result, ruleId) => (result.applied || []).some((a) => a.ruleId === ruleId);
const skippedOf = (result, ruleId) => (result.skipped || []).filter((s) => s.ruleId === ruleId);
const appliedOf = (result, ruleId) => (result.applied || []).filter((a) => a.ruleId === ruleId);
const PAIR_CORPUS = [
  'Dirty Cube 01.glb',
  'Instance Grid 01.glb',
  'Morph Cube 01.glb',
  'Vertex Colors 01.glb',
  'Meshopt Compressed Input 01.glb',
];
const LOCAL_CORPUS = ['parkergirl.glb', 'RiggedSimple.glb', 'chibi_zenitsu.glb'];

const METRIC_KEYS = ['fileBytes', 'drawCalls', 'triangles', 'vertices', 'morphTargets',
  'textureBytes', 'gpuBytes', 'meshes', 'materials', 'textures', 'nodes', 'scenes',
  'animations', 'skins'];

function metricNaNs(m) {
  if (!m) return ['metrics missing'];
  return METRIC_KEYS.filter((k) => !Number.isFinite(m[k]));
}

function runAfterViolations(result) {
  const ruleById = new Map(RULES.map((r) => [r.meta.id, r]));
  const appliedIds = (result.applied || []).map((a) => a.ruleId);
  const pos = new Map(appliedIds.map((id, i) => [id, i]));
  const bad = [];
  for (const [id, i] of pos) {
    const meta = ruleById.get(id);
    for (const dep of meta?.runAfter || []) {
      if (pos.has(dep) && pos.get(dep) > i) bad.push(`${id} раньше своей зависимости ${dep}`);
    }
  }
  return bad;
}

async function checkComboInvariants(model, flags, finder) {
  const result = await optimizeFile(modelPath(model), {
    outDir: tmpOutDir(),
    advancedFeatures: flags,
    dryRun: true,
  });

  expect(['ok', 'fail', 'skip']).toContain(result.status);
  if (result.status === 'fail' && !result.error) {
    // validation fail, expected
  }

  const beforeNaNs = metricNaNs(result.metrics?.before);
  const afterNaNs = metricNaNs(result.metrics?.after);
  expect(beforeNaNs, `${finder}: NaN в before: ${beforeNaNs.join(', ')}`).toEqual([]);
  expect(afterNaNs, `${finder}: NaN в after: ${afterNaNs.join(', ')}`).toEqual([]);

  if (result.metrics?.before && result.metrics?.after) {
    expect(result.metrics.after.triangles).toBeLessThanOrEqual(result.metrics.before.triangles);

    for (const k of ['skins', 'animations', 'morphTargets']) {
      expect(result.metrics.after[k], `${finder}: ${k} изменилось`).toBe(result.metrics.before[k]);
    }
  }

  const runAfterBad = runAfterViolations(result);
  expect(runAfterBad, `${finder}: нарушение runAfter: ${runAfterBad.join('; ')}`).toEqual([]);

  return result;
}
describe('Сочетания фич — инварианты на всех парах (28 пар × корпус)', () => {
  for (const [a, b] of PAIRS) {
    const flags = ['safe', a, b];
    for (const model of PAIR_CORPUS) {
      it(`${model} · [${flags.join(', ')}] — инварианты`, async () => {
        await checkComboInvariants(model, flags, `${model} [${flags.join(', ')}]`);
      }, 120_000);
    }
    eachModel(`[${flags.join(', ')}] — инварианты`, LOCAL_CORPUS, async (model) => {
      await checkComboInvariants(model, flags, `${model} [${flags.join(', ')}]`);
    });
  }
});

describe('Сочетания фич — взаимоисключающие пары, порядок решает', () => {
  for (const [a, b] of MUTEX_PAIRS) {
    it(`${a}+${b}: побеждает последний выбранный, проигравший назван по codec`, async () => {
      const outDir = tmpOutDir();
      const r1 = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
        advancedFeatures: ['safe', a, b], dryRun: true, outDir,
      });
      const r2 = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
        advancedFeatures: ['safe', b, a], dryRun: true, outDir,
      });
      expect(r1.metrics?.after?.fileBytes).toBeTypeOf('number');
      expect(r2.metrics?.after?.fileBytes).toBeTypeOf('number');

      const ruleA = featureRuleId(a);
      const ruleB = featureRuleId(b);
      const appliedA = hasApplied(r1, ruleA);
      const appliedB = hasApplied(r1, ruleB);

      if (a === 'ktx2' && b === 'webp') {
        if (!TOKTX_OK) {
          expect(appliedA).toBe(false);
          expect(appliedB).toBe(true);
          return;
        }
        expect(appliedA).toBe(false);
        expect(appliedB).toBe(true);
        expect((r1.skipped || []).some((s) => s.kind === 'exclusive' && s.feature === 'ktx2')).toBe(true);
      } else if (a === 'meshopt' && b === 'draco') {
        expect(appliedA || appliedB).toBe(true);
        const cases = [
          { r: r1, winner: 'draco', loser: 'meshopt', winnerKey: 'feature.draco' },
          { r: r2, winner: 'meshopt', loser: 'draco', winnerKey: 'feature.meshopt' },
        ];
        for (const c of cases) {
          expect(appliedOf(c.r, 'geometry/compress')[0]?.i18n?.text?.data?.codec).toBe(c.winner);
          const loser = (c.r.skipped || []).find((s) => s.feature === c.loser);
          expect(loser, `проигравший ${c.loser} обязан быть назван`).toBeTruthy();
          expect(loser.i18n?.text?.messageId).toBe('engine.skipped.line');
          expect(loser.i18n?.reason?.messageId).toBe('engine.feature.exclusive');
          expect(loser.i18n?.reason?.data?.selected?.messageId).toBe(c.winnerKey);
        }
      } else {
        const quantizeRule = a === 'quantize' ? ruleA : ruleB;
        const compressRule = a === 'quantize' ? ruleB : ruleA;
        expect(hasApplied(r1, compressRule)).toBe(true);
        expect(hasApplied(r1, quantizeRule)).toBe(false);
        const qSkips = skippedOf(r1, 'geometry/quantize');
        const q = qSkips.find((s) => s.i18n?.text?.messageId === 'quantize.skipped.compressed');
        expect(q, 'quantize обязан воздержаться с quantize.skipped.compressed').toBeTruthy();
        const winner = a === 'quantize' ? b : a;
        expect(q.i18n.text.data.codec).toBe(winner);
      }
    }, 120_000);
  }
});
const ioPromise = gltfAddon.createIO();

async function readOutput(dst) {
  const io = await ioPromise;
  const doc = await io.read(dst);
  return doc;
}

async function readOutputMetrics(dst) {
  const io = await ioPromise;
  const doc = await io.read(dst);
  return gltfAddon.collectMetrics(doc, fs.statSync(dst).size);
}

async function reportVsFileViolations(model, result, dst) {
  const out = [];
  const fileBytes = fs.statSync(dst).size;

  if (result.metrics?.after?.fileBytes !== fileBytes) {
    out.push(`metrics.after.fileBytes=${result.metrics?.after?.fileBytes} ≠ файл ${fileBytes}`);
  }

  const costRecords = (result.skipped || []).filter((s) => s.kind === 'cost');
  const grewFile = result.metrics?.after?.fileBytes > result.metrics?.before?.fileBytes;
  const grewVram = result.metrics?.after?.gpuBytes > result.metrics?.before?.gpuBytes;
  const bothTextureRules = ['textures/ktx2', 'textures/webp']
    .every((id) => (result.applied || []).some((a) => a.ruleId === id));

  for (const c of costRecords) {
    if (bothTextureRules) continue;
    const id = c.i18n?.text?.messageId || '';
    const claimsVram = id.endsWith('grewVram');
    if (!(claimsVram ? grewVram : grewFile)) {
      out.push(`cost «${id}» сообщил о росте, но ${claimsVram ? 'видеопамять' : 'файл'} не вырос`);
    }
  }

  if (result.metrics?.before && result.metrics?.after) {
    const claimedWin = result.metrics.after.fileBytes < result.metrics.before.fileBytes;
    if (claimedWin && fileBytes >= result.metrics.before.fileBytes) {
      out.push(`отчёт заявляет выигрыш (${result.metrics.before.fileBytes}→${result.metrics.after.fileBytes}), но файл ${fileBytes} не меньше входа`);
    }
    const claimedGrow = result.metrics.after.fileBytes > result.metrics.before.fileBytes;
    if (claimedGrow && fileBytes <= result.metrics.before.fileBytes) {
      out.push(`отчёт заявляет рост (${result.metrics.before.fileBytes}→${result.metrics.after.fileBytes}), но файл ${fileBytes} не больше входа`);
    }
  }

  const doc = await readOutput(dst);
  const root = doc.getRoot();
  const extUsed = new Set(root.listExtensionsUsed().map((e) => e.extensionName));
  const extReq = new Set(root.listExtensionsRequired().map((e) => e.extensionName));
  const texMimes = new Set(root.listTextures().map((t) => t.getMimeType()));

  for (const s of result.skipped || []) {
    const id = s.i18n?.text?.messageId;
    const data = s.i18n?.text?.data || {};
    if (id === 'quantize.skipped.compressed') {
      const codec = data.codec;
      const ext = codec === 'draco' ? 'KHR_draco_mesh_compression' : 'EXT_meshopt_compression';
      if (!extUsed.has(ext) && !extReq.has(ext)) out.push(`quantize.skipped.compressed(${codec}), но в файле нет ${ext}`);
    } else if (id === 'quantize.skipped.already') {
      if (!extUsed.has('KHR_mesh_quantization') && !extReq.has('KHR_mesh_quantization')) {
        out.push('quantize.skipped.already, но в файле нет KHR_mesh_quantization');
      }
    } else if (id && id.startsWith('ktx2.skipped.already')) {
      if (!texMimes.has('image/ktx2')) out.push(`${id}, но в файле нет image/ktx2`);
    } else if (id === 'webp.skipped.failed') {
      if (!data.name || !data.reason) out.push(`${id} без имени текстуры или причины`);
    }
  }

  for (const a of result.applied || []) {
    const id = a.i18n?.text?.messageId;
    const data = a.i18n?.text?.data || {};
    if (id === 'compress.done') {
      const ext = data.codec === 'draco' ? 'KHR_draco_mesh_compression' : 'EXT_meshopt_compression';
      if (!extUsed.has(ext) && !extReq.has(ext)) out.push(`compress.done(${data.codec}), но в файле нет ${ext}`);
    } else if (id === 'quantize.done') {
      if (!extUsed.has('KHR_mesh_quantization') && !extReq.has('KHR_mesh_quantization')) {
        out.push('quantize.done, но в файле нет KHR_mesh_quantization');
      }
    }
  }

  const fileMetrics = await readOutputMetrics(dst);
  if (result.metrics?.after && fileMetrics.triangles !== result.metrics.after.triangles) {
    out.push(`треугольники: отчёт ${result.metrics.after.triangles}, файл ${fileMetrics.triangles}`);
  }

  return out;
}
describe('Сочетания фич — отчёт не противоречит записанному файлу (dryRun:false)', () => {
  const FILE_COMBOS = [
    { model: 'Dirty Cube 01.glb', flags: ['safe', 'meshopt', 'quantize'] },
    { model: 'Dirty Cube 01.glb', flags: ['safe', 'ktx2', 'webp'] },
    { model: 'Dirty Cube 01.glb', flags: ['safe', 'ktx2', 'meshopt'] },
    { model: 'Dirty Cube 01.glb', flags: ['safe', 'draco', 'quantize'] },
    { model: 'Dirty Cube 01.glb', flags: ['safe', 'quantize', 'join'] },
    { model: 'Instance Grid 01.glb', flags: ['safe', 'join', 'instance'] },
    { model: 'Meshopt Compressed Input 01.glb', flags: ['safe', 'meshopt', 'quantize'] },
    { model: 'Vertex Colors 01.glb', flags: ['safe', 'webp', 'quantize'] },
  ];
  for (const { model, flags } of FILE_COMBOS) {
    it(`${model} · [${flags.join(', ')}] — отчёт vs файл`, async () => {
      const outDir = tmpOutDir();
      const result = await optimizeFile(modelPath(model), {
        advancedFeatures: flags,
        dryRun: false,
        outDir,
      });
      const dst = path.join(outDir, model);
      expect(fs.existsSync(dst), `файл не записан: ${dst}`).toBe(true);

      const violations = await reportVsFileViolations(model, result, dst);
      expect(violations, `${model} [${flags.join(', ')}]: ${violations.join('; ')}`).toEqual([]);
    }, 120_000);
  }
});

describe('Сочетания фич — сторож плотности на сочетаниях', () => {
  for (const flags of [
    ['safe', 'meshopt', 'quantize'],
    ['safe', 'ktx2', 'webp'],
    ['safe', 'join', 'instance'],
    ['safe', 'meshopt', 'ktx2', 'join'],
    ['safe', 'quantize', 'webp', 'instance'],
    ['safe', 'meshopt', 'draco'],
  ]) {
    it(`плотность отчёта ≤${DENSITY_LIMIT} (флаги: [${flags.join(', ')}])`, async () => {
      const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      const violations = densityViolations(result);
      const detail = violations.map(([id, n]) => `${id} ×${n}`).join(', ');
      expect(violations, `повторы: ${detail}`).toEqual([]);
    }, 120_000);
  }
});

describe('Сочетания фич — localizeResult(ru/en): структура та же, тексты разные', () => {
  const LANG_COMBOS = [
    ['safe', 'meshopt', 'quantize'],
    ['safe', 'ktx2', 'webp'],
    ['safe', 'join', 'instance'],
    ['safe', 'quantize', 'webp', 'join'],
  ];
  for (const flags of LANG_COMBOS) {
    it(`localizeResult на [${flags.join(', ')}] — ни один ключ не падает`, async () => {
      const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
        locale: 'en',
      });
      const ru = localizeResult(result, 'ru');
      const en = localizeResult(result, 'en');

      for (const key of ['applied', 'skipped', 'findings', 'validation']) {
        expect(ru[key].length).toBe(result[key].length);
        expect(en[key].length).toBe(result[key].length);
      }
      const all = [...ru.applied, ...ru.skipped, ...ru.findings, ...ru.validation];
      for (const rec of all) {
        expect(rec.i18n).toBeDefined();
        expect(rec.i18n.text.messageId).toBeTypeOf('string');
      }
      const ruText = [...ru.applied, ...ru.skipped].map((r) => r.text).join('\n');
      const enText = [...en.applied, ...en.skipped].map((r) => r.text).join('\n');
      expect(ruText).not.toBe(enText);
      expect(ruText).not.toContain('messageId');
    }, 120_000);
  }
});
describe('Сочетания фич — тройки геометрия×текстуры×структура', () => {
  for (const [g, t, s] of TRIPLES) {
    const flags = ['safe', g, t, s];
    for (const model of ['Dirty Cube 01.glb']) {
      it(`${model} · [${flags.join(', ')}] — инварианты тройки`, async () => {
        await checkComboInvariants(model, flags, `${model} [${flags.join(', ')}]`);
      }, 120_000);
    }
    eachModel(`[${flags.join(', ')}] — инварианты тройки`, ['parkergirl.glb'], async (model) => {
      await checkComboInvariants(model, flags, `${model} [${flags.join(', ')}]`);
    });
  }
});

describe('Сочетания фич — матрица растёт сама (фичи из RULES)', () => {
  it('восемь фич задания присутствуют в списке (join, instance, resample, ktx2, webp, meshopt, draco, quantize)', () => {
    for (const f of ['join', 'instance', 'resample', 'ktx2', 'webp', 'meshopt', 'draco', 'quantize']) {
      expect(FEATURES, `не хватает фичи ${f}`).toContain(f);
    }
    const C2 = (n) => (n * (n - 1)) / 2;
    expect(PAIRS.length, 'пары перестали быть всеми сочетаниями по два').toBe(C2(FEATURES.length));
    expect(TRIPLES.length, 'тройки перестали быть произведением трёх групп')
      .toBe(GEOMETRY_CODECS.length * TEXTURE_FORMATS.length * STRUCTURE.length);
    expect(MUTEX_PAIRS.length).toBe(1 + C2(GEOMETRY_CODECS.length));
  });

  it('meta.feature из RULES входит в FEATURES целиком (девятая фича вырастет матрицу сама)', () => {
    for (const r of RULES) {
      if (r.meta.feature) expect(FEATURES).toContain(r.meta.feature);
    }
  });

  it('у каждой фичи есть правило (featureRuleId не пустой)', () => {
    for (const f of FEATURES) {
      expect(featureRuleId(f), `нет правила для фичи ${f}`).toBeTruthy();
    }
  });
});

afterAll(cleanupTmpOutDirs);
