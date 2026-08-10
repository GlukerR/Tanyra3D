// tests/feature-combos.test.mjs — сочетания фич: полная матрица пар и троек
// (задание 2026-08-01-сочетания-фич; слои 1–2 из ПРАВИЛА_ТЕСТОВ_универсальность.md).
//
// Зачем. Два последних дефекта движка нашлись на сочетаниях, а не на одиночных фичах:
//   TESTBUG-008 — meshopt+quantize: воздержание было правильным, а причину человеку
//     называли не ту (следствие его выбора вместо самого выбора);
//   TESTBUG-009 — join+instance: отчёт заявлял «размножило общую геометрию +36 %»
//     на файле, который стал на треть легче.
// Оба нашлись случайно. Пар и троек больше, чем можно перебрать руками, — перебирает
// этот файл. Список фич берётся из RULES (meta.feature) импортом: добавят девятую
// фичу — матрица вырастет сама (см. FINDING-0 в отчёте про draco).
//
// Формат-независимость (ПРАВИЛА, слои 1–2): здесь нет ни одного имени движка; все
// утверждения — о контракте отчёта и о выходном ФАЙЛЕ (Babylon прочитает тот же GLB).
//
// ============================================================================
// ⚠  НАЙДЕННЫЕ РАСХОЖДЕНИЯ (движок НЕ чиним — задание). Разделы, где тест КРАСНЫЙ
//    на 2026-08-04, с объяснением. Основной агент закрывает их правкой движка.
// ============================================================================
//
// F-1. РАЗДЕЛ 2 «Взаимоисключение» — пара meshopt+draco через API: проигравшая
//   фича НЕ получает записи воздержания с причиной. normalizeOpts молча выбирает
//   draco (codec = 'draco' при обоих флагах), отчёт показывает только applied
//   compress.done codec=draco, и ни одна строка не говорит человеку, что meshopt
//   проигнорирован И ПОЧЕМУ. Это тот же класс, что TESTBUG-008 (причина выбора
//   должна называть выбор человека), но для пары кодеков одного правила.
//   Замер: Dirty Cube 01, ['safe','meshopt','draco'] → skipped пуст по compress,
//   только applied codec=draco. Контракт задания: «одна фича применилась, вторая
//   воздержалась; причина воздержания названа codec-специфично».
//
// Замечание про метрики: triangles/вершины в metrics считаются «по сцене», а не по
// мешам (см. Н-3 контракта движка). Здесь это не критично: все инварианты —
// относительные (before vs after одного и того же прогона).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import { TOKTX, HAS_GLTF_CLI } from '../addons/gltf/tools.mjs';
import { modelPath, eachModel } from './helpers/model-files.mjs';
import { densityViolations, DENSITY_LIMIT } from './helpers/report-density.mjs';

// ============================================================================
// Фичи — ИЗ RULES импортом (задание: не переписывать список руками).
// meta.feature в RULES: join, instance, resample, ktx2, webp, meshopt, quantize.
// draco в RULES нет: это кодек-вариант того же правила geometry/compress (у него
// feature 'meshopt', а выбор кодека делает normalizeOpts). Задание требует draco
// восьмой фичей — добавляем его явно рядом с близнецом (см. FINDING-0 в отчёте).
// Девятую фичу, добавленную в RULES, матрица подхватит автоматически.
const RULES_FEATURES = [...new Set(RULES.map((r) => r.meta.feature).filter(Boolean))];
const FEATURES = [...new Set([...RULES_FEATURES, 'draco'])];
const GEOMETRY_CODECS = ['meshopt', 'draco', 'quantize'];
const TEXTURE_FORMATS = ['ktx2', 'webp'];
const STRUCTURE = ['join', 'instance'];

// Все пары поверх safe: ['safe', A, B] — C(8,2) = 28 пар.
const PAIRS = [];
for (let i = 0; i < FEATURES.length; i++) {
  for (let j = i + 1; j < FEATURES.length; j++) {
    PAIRS.push([FEATURES[i], FEATURES[j]]);
  }
}

// Тройки для взаимоисключающих групп: геометрия × текстуры × структура = 3×2×2 = 12.
const TRIPLES = [];
for (const g of GEOMETRY_CODECS) {
  for (const t of TEXTURE_FORMATS) {
    for (const s of STRUCTURE) TRIPLES.push([g, t, s]);
  }
}

// Взаимоисключающие пары: ktx2+webp и любые две из meshopt/draco/quantize.
const MUTEX_PAIRS = [
  ['ktx2', 'webp'],
  ...GEOMETRY_CODECS.flatMap((a, i) => GEOMETRY_CODECS.slice(i + 1).map((b) => [a, b])),
];

