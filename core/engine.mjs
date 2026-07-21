// core/engine.mjs — формат-агностичный движок: пять фаз над массивом правил аддона
// (АНАЛИЗ → ПЛАН → ПРИМЕНЕНИЕ → ВАЛИДАЦИЯ → ОТЧЁТ). Движок ничего не знает о
// конкретных правилах и о формате модели — всё специфичное для формата он делегирует
// аддону (load/write/collectMetrics/baselineMetrics/validate/writeReport). Логика
// перенесена из optimize2.mjs без изменения поведения (Правило 3 CLAUDE.md, §4b).
//
// Двухуровневая обработка: фазы 1–3 идут ДВУМЯ проходами — сначала базовые правила
// (tier basic, им можно менять структуру), затем checkpoint baseline-метрик, затем
// расширения (tier advanced — только сжатие/кодирование); фаза 4 строго сверяет
// структуру с checkpoint, расхождение блокирует запись.

import fs from 'node:fs';
import path from 'node:path';

/** @typedef {import('./types.mjs').Addon} Addon */
/** @typedef {import('./types.mjs').RunResult} RunResult */

// Политика автофикса (ARCHITECTURE.md §2.4): применяем provable + numeric + perceptual
// (perceptual = KTX2/UASTC — пользователь выбрал сам и доволен). lossy — никогда
// автоматом; только явный force из canFix (например флаг --strip-vertex-colors).
export const TIER_RANK = { provable: 0, numeric: 1, perceptual: 2, lossy: 3 };
export const AUTOFIX_MAX_TIER = 'perceptual';

// Находки/применения уровня движка (вне правил аддона) — стабильные ruleId «engine/*».
// Аддон может ссылаться на них (напр. gltf/validate — на inputValidation).
export const ENGINE_META = {
  inputCompression: { id: 'engine/input-compression', category: 'geometry', severity: 'info', fixSafety: 'provable', reversible: true, dataLoss: 'none' },
  inputValidation: { id: 'engine/input-validation', category: 'scene', severity: 'warn', fixSafety: 'none', reversible: true, dataLoss: 'none' },
};

const asLines = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Топологическая сортировка по meta.runAfter (устойчивая: при равенстве — порядок массива).
// Зависимости на выключенные правила считаются выполненными.
export function orderRules(rules) {
  const ids = new Set(rules.map((r) => r.meta.id));
  const done = new Set();
  const pending = [...rules];
  const out = [];
  while (pending.length) {
    const i = pending.findIndex((r) => (r.meta.runAfter || []).every((d) => !ids.has(d) || done.has(d)));
    if (i === -1) throw new Error(`цикл в runAfter: ${pending.map((r) => r.meta.id).join(', ')}`);
    const [r] = pending.splice(i, 1);
    done.add(r.meta.id);
    out.push(r);
  }
  return out;
}

