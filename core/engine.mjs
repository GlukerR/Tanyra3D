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

import { render } from './i18n.mjs';
// Общий словарь движка и аддона (ARCH-001): политика автофикса, engine/*-находки,
// сверка baseline-checkpoint. Аддон берёт их оттуда же, а не из движка — иначе
// связь двусторонняя: движок зовёт аддон, аддон импортирует внутренности движка.
import { TIER_RANK, AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline } from './contract.mjs';

// Реэкспорт: снаружи движок по-прежнему отдаёт эти имена, менять импорты незачем.
export { AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline };

/** @typedef {import('./types.mjs').Addon} Addon */
/** @typedef {import('./types.mjs').RunResult} RunResult */

const asLines = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Правила возвращают строки как { messageId, data }; движок рендерит их через i18n
// перед записью в RunResult (text по-прежнему готовая строка — контракт §4b). Готовые
// строки (сообщения самого движка) пропускаются как есть.
const renderLines = (v, locale) => asLines(v).map((x) => (typeof x === 'string' ? x : render(x.messageId, x.data, locale)));

// Топологическая сортировка по meta.runAfter (устойчивая: при равенстве — порядок массива).
// Зависимости на выключенные правила считаются выполненными.
export function orderRules(rules) {
  const ids = new Set(rules.map((r) => r.meta.id));
  const done = new Set();
  const pending = [...rules];
  const out = [];
  while (pending.length) {
    const i = pending.findIndex((r) => (r.meta.runAfter || []).every((d) => !ids.has(d) || done.has(d)));
    if (i === -1) throw new Error(`cycle in runAfter: ${pending.map((r) => r.meta.id).join(', ')}`);
    const [r] = pending.splice(i, 1);
    done.add(r.meta.id);
    out.push(r);
  }
  return out;
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
  const locale = o.locale;
  const addFound = (meta, v) => { for (const text of asLines(v)) result.findings.push({ ruleId: meta.id, category: meta.category, severity: meta.severity, fixSafety: meta.fixSafety, text }); };
  // kind — почему пропущено. Нужен потребителю отчёта, чтобы отличать «пользователь
  // не включал» и «включено, но делать было нечего» от «отказались по безопасности».
  // Первые два для человека — не предупреждение, а тишина: показывать их наравне с
  // отказом значит топить единственную важную строку в перечислении небытия.
  //   'disabled' — фича не включена флажком
  //   'nothing'  — правило отработало, менять было нечего
  //   'unsafe'   — правило отказалось: небезопасно на этой модели
  //   'policy'   — уровень риска выше того, что применяется автоматически
  const addSkipped = (meta, v, reason, kind = 'nothing') => {
    for (const text of asLines(v)) result.skipped.push({ ruleId: meta.id, text, reason: reason ?? text, kind });
  };
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
    addFound(ENGINE_META.inputCompression, `input geometry is already compressed (${strippedCodecs.join(', ')}) — decompressed on load`);
    const reencodeNote = o.compress
      ? `re-encoded from scratch (${o.codec}), no double compression or hidden re-packing`
      : 'geometry exported uncompressed (no geometry compression option selected)';
    addApplied(ENGINE_META.inputCompression, `Removed input compression ${strippedCodecs.join(', ')} — ${reencodeNote}`);
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
        // Правило гейтится ОДНИМ конкретным opt-in флажком (meta.feature: 'ktx2'/'join'/
        // 'meshopt') — объясняем в отчёте, почему ничего не сделано. Раньше проверялось
        // tier==='advanced', из-за чего join/geometry-compress (tier 'basic', но тоже
        // opt-in c v0.1.1) молча пропускались без единой строки в отчёте — meta.feature
        // у них уже был выставлен для этого сообщения, просто условие на него не смотрело.
        // Правила-бандлы без единого feature (например safe-чистка на много правил
        // одновременно) остаются тихими — как и раньше.
        if (rule.meta.feature) {
          const reason = `feature "${rule.meta.feature}" is not enabled (advancedFeatures: ['${rule.meta.feature}'])`;
          addSkipped(rule.meta, `${rule.meta.title} — ${reason}`, reason, 'disabled');
        }
        continue;
      }
      if (!rule.fix) { addFound(rule.meta, renderLines(finding.text, locale)); continue; }
      const decision = rule.canFix ? rule.canFix(finding, ctx) : { safe: true };
      if (!decision.safe) {
        const reason = decision.messageId ? render(decision.messageId, decision.data, locale) : (decision.reason || '');
        addSkipped(rule.meta, `${rule.meta.title} — ${reason}`, reason, 'unsafe');
        continue;
      }
      const tier = finding.fixSafety || rule.meta.fixSafety;
      if (TIER_RANK[tier] > TIER_RANK[AUTOFIX_MAX_TIER] && !decision.force) {
        const reason = `safety level "${tier}" is not applied automatically`;
        addSkipped(rule.meta, `${rule.meta.title} — ${reason}`, reason, 'policy');
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
      addFound(rule.meta, renderLines(res.found, locale));
      addSkipped(rule.meta, renderLines(res.skipped, locale));
      addApplied(rule.meta, renderLines(res.details ?? res.detail, locale));
      // строки с безвозвратной потерей данных (§4d) — UI предупредит перед скачиванием
      addApplied(rule.meta, renderLines(res.irreversible, locale), { reversible: false, dataLoss: 'significant' });
    }
  };

  // -------- ПРОХОД 1 · БАЗОВЫЕ (фазы 1–3) --------
  // события onProgress фаз 1–3 шлём один раз (на базовом проходе): номера фаз
  // для потребителей остаются монотонными 1→5, контракт §4b не меняется
  progress({ type: 'phase', phase: 1, name: 'analysis' });
  log(`    phase 1/5 · analysis (rules: ${orderedRules.length}, active: ${activeCount})`);
  progress({ type: 'phase', phase: 2, name: 'plan' });
  log('    phase 2/5 · plan');
  const basicPlanned = analyzeAndPlan(basicPass);
  progress({ type: 'phase', phase: 3, name: 'apply' });
  log(`    phase 3/5 · apply · basic (${basicPlanned.length} fixes)`);
  await applyPlanned(basicPlanned);

  // *** CHECKPOINT: baseline-метрики после базовых оптимизаций ***
  // Дальше структура модели зафиксирована; расширениям разрешено менять только
  // кодирование (байты/VRAM). Сверка — в фазе 4 (addon.validate → compareBaseline),
  // расхождение блокирует запись.
  ctx.baselineMetrics = addon.baselineMetrics(ctx.document);
  log(`      baseline-checkpoint: ${addon.BASELINE_METRICS.map((k) => `${k}=${ctx.baselineMetrics[k]}`).join(', ')}`);

  // -------- ПРОХОД 2 · РАСШИРЕНИЯ (фазы 1–3 повторно, только advanced и отложенные) --------
  const advancedPlanned = analyzeAndPlan(advancedPass);
  if (advancedPlanned.length) log(`      extensions (${advancedPlanned.length} fixes)`);
  await applyPlanned(advancedPlanned);

  // -------- ФАЗА 4 · ВАЛИДАЦИЯ (весь ассет; при провале .glb НЕ записывается) --------
  progress({ type: 'phase', phase: 4, name: 'validation' });
  log('    phase 4/5 · validation');
  const glb = await addon.writeBytes(io, ctx.document); // байты будущего файла — в памяти, на диск пока ничего
  const after = addon.collectMetrics(await addon.readBytes(io, glb), glb.byteLength);
  await addon.validate({
    ctx, before, after, glbBytes: glb, src, result,
    advancedPlannedIds: advancedPlanned.map((p) => p.rule.meta.id),
    addFound, log,
  });

  const validationOk = !result.validation.some((x) => x.level === 'fail');

  // -------- ФАЗА 5 · ОТЧЁТ + запись (.glb пишем, если не dry-run и валидация прошла) --------
  // v0.1.1: раньше писали ТОЛЬКО если result.applied непуст — при старом всегда-активном
  // базовом наборе это не мешало (findings были почти всегда). При opt-in по умолчанию
  // passthrough (0 флажков, чистый вход) applied закономерно пуст — «нечего чинить» не
  // значит «не нужно записывать файл»: --none/--passthrough — легитимный запрошенный режим
  // (в т.ч. конвертация .gltf → .glb без изменений), должен отдавать реальный файл, а не
  // молчаливое «not written». Единственная причина не писать — провал валидации (или dry-run).
  progress({ type: 'phase', phase: 5, name: 'report' });
  log('    phase 5/5 · report');
  const writeAsset = !o.dryRun && validationOk;
  if (writeAsset) fs.writeFileSync(dst, glb);
  const reportName = addon.writeReport({ name: dstName, result, before, after, assetWritten: writeAsset, opts: o });

  result.file.written = writeAsset;
  result.file.reportPath = path.join(o.outDir, reportName);
  result.metrics = { before, after };
  result.status = validationOk ? 'ok' : 'fail'; // fail = валидация не прошла, .glb не записан
  return result;
}
