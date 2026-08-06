// core/engine.mjs — формат-агностичный движок: пять фаз над массивом правил аддона
// (АНАЛИЗ → ПЛАН → ПРИМЕНЕНИЕ → ВАЛИДАЦИЯ → ОТЧЁТ). Движок ничего не знает о
// конкретных правилах и о формате модели — всё специфичное для формата он делегирует
// аддону (load/write/collectMetrics/baselineMetrics/validate/writeReport). Логика
// перенесена из optimize2.mjs без изменения поведения (docs/ARCHITECTURE.md §4b).
//
// Двухуровневая обработка: фазы 1–3 идут ДВУМЯ проходами — сначала базовые правила
// (tier basic, им можно менять структуру), затем checkpoint baseline-метрик, затем
// расширения (tier advanced — только сжатие/кодирование); фаза 4 строго сверяет
// структуру с checkpoint, расхождение блокирует запись.

import fs from 'node:fs';
import path from 'node:path';

import { register, render } from './i18n.mjs';
import enCoreMessages from './messages/en.mjs';
import ruCoreMessages from './messages/ru.mjs';

// Каталоги ядра регистрируются при импорте движка.
register('en', enCoreMessages);
register('ru', ruCoreMessages);

// Общий словарь движка и аддона (ARCH-001): политика автофикса, engine/*-находки,
// сверка baseline-checkpoint. Аддон берёт их оттуда же, а не из движка — иначе
// связь двусторонняя: движок зовёт аддон, аддон импортирует внутренности движка.
import { TIER_RANK, AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline } from './contract.mjs';

// Реэкспорт: снаружи движок по-прежнему отдаёт эти имена, менять импорты незачем.
export { AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline };

/** @typedef {import('./types.mjs').Addon} Addon */
/** @typedef {import('./types.mjs').RunResult} RunResult */

const asLines = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Строки правил приходят как { messageId, data } и рендерятся здесь: text в отчёте —
// по-прежнему готовая строка (контракт §4b). Вместе с ней сохраняется РЕЦЕПТ строки —
// тот же messageId и data.
//
// Зачем рецепт. Без него отчёт навсегда остаётся на языке, на котором собрали: человек
// переключает язык, итог и подписи переводятся, а списки сделанного и пропущенного —
// нет, и половина экрана остаётся чужой. Пересобирать модель ради перевода нельзя —
// смена языка не работа, а перерисовка. По рецепту те же строки собираются из готового
// результата за микросекунды (localizeResult в core/i18n.mjs).
//
// Готовая строка (без messageId) идёт как есть: пересобирать её не из чего.
const entriesOf = (v, locale) => asLines(v).map((x) => (typeof x === 'string'
  ? { text: x, ref: null }
  : { text: render(x.messageId, x.data, locale), ref: { messageId: x.messageId, data: x.data ?? {} } }));

// Рецепты складываются в ОДНО поле i18n: { поле записи → рецепт }. Отдельными ключами
// messageId/data было бы не выразить, что у skipped рецепт нужен и тексту, и причине.
// Записи без рецептов поля не получают вовсе — пустой ключ только мусорил бы отчёт.
const withRefs = (rec, refs) => {
  const i18n = {};
  for (const [field, ref] of Object.entries(refs)) if (ref) i18n[field] = ref;
  if (Object.keys(i18n).length) rec.i18n = i18n;
  return rec;
};

// Ссылка на заголовок правила: у правил с titleKey он переводится, у остальных — нет.
const titleRef = (meta) => (meta.titleKey ? { messageId: meta.titleKey, data: {} } : meta.title);