// BASELINE-CHECKPOINT: сверка снимка структуры (после базового прохода) с метриками
// реальных байтов будущего файла. Жёсткие ключи (треугольники/скины/узлы/анимации/
// draw-calls) не должны меняться — их расхождение блокирует запись (нарушение гарантии
// компонента). Мягкие ключи (soft, напр. vertices) — только информируют: кодек может
// переиндексировать/сваривать вершины при сериализации (Draco зовёт weld перед сжатием),
// это меняет ЧИСЛО вершин, но не треугольники и топологию — для неанимированной модели
// это легитимная полная оптимизация, для анимированной защищают строгие ключи skins/
// animations. Возвращает строки валидации в порядке отчёта; логирует посписочную сверку.
export function compareBaseline(baseline, after, keys, { advancedPlannedIds = [], log = () => {}, soft = new Set() } = {}) {
  for (const k of keys) {
    log(`      [baseline-validate] ${k}: ${baseline[k]} → ${after[k]}${after[k] === baseline[k] ? '' : '  ← РАСХОЖДЕНИЕ'}`);
  }
  const broken = keys.filter((k) => after[k] !== baseline[k]);
  if (broken.length === 0) {
    return [{ level: 'pass', text: `baseline-checkpoint: структура (${keys.join(', ')}) совпадает с контрольной точкой после базовых оптимизаций` }];
  }
  const cause = advancedPlannedIds.length
    ? `расширения второго прохода (${advancedPlannedIds.join(', ')}) или запись файла`
    : 'запись файла (второй проход фиксов не применялся)';
  return broken.map((k) => (soft.has(k)
    ? {
      level: 'info',
      text: `${k} изменился на этапе кодирования (было ${baseline[k]} на checkpoint, стало ${after[k]}) — `
        + `переиндексация/сварка вершин кодеком (напр. Draco зовёт weld перед сжатием). `
        + `Треугольники и топология mesh сохранены; запись не блокируется. Для анимированных моделей структуру защищают строгие ключи (skins, animations).`,
    }
    : {
      level: 'fail',
      text: `Нарушена гарантия компонента: ${k} изменился после расширений (было ${baseline[k]} на checkpoint, стало ${after[k]}). `
        + `По официальной документации (ARCHITECTURE.md §0a) Draco/Meshopt/KTX2 не меняют структуру mesh. `
        + `Вероятная причина: ${cause} — баг в библиотеке или неправильное применение компонента. Файл НЕ записан.`,
    }));
}

// ============================================================================
// ПРОГОН ОДНОГО ФАЙЛА через аддон. Возвращает RunResult (контракт §4b).
// Исключения наружу не летят: превращаются в status:'fail'.
// ============================================================================
export async function runOptimize(addon, srcPath, opts = {}) {
  const src = path.resolve(String(srcPath));
  const dstName = addon.outputName(src);
  const result = {
    status: 'ok',
    file: { src, dst: null, written: false, reportPath: null },
    findings: [],   // { ruleId, category, severity, fixSafety, text }
    skipped: [],    // { ruleId, text, reason }
    applied: [],    // { ruleId, fixSafety, reversible, dataLoss, text } — обратимость по §4d
    validation: [], // { level: 'pass'|'info'|'fail', text }
    metrics: { before: null, after: null },
  };
  try {
    // normalizeOpts внутри try: неизвестная опция → status:'fail', не исключение наружу
    const o = addon.normalizeOpts(opts);
    result.file.dst = path.join(o.outDir, dstName);
    return await runFile(addon, src, dstName, o, result);
  } catch (e) {
    // исключение (модель не читается и т.п.) — наружу не летит, а становится status:'fail'
    result.status = 'fail';
    result.error = e && e.message ? e.message : String(e);
    return result;
  }
}