const TOKTX_OK = Boolean(TOKTX && HAS_GLTF_CLI); // ktx2-правило гейтится обоими

// Соответствие фичи правилу (по meta.feature; draco и meshopt — одно правило).
const featureRuleId = (f) => {
  if (f === 'draco') return 'geometry/compress';
  const rule = RULES.find((r) => r.meta.feature === f);
  return rule ? rule.meta.id : null;
};

function tmpOutDir(prefix = 'combos-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const hasApplied = (result, ruleId) => (result.applied || []).some((a) => a.ruleId === ruleId);
const skippedOf = (result, ruleId) => (result.skipped || []).filter((s) => s.ruleId === ruleId);
const appliedOf = (result, ruleId) => (result.applied || []).filter((a) => a.ruleId === ruleId);
// ============================================================================
// РАЗДЕЛ 1. Инварианты на всех парах ['safe', A, B] — 28 пар × корпус.
// dryRun:true — файл на диск не пишем, отчёта достаточно.
// ============================================================================
// Корпус сокращён: репо-модели 11 → 5 (см. отчёт «что сократил»), локальные
// подключены через eachModel — на чистом клоне они просто пропустятся.
const PAIR_CORPUS = [
  'Dirty Cube 01.glb',                 // геометрия + текстуры + общая геометрия
  'Instance Grid 01.glb',              // инстансинг / общая геометрия
  'Morph Cube 01.glb',                 // морфы
  'Vertex Colors 01.glb',              // атрибуты
  'Meshopt Compressed Input 01.glb',   // вход уже упакован meshopt
];
const LOCAL_CORPUS = ['parkergirl.glb', 'RiggedSimple.glb', 'chibi_zenitsu.glb'];

// Метрики, обязанные быть конечными числами (свойство «метрики полны, без NaN»).
const METRIC_KEYS = ['fileBytes', 'drawCalls', 'triangles', 'vertices', 'morphTargets',
  'textureBytes', 'gpuBytes', 'meshes', 'materials', 'textures', 'nodes', 'scenes',
  'animations', 'skins'];

function metricNaNs(m) {
  if (!m) return ['metrics missing'];
  return METRIC_KEYS.filter((k) => !Number.isFinite(m[k]));
}

// Проверка, что применённые правила не нарушают meta.runAfter (устойчивая
// топосортировка движка; здесь — что в отчёте зависимости раньше зависимых).
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

// Инварианты одной комбинации. finder — строка для сообщений об ошибке.
async function checkComboInvariants(model, flags, finder) {
  const result = await optimizeFile(modelPath(model), {
    advancedFeatures: flags,
    dryRun: true,
  });

  // 1. status определён; исключений наружу нет (optimizeFile их глотает в status fail)
  expect(['ok', 'fail', 'skip']).toContain(result.status);
  if (result.status === 'fail' && !result.error) {
    // fail без error бывает у валидации; сам по себе не находка
  }

  // 2. метрики полны, без NaN
  const beforeNaNs = metricNaNs(result.metrics?.before);
  const afterNaNs = metricNaNs(result.metrics?.after);
  expect(beforeNaNs, `${finder}: NaN в before: ${beforeNaNs.join(', ')}`).toEqual([]);
  expect(afterNaNs, `${finder}: NaN в after: ${afterNaNs.join(', ')}`).toEqual([]);

  // 3. треугольников не больше, чем было (может только уменьшиться)
  if (result.metrics?.before && result.metrics?.after) {
    expect(result.metrics.after.triangles).toBeLessThanOrEqual(result.metrics.before.triangles);

    // 4. скинов/морфов/анимаций — ровно столько же (их теряет только явное правило,
    // а такого у нас нет; допуск: fail-прогоны движка уже покрыты контрактом)
    for (const k of ['skins', 'animations', 'morphTargets']) {
      expect(result.metrics.after[k], `${finder}: ${k} изменилось`).toBe(result.metrics.before[k]);
    }
  }

  // 5. порядок правил не нарушает meta.runAfter
  const runAfterBad = runAfterViolations(result);
  expect(runAfterBad, `${finder}: нарушение runAfter: ${runAfterBad.join('; ')}`).toEqual([]);

  return result;
}
describe('Сочетания фич — инварианты на всех парах (28 пар × корпус)', () => {
  for (const [a, b] of PAIRS) {
    const flags = ['safe', a, b];
    // Репо-модели гоняем напрямую (всегда на месте)…
    for (const model of PAIR_CORPUS) {
      it(`${model} · [${flags.join(', ')}] — инварианты`, async () => {
        await checkComboInvariants(model, flags, `${model} [${flags.join(', ')}]`);
      }, 120_000);
    }
    // …локальные — через eachModel: на чистом клоне пропустятся сами.
    eachModel(`[${flags.join(', ')}] — инварианты`, LOCAL_CORPUS, async (model) => {
      await checkComboInvariants(model, flags, `${model} [${flags.join(', ')}]`);
    });
  }
});

// ============================================================================
// РАЗДЕЛ 2. Взаимоисключающие пары — оба порядка передачи фич.
// ============================================================================
// Интерфейс гасит пары друг о друга, но через API передать обе можно, и поведение
// обязано быть предсказуемым: (а) результат не зависит от порядка в массиве,
// (б) одна фича применилась, вторая воздержалась, (в) причина воздержания названа
// codec-специфично — та фича, которую человек выбрал (TESTBUG-008).
describe('Сочетания фич — взаимоисключающие пары, оба порядка', () => {
  for (const [a, b] of MUTEX_PAIRS) {
    it(`${a}+${b}: результат не зависит от порядка, проигравший назван по codec`, async () => {
      const outDir = tmpOutDir();
      const r1 = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
        advancedFeatures: ['safe', a, b], dryRun: true, outDir,
      });
      const r2 = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
        advancedFeatures: ['safe', b, a], dryRun: true, outDir,
      });

      // (а) одинаковый размер файла в обоих порядках
      expect(r1.metrics?.after?.fileBytes).toBeTypeOf('number');
      expect(r2.metrics?.after?.fileBytes).toBe(r1.metrics.after.fileBytes);

      // (б, в) кто применился, кто воздержался — по правилам пары
      const ruleA = featureRuleId(a);
      const ruleB = featureRuleId(b);
      const appliedA = hasApplied(r1, ruleA);
      const appliedB = hasApplied(r1, ruleB);

      if (a === 'ktx2' && b === 'webp') {
        // ktx2 без toktx воздержится (ktx2.noTools), webp тогда применится
        if (!TOKTX_OK) {
          expect(appliedA).toBe(false);
          expect(appliedB).toBe(true);
          return;
        }
        expect(appliedA).toBe(true);
        expect(appliedB).toBe(false);
        // причина воздержания webp — codec-специфична: файл уже стал ktx2
        const webpSkips = skippedOf(r1, 'textures/webp');
        expect(webpSkips.some((s) => s.i18n?.text?.messageId === 'webp.skipped.format')).toBe(true);
      } else if (a === 'meshopt' && b === 'draco') {
        // ДВА кодека одного правила: применяется codec=draco (normalizeOpts).
        // Проигравший (meshopt) обязан воздержаться с локализуемой, конкретной
        // причиной: пользователь видит выбранный Draco, а не безличное «нельзя».
        expect(appliedA || appliedB).toBe(true);
        const compressApplied = appliedOf(r1, 'geometry/compress');
        expect(compressApplied[0]?.i18n?.text?.data?.codec).toBe('draco');
        for (const r of [r1, r2]) {
          const loser = (r.skipped || []).find((s) => s.feature === 'meshopt');
          expect(loser).toBeTruthy();
          expect(loser.i18n?.text?.messageId).toBe('engine.skipped.line');
          expect(loser.i18n?.reason?.messageId).toBe('engine.feature.exclusive');
          expect(loser.i18n?.reason?.data?.selected?.messageId).toBe('feature.draco');
        }
      } else {
        // quantize против meshopt/draco: quantize воздерживается с codec-специфичной
        // причиной (TESTBUG-008 закрыт): «уже упакована (meshopt/draco)»
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
// ============================================================================
// РАЗДЕЛ 3. Отчёт не противоречит файлу (самый ценный; TESTBUG-009 нашёлся здесь).
// ============================================================================
// Для каждой комбинации с dryRun:false пишем .glb и сверяем числовые утверждения
// отчёта с записанным файлом: рост — есть ли он в файле, выигрыш — есть ли он в
// файле, «уже X» — есть ли X в файле. Формула одна: ЛЮБОЕ числовое утверждение
// отчёта сверяется с файлом.
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

// Утверждения отчёта → проверка по файлу.
// Возвращает массив нарушений (пустой = отчёт не противоречит файлу).
async function reportVsFileViolations(model, result, dst) {
  const out = [];
  const fileBytes = fs.statSync(dst).size;

  // 0. Метрика отчёта (metrics.after.fileBytes) должна совпадать с файлом на диске.
  if (result.metrics?.after?.fileBytes !== fileBytes) {
    out.push(`metrics.after.fileBytes=${result.metrics?.after?.fileBytes} ≠ файл ${fileBytes}`);
  }

  // 1. Рост: если какое-то правило сообщило о РОСТЕ (cost/применение с ростом) —
  // рост должен быть виден в записанном файле, а не только внутри окна правила.
  const costRecords = (result.skipped || []).filter((s) => s.kind === 'cost');
  for (const c of costRecords) {
    const grew = result.metrics?.after?.fileBytes > result.metrics?.before?.fileBytes;
    if (!grew) {
      out.push(`cost «${c.i18n?.text?.messageId}» сообщил о росте, но файл не вырос`);
    }
  }

  // 2. Выигрыш: если правило сообщило о выигрыше (метрики файла меньше) —
  // выигрыш должен быть в файле.
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

  // 3. «уже X»: правило назвало причину «уже X» — X должен быть в файле.
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
    } else if (id && id.startsWith('webp.skipped.already')) {
      if (!texMimes.has('image/webp')) out.push(`${id}, но в файле нет image/webp`);
    } else if (id === 'webp.skipped.format') {
      const mime = data.mime ? `image/${data.mime}` : null;
      if (mime && !texMimes.has(mime)) out.push(`webp.skipped.format(${data.mime}), но в файле нет ${mime}`);
    }
  }

  // 4. Применённые сжатия обязаны оставить свой след в файле (расширение объявлено).
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

  // 5. Треугольники: счётчик отчёта (after) совпадает с фактическим файлом.
  const fileMetrics = await readOutputMetrics(dst);
  if (result.metrics?.after && fileMetrics.triangles !== result.metrics.after.triangles) {
    out.push(`треугольники: отчёт ${result.metrics.after.triangles}, файл ${fileMetrics.triangles}`);
  }

  return out;
}
describe('Сочетания фич — отчёт не противоречит записанному файлу (dryRun:false)', () => {
  // Комбинации, где есть о чём врать: cost-записи (ktx2.grewFile), «уже X»,
  // выигрыши квантования/компрессии. dryRun:false → файл реально на диске.
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

      // status fail допустим (валидация) — но файл обязан быть; расхождения ниже —
      // это находки, а не «красный из-за fail».
      const violations = await reportVsFileViolations(model, result, dst);
      expect(violations, `${model} [${flags.join(', ')}]: ${violations.join('; ')}`).toEqual([]);
    }, 120_000);
  }
});