// Строка «Заголовок правила — причина». Собирается сообщением, а не склейкой на месте:
// иначе половина строки (заголовок) была бы непереводимой при смене языка, а тире между
// частями стало бы намертво зашитым в код разделителем, который другому языку может и
// не подойти.
const skipLine = (meta, reason) => ({
  messageId: 'engine.skipped.line',
  data: { title: titleRef(meta), reason },
});

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
  const addFound = (meta, v) => {
    for (const e of entriesOf(v, locale)) {
      result.findings.push(withRefs({ ruleId: meta.id, category: meta.category, severity: meta.severity, fixSafety: meta.fixSafety, text: e.text }, { text: e.ref }));
    }
  };
  // kind — почему пропущено. Нужен потребителю отчёта, чтобы отличать «пользователь
  // не включал» и «включено, но делать было нечего» от «отказались по безопасности».
  // Первые два для человека — не предупреждение, а тишина: показывать их наравне с
  // отказом значит топить единственную важную строку в перечислении небытия.
  //   'disabled' — фича не включена флажком
  //   'nothing'  — правило отработало, менять было нечего
  //   'unsafe'   — правило отказалось: небезопасно на этой модели
  //   'policy'   — уровень риска выше того, что применяется автоматически
  //   'cost'     — правило отработало, но дорого: результат вырос, и человеку надо
  //                показать цену рядом с той галочкой, которая её назначила
  //
  // feature — та самая галочка (advancedFeatures), а не ruleId. Без неё интерфейсу
  // пришлось бы держать свою таблицу «правило → флажок», то есть знание движка,
  // которое разъедется при первом же переименовании правила.
  // reason принимает и готовую строку, и { messageId, data } — тогда причина тоже
  // переживает смену языка. Пропущенный reason означает «причина и есть сам текст».
  const addSkipped = (meta, v, reason, kind = 'nothing') => {
    const r = reason == null ? null : entriesOf(reason, locale)[0];
    for (const e of entriesOf(v, locale)) {
      result.skipped.push(withRefs(
        { ruleId: meta.id, feature: meta.feature ?? null, text: e.text, reason: r ? r.text : e.text, kind },
        { text: e.ref, reason: r ? r.ref : e.ref },
      ));
    }
  };
  // Конфликт фич разрешает аддон (он знает свои группы и приоритеты), а движок
  // только честно отражает его в обычном канале skipped. Так HTTP/API-вызов не
  // может молча потерять выбор, а следующий формат получает тот же механизм без
  // знания glTF или конкретных кодеков.
  const addExclusiveConflicts = () => {
    for (const conflict of o.exclusiveConflicts || []) {
      const selected = { messageId: conflict.selected.titleKey, data: {} };
      for (const rejected of conflict.rejected || []) {
        const meta = {
          id: conflict.ruleId,
          feature: rejected.feature,
          titleKey: rejected.titleKey,
        };
        const reason = {
          messageId: 'engine.feature.exclusive',
          data: { selected },
        };
        addSkipped(meta, skipLine(meta, reason), reason, 'exclusive');
      }
    }
  };
  // over — переопределение полей обратимости для отдельных строк (lossy-ветки правил,
  // см. res.irreversible): базовое поведение правила может быть без потерь, а форсированное — нет
  const addApplied = (meta, v, over = {}) => {
    for (const e of entriesOf(v, locale)) {
      result.applied.push(withRefs({
        ruleId: meta.id,
        fixSafety: meta.fixSafety,
        reversible: over.reversible ?? meta.reversible ?? false,
        dataLoss: over.dataLoss ?? meta.dataLoss ?? 'none',
        text: e.text,
      }, { text: e.ref }));
    }
  };

  fs.mkdirSync(o.outDir, { recursive: true });
  const io = await addon.createIO();

  // -------- загрузка: исходный файл НЕ трогаем никогда, работаем с копией в памяти --------
  const ctx = {
    document: await addon.load(io, src),
    io,
    opts: o,
    // Путь к ИСХОДНОМУ файлу. Нужен правилам, которым важно то, что осталось за бортом
    // разбора: список расширений из самого файла нельзя восстановить по документу —
    // неизвестное расширение библиотека при загрузке просто отбрасывает.
    src,
    outDir: o.outDir,
    dstName,
    cache: new Map(),
    log,
  };
  const before = addon.collectMetrics(ctx.document, fs.statSync(src).size);

  // До правил: проигравшая фича не должна зависеть от наличия геометрии или от
  // того, вернуло ли правило свою запись. Сам конфликт уже произошёл на входе.
  addExclusiveConflicts();

  // Входное сжатие геометрии снимаем сразу после загрузки (данные уже распакованы в память).
  // Иначе расширение остаётся на документе и КАЖДАЯ запись (включая tmp для KTX2) молча
  // пережимает геометрию заново — Draco лосси по связности, потери накапливаются.
  // Граничный случай из ARCHITECTURE.md §6: «Draco vs Meshopt already present — не стекировать».
  const strippedCodecs = addon.stripInputCompression(ctx.document);
  if (strippedCodecs.length) {
    const codecs = strippedCodecs.join(', ');
    addFound(ENGINE_META.inputCompression, { messageId: 'engine.inputCompression.found', data: { codecs } });
    // Вложенная подстановка: note — само сообщение, а не готовая строка. Иначе при
    // смене языка внешняя фраза перевелась бы, а её хвост остался прежним.
    const reencodeNote = o.compress
      ? { messageId: 'engine.inputCompression.reencode', data: { codec: o.codec } }
      : { messageId: 'engine.inputCompression.noCompress', data: {} };
    addApplied(ENGINE_META.inputCompression, { messageId: 'engine.inputCompression.applied', data: { codecs, note: reencodeNote } });
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
          const reason = { messageId: 'feature.notEnabled', data: { feature: rule.meta.feature } };
          addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'disabled');
        }
        continue;
      }
      if (!rule.fix) { addFound(rule.meta, finding.text); continue; }
      const decision = rule.canFix ? rule.canFix(finding, ctx) : { safe: true };
      if (!decision.safe) {
        const reason = decision.messageId
          ? { messageId: decision.messageId, data: decision.data || {} }
          : (decision.reason || '');
        addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'unsafe');
        continue;
      }
      const tier = finding.fixSafety || rule.meta.fixSafety;
      if (TIER_RANK[tier] > TIER_RANK[AUTOFIX_MAX_TIER] && !decision.force) {
        const reason = { messageId: 'engine.policy.safetyLevel', data: { tier } };
        addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'policy');
        continue;
      }
      planned.push({ rule, finding });
    }
    return planned;
  };

  // Фаза 3 одного прохода: ПРИМЕНЕНИЕ (по порядку, меняем рабочую копию)
  const applyPlanned = async (planned) => {
    for (const { rule, finding } of planned) {
      const titleText = rule.meta.titleKey ? render(rule.meta.titleKey, {}, locale) : rule.meta.title;
      progress({ type: 'rule', phase: 3, ruleId: rule.meta.id, title: titleText });
      log(`      • ${titleText}`);
      const res = (await rule.fix(finding, ctx)) || {};
      // Включённая фича не может молча исчезнуть из отчёта. Правило, которому
      // нечего было делать, раньше возвращало пустой результат — и человек,
      // поставивший галочку, не находил о ней ни строчки: сработало? не сработало?
      // Отвечаем за него один раз здесь, а не в каждом правиле по отдельности:
      // так это верно и для правил, которых ещё нет.
      //
      // Спрашиваем только про правила с feature: правила-бандлы без галочки
      // (safe-чистка) человек не включал поимённо, и молчать им можно.
      const saidSomething = [res.found, res.skipped, res.cost, res.details, res.detail, res.irreversible]
        .some((v) => (Array.isArray(v) ? v.length > 0 : v != null));
      if (!saidSomething && rule.meta.feature) {
        const reason = { messageId: 'engine.nothingToDo', data: { feature: rule.meta.feature } };
        addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'nothing');
      }
      addFound(rule.meta, res.found);
      addSkipped(rule.meta, res.skipped);
      // res.cost — «правило отработало, но дорого»: результат вырос. Отдельный канал,
      // а не res.skipped, потому что смысл противоположный: там «не сделали», здесь
      // «сделали, и вот цена». Интерфейс вешает по таким записям красный знак прямо
      // на галочку, которая эту цену назначила (поле feature).
      addSkipped(rule.meta, res.cost, undefined, 'cost');
      addApplied(rule.meta, res.details ?? res.detail);
      // строки с безвозвратной потерей данных (§4d) — UI предупредит перед скачиванием
      addApplied(rule.meta, res.irreversible, { reversible: false, dataLoss: 'significant' });
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
  // молчаливое «not written».
  //
  // 2026-07-30, решение Александра: провал проверки целостности тоже больше НЕ отменяет
  // запись. Раньше пайплайн решал за человека — «результат мне не нравится, файла не
  // будет», — и на выходе не оставалось ничего, даже посмотреть, насколько всё плохо.
  // Отказ должен быть громким, а не запирающим: статус остаётся `fail`, проверка
  // по-прежнему красная, но файл на диске есть и его можно выгрузить, если человека
  // расхождение устраивает. Единственная причина не писать теперь — dry-run.
  progress({ type: 'phase', phase: 5, name: 'report' });
  log('    phase 5/5 · report');
  const writeAsset = !o.dryRun;
  if (writeAsset) fs.writeFileSync(dst, glb);
  const reportName = addon.writeReport({ name: dstName, result, before, after, assetWritten: writeAsset, opts: o });

  result.file.written = writeAsset;
  result.file.reportPath = path.join(o.outDir, reportName);
  result.metrics = { before, after };
  // fail = проверка целостности не прошла. Файл при этом записан (см. выше) — статус
  // говорит о доверии к результату, а не о наличии файла. Наличие — result.file.written.
  result.status = validationOk ? 'ok' : 'fail';
  return result;
}