async function runFile(addon, src, dstName, o, result) {
  const dst = result.file.dst;
  if (!o.dryRun && !o.force && fs.existsSync(dst)) {
    result.status = 'skip';
    return result;
  }
  const progress = o.onProgress || (() => {});
  const log = o.log;
  const addFound = (meta, v) => { for (const text of asLines(v)) result.findings.push({ ruleId: meta.id, category: meta.category, severity: meta.severity, fixSafety: meta.fixSafety, text }); };
  const addSkipped = (meta, v, reason) => { for (const text of asLines(v)) result.skipped.push({ ruleId: meta.id, text, reason: reason ?? text }); };
  // over — переопределение полей обратимости для отдельных строк (lossy-ветки правил,
  // см. res.irreversible): базовое поведение правила может быть без потерь, а форсированное — нет
  const addApplied = (meta, v, over = {}) => {
    for (const text of asLines(v)) {
      result.applied.push({
        ruleId: meta.id,
        fixSafety: meta.fixSafety,
        reversible: over.reversible ?? meta.reversible ?? false,
        dataLoss: over.dataLoss ?? meta.dataLoss ?? 'none',
        text,
      });
    }
  };

  fs.mkdirSync(o.outDir, { recursive: true });
  const io = await addon.createIO();

  // -------- загрузка: исходный файл НЕ трогаем никогда, работаем с копией в памяти --------
  const ctx = {
    document: await addon.load(io, src),
    io,
    opts: o,
    outDir: o.outDir,
    dstName,
    cache: new Map(),
    log,
  };
  const before = addon.collectMetrics(ctx.document, fs.statSync(src).size);

  // Входное сжатие геометрии снимаем сразу после загрузки (данные уже распакованы в память).
  // Иначе расширение остаётся на документе и КАЖДАЯ запись (включая tmp для KTX2) молча
  // пережимает геометрию заново — Draco лосси по связности, потери накапливаются.
  // Граничный случай из ARCHITECTURE.md §6: «Draco vs Meshopt already present — не стекировать».
  const strippedCodecs = addon.stripInputCompression(ctx.document);
  if (strippedCodecs.length) {
    addFound(ENGINE_META.inputCompression, `входная геометрия уже сжата (${strippedCodecs.join(', ')}) — распакована при загрузке`);
    addApplied(ENGINE_META.inputCompression, `Снято входное сжатие ${strippedCodecs.join(', ')} — перекодировано заново (${o.codec}), без двойного сжатия и скрытых пережатий`);
  }

  // ==========================================================================
  // ДВУХУРОВНЕВАЯ ОБРАБОТКА: фазы 1–3 идут ДВУМЯ проходами.
  //   Проход 1 — базовые (tier basic): чистка, ей МОЖНО менять структуру.
  //   *** CHECKPOINT: снимок baseline-метрик (структура зафиксирована) ***
  //   Проход 2 — расширения (tier advanced): ТОЛЬКО сжатие/кодирование.
  // Базовое правило, зависящее (runAfter) от ВКЛЮЧЁННОГО расширения
  // (geometry/compress после textures/ktx2), уходит во второй проход вместе с ним.
  // ==========================================================================
  const orderedRules = orderRules(addon.rules);
  const activeCount = orderedRules.filter((r) => r.meta.enabled(o)).length;
  const basicPass = [];
  const advancedPass = [];
  const deferredIds = new Set(); // id правил, реально выполняющихся во втором проходе
  for (const rule of orderedRules) {
    const dependsOnDeferred = (rule.meta.runAfter || []).some((d) => deferredIds.has(d));
    if (rule.meta.tier === 'advanced' || dependsOnDeferred) {
      advancedPass.push(rule);
      if (rule.meta.enabled(o)) deferredIds.add(rule.meta.id);
    } else {
      basicPass.push(rule);
    }
  }

  // Фазы 1–2 одного прохода: АНАЛИЗ (только чтение; анализируются и невыбранные
  // расширения — их находки видны в отчёте, advanced ≠ невидимый) + ПЛАН.
  const analyzeAndPlan = (rules) => {
    const findings = [];
    for (const rule of rules) {
      for (const f of rule.analyze(ctx)) findings.push({ rule, finding: f });
    }
    const planned = [];
    for (const { rule, finding } of findings) {
      if (!rule.meta.enabled(o)) {
        if (rule.meta.tier === 'advanced') {
          // расширение не выбрано пользователем — явная строка «Пропущено» с подсказкой
          const reason = `расширение «${rule.meta.feature}» не включено (advancedFeatures: ['${rule.meta.feature}'] или флаг --${rule.meta.feature})`;
          addSkipped(rule.meta, `${rule.meta.title} — ${reason}`, reason);
        }
        // базовое правило, выключенное опцией (например --keep-parts), — молча, как раньше
        continue;
      }
      if (!rule.fix) { addFound(rule.meta, finding.text); continue; }
      const decision = rule.canFix ? rule.canFix(finding, ctx) : { safe: true, reason: '' };
      if (!decision.safe) {
        addSkipped(rule.meta, `${rule.meta.title} — ${decision.reason}`, decision.reason);
        continue;
      }
      const tier = finding.fixSafety || rule.meta.fixSafety;
      if (TIER_RANK[tier] > TIER_RANK[AUTOFIX_MAX_TIER] && !decision.force) {
        const reason = `уровень безопасности «${tier}» не применяется автоматически`;
        addSkipped(rule.meta, `${rule.meta.title} — ${reason}`, reason);
        continue;
      }
      planned.push({ rule, finding });
    }
    return planned;
  };

  // Фаза 3 одного прохода: ПРИМЕНЕНИЕ (по порядку, меняем рабочую копию)
  const applyPlanned = async (planned) => {
    for (const { rule, finding } of planned) {
      progress({ type: 'rule', phase: 3, ruleId: rule.meta.id, title: rule.meta.title });
      log(`      • ${rule.meta.title}`);
      const res = (await rule.fix(finding, ctx)) || {};
      addFound(rule.meta, res.found);
      addSkipped(rule.meta, res.skipped);
      addApplied(rule.meta, res.details ?? res.detail);
      // строки с безвозвратной потерей данных (§4d) — UI предупредит перед скачиванием
      addApplied(rule.meta, res.irreversible, { reversible: false, dataLoss: 'significant' });
    }
  };

  // -------- ПРОХОД 1 · БАЗОВЫЕ (фазы 1–3) --------
  // события onProgress фаз 1–3 шлём один раз (на базовом проходе): номера фаз
  // для потребителей остаются монотонными 1→5, контракт §4b не меняется
  progress({ type: 'phase', phase: 1, name: 'анализ' });
  log(`    фаза 1/5 · анализ (правил: ${orderedRules.length}, активно: ${activeCount})`);
  progress({ type: 'phase', phase: 2, name: 'план' });
  log('    фаза 2/5 · план');
  const basicPlanned = analyzeAndPlan(basicPass);
  progress({ type: 'phase', phase: 3, name: 'применение' });
  log(`    фаза 3/5 · применение · базовые (${basicPlanned.length} фиксов)`);
  await applyPlanned(basicPlanned);

  // *** CHECKPOINT: baseline-метрики после базовых оптимизаций ***
  // Дальше структура модели зафиксирована; расширениям разрешено менять только
  // кодирование (байты/VRAM). Сверка — в фазе 4 (addon.validate → compareBaseline),
  // расхождение блокирует запись.
  ctx.baselineMetrics = addon.baselineMetrics(ctx.document);
  log(`      baseline-checkpoint: ${addon.BASELINE_METRICS.map((k) => `${k}=${ctx.baselineMetrics[k]}`).join(', ')}`);

  // -------- ПРОХОД 2 · РАСШИРЕНИЯ (фазы 1–3 повторно, только advanced и отложенные) --------
  const advancedPlanned = analyzeAndPlan(advancedPass);
  if (advancedPlanned.length) log(`      расширения (${advancedPlanned.length} фиксов)`);
  await applyPlanned(advancedPlanned);

  // -------- ФАЗА 4 · ВАЛИДАЦИЯ (весь ассет; при провале .glb НЕ записывается) --------
  progress({ type: 'phase', phase: 4, name: 'валидация' });
  log('    фаза 4/5 · валидация');
  const glb = await addon.writeBytes(io, ctx.document); // байты будущего файла — в памяти, на диск пока ничего
  const after = addon.collectMetrics(await addon.readBytes(io, glb), glb.byteLength);
  await addon.validate({
    ctx, before, after, glbBytes: glb, src, result,
    advancedPlannedIds: advancedPlanned.map((p) => p.rule.meta.id),
    addFound, log,
  });

  const validationOk = !result.validation.some((x) => x.level === 'fail');

  // -------- ФАЗА 5 · ОТЧЁТ + запись (.glb пишем ТОЛЬКО если есть applied и валидация прошла) --------
  progress({ type: 'phase', phase: 5, name: 'отчёт' });
  log('    фаза 5/5 · отчёт');
  const writeAsset = !o.dryRun && validationOk && result.applied.length > 0;
  if (writeAsset) fs.writeFileSync(dst, glb);
  const reportName = addon.writeReport({ name: dstName, result, before, after, assetWritten: writeAsset, opts: o });

  result.file.written = writeAsset;
  result.file.reportPath = path.join(o.outDir, reportName);
  result.metrics = { before, after };
  result.status = validationOk ? 'ok' : 'fail'; // fail = валидация не прошла, .glb не записан
  return result;
}