// ============================================================================
// РАЗДЕЛ 4. Плотность и язык на сочетаниях.
// ============================================================================
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
        advancedFeatures: flags,
        dryRun: true,
        locale: 'en',
      });
      const ru = localizeResult(result, 'ru');
      const en = localizeResult(result, 'en');

      // структура та же: те же списки, та же длина
      for (const key of ['applied', 'skipped', 'findings', 'validation']) {
        expect(ru[key].length).toBe(result[key].length);
        expect(en[key].length).toBe(result[key].length);
      }
      // рецепты (i18n) сохраняются: messageId не потерялся при локализации
      const all = [...ru.applied, ...ru.skipped, ...ru.findings, ...ru.validation];
      for (const rec of all) {
        expect(rec.i18n).toBeDefined();
        expect(rec.i18n.text.messageId).toBeTypeOf('string');
      }
      // тексты реально переведены: хоть одна запись отличается между ru и en
      const ruText = [...ru.applied, ...ru.skipped].map((r) => r.text).join('\n');
      const enText = [...en.applied, ...en.skipped].map((r) => r.text).join('\n');
      expect(ruText).not.toBe(enText);
      // ни один ключ не упал: в текстах нет сигнатуры неразрешённого ключа
      expect(ruText).not.toContain('messageId');
    }, 120_000);
  }
});
// ============================================================================
// РАЗДЕЛ 5. Тройки: геометрия × текстуры × структура (12 комбинаций).
// ============================================================================
// Тройки проверяем по тем же инвариантам, что и пары, на 2 моделях: с текстурами
// (Dirty Cube 01) и со скином/морфами (parkergirl, локально).
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

// ============================================================================
// РАЗДЕЛ 6. Матрица живёт: список фич и пары берутся из RULES, а не руками.
// ============================================================================
describe('Сочетания фич — матрица растёт сама (фичи из RULES)', () => {
  it('восемь фич задания присутствуют в списке (join, instance, resample, ktx2, webp, meshopt, draco, quantize)', () => {
    for (const f of ['join', 'instance', 'resample', 'ktx2', 'webp', 'meshopt', 'draco', 'quantize']) {
      expect(FEATURES, `не хватает фичи ${f}`).toContain(f);
    }
    expect(PAIRS.length).toBe(28);
    expect(TRIPLES.length).toBe(12);
    expect(MUTEX_PAIRS.length).toBe(4);
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
