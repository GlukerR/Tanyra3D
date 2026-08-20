// core/engine.mts — формат-агностичный движок: пять фаз над массивом правил аддона
// (АНАЛИЗ → ПЛАН → ПРИМЕНЕНИЕ → ВАЛИДАЦИЯ → ОТЧЁТ). Движок ничего не знает о
// конкретных правилах и о формате модели — всё специфичное для формата он делегирует
// аддону (load/write/collectMetrics/baselineMetrics/validate/writeReport). Логика
// перенесена из optimize2.mjs без изменения поведения (docs/ARCHITECTURE.md §4b).
//
// Двухуровневая обработка: фазы 1–3 идут ДВУМЯ проходами — сначала базовые правила
// (tier basic, им можно менять структуру), затем checkpoint baseline-метрик, затем
// расширения (tier advanced — только сжатие/кодирование); фаза 4 строго сверяет
// структуру с checkpoint, расхождение блокирует запись.
//
// Переведён на TypeScript 2026-08-11, четвёртым — вместе с core/i18n. Перенос без
// изменения поведения: собранный core/engine.mjs отличается от прежнего оформлением,
// приведениями типов и ничем больше. Что перевод показал, чего не было видно в JSDoc:
// движок читает у опций поля `compress` и `codec`, которых в его собственном контракте
// нет, — они принадлежат glTF-аддону. Это давняя протечка формата в ядро; тут она
// сохранена как есть (перенос ≠ переделка) и помечена на месте, чтобы не забылась.

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
import { TIER_RANK, AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline, isKnownTier } from './contract.mjs';

// Реэкспорт: снаружи движок по-прежнему отдаёт эти имена, менять импорты незачем.
export { AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline };

import type {
  Addon,
  AppliedEntry,
  Context,
  FindingEntry,
  FoundMeta,
  FixResult,
  I18nRefs,
  Message,
  MessageRef,
  NormalizedOpts,
  ReportLines,
  Rule,
  RunResult,
  SkipKind,
  SkippedEntry,
} from './types.mjs';

// Три узких описания «того, от чьего имени идёт запись» — по одному на канал отчёта.
// Одного общего мало: у записи в «Найдено» обязаны быть категория и важность, у записи
// в «Применено» — обратимость, а addExclusiveConflicts собирает заготовку из трёх полей
// и ни того ни другого не имеет. Правило (RuleMeta) и ENGINE_META подходят под нужные
// им формы целиком — общий предок не нужен, важна форма, а не происхождение.
//
// Разделение это не украшение: пока меты были одной широкой формой со всеми полями
// необязательными, компилятор требовал приводить их к строке — и в собранном коде
// вместо отсутствующей категории появлялось бы слово «undefined». Узкая форма
// требует поле там, где оно и правда нужно, и приведения исчезают.

/** → «Пропущено (и почему)». title/titleKey нужны строке «Заголовок — причина». */
interface SkipMeta {
  id: string;
  title?: string;
  titleKey?: string;
  feature?: string | undefined;
}

/** → «Применено». Обратимость по §4d. */
interface AppliedMeta {
  id: string;
  fixSafety: string;
  reversible?: boolean;
  dataLoss?: string;
}

/** Переопределение полей обратимости для отдельных строк (см. addApplied). */
interface AppliedOverrides {
  fixSafety?: string | undefined;
  reversible?: boolean;
  dataLoss?: string;
}

const asLines = (v: ReportLines | undefined | null): Message[] => (
  v == null ? [] : Array.isArray(v) ? v : [v]
);

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
interface Entry { text: string; ref: MessageRef | null }

const entriesOf = (v: ReportLines | undefined | null, locale: string | undefined): Entry[] =>
  asLines(v).map((x) => (typeof x === 'string'
    ? { text: x, ref: null }
    : { text: render(x.messageId, x.data, locale), ref: { messageId: x.messageId, data: x.data ?? {} } }));

// Рецепты складываются в ОДНО поле i18n: { поле записи → рецепт }. Отдельными ключами
// messageId/data было бы не выразить, что у skipped рецепт нужен и тексту, и причине.
// Записи без рецептов поля не получают вовсе — пустой ключ только мусорил бы отчёт.
const withRefs = <T extends { i18n?: I18nRefs }>(rec: T, refs: Record<string, MessageRef | null>): T => {
  const i18n: I18nRefs = {};
  for (const [field, ref] of Object.entries(refs)) if (ref) i18n[field] = ref;
  if (Object.keys(i18n).length) rec.i18n = i18n;
  return rec;
};

// Ссылка на заголовок правила: у правил с titleKey он переводится, у остальных — нет.
// `as string` вместо String(): у правил без titleKey заголовок есть всегда, а приведение
// подменило бы его отсутствие словом «undefined» в отчёте — то есть спрятало бы дефект
// вместо того, чтобы дать ему проявиться так же, как до перевода.
const titleRef = (meta: SkipMeta): Message => (
  meta.titleKey ? { messageId: meta.titleKey, data: {} } : (meta.title as string)
);

// Строка «Заголовок правила — причина». Собирается сообщением, а не склейкой на месте:
// иначе половина строки (заголовок) была бы непереводимой при смене языка, а тире между
// частями стало бы намертво зашитым в код разделителем, который другому языку может и
// не подойти.
const skipLine = (meta: SkipMeta, reason: Message): MessageRef => ({
  messageId: 'engine.skipped.line',
  data: { title: titleRef(meta), reason },
});

// Топологическая сортировка по meta.runAfter (устойчивая: при равенстве — порядок массива).
//
// Список приходит ПОЛНЫЙ (все правила аддона) — выключенные отсеиваются позже, на прогоне.
// Значит зависимость, которой нет в списке, — не «выключённая», а опечатка. Раньше такая
// считалась выполненной, и `geometry/dedpe` вместо `geometry/dedupe` давал не ошибку
// настройки, а ТИХО ДРУГОЙ ПОРЯДОК — при том, что у части transforms порядок жёсткий и
// менять его нельзя. Найдено ревью 2026-08-10 (P0.4).
//
// Ошибка здесь — про сборку программы, а не про модель человека: до пользователя дойти
// не может, её ловят тесты. Поэтому исключение, а не пропуск правила.
export function orderRules(rules: Rule[]): Rule[] {
  const ids = new Set(rules.map((r) => r.meta.id));
  for (const r of rules) {
    const deps = r.meta.runAfter || [];
    const seen = new Set<string>();
    for (const d of deps) {
      if (!ids.has(d)) throw new Error(`unknown runAfter dependency "${d}" in rule "${r.meta.id}"`);
      if (d === r.meta.id) throw new Error(`rule "${r.meta.id}" depends on itself in runAfter`);
      if (seen.has(d)) throw new Error(`duplicate runAfter dependency "${d}" in rule "${r.meta.id}"`);
      seen.add(d);
    }
  }
  const done = new Set<string>();
  const pending = [...rules];
  const out: Rule[] = [];
  while (pending.length) {
    const i = pending.findIndex((r) => (r.meta.runAfter || []).every((d) => done.has(d)));
    if (i === -1) throw new Error(`cycle in runAfter: ${pending.map((r) => r.meta.id).join(', ')}`);
    // splice по найденному индексу всегда вернёт ровно один элемент; компилятор об этом
    // не знает (noUncheckedIndexedAccess), отсюда `!`. Проверкой во время работы это не
    // делаем намеренно: лишняя ветка в собранном коде — уже не перенос, а правка.
    const [r] = pending.splice(i, 1);
    done.add(r!.meta.id);
    out.push(r!);
  }
  return out;
}

// ============================================================================
// ПРОГОН ОДНОГО ФАЙЛА через аддон. Возвращает RunResult (контракт §4b).
// Исключения наружу не летят: превращаются в status:'fail'.
//
// ДВА РАЗНЫХ «fail», и путать их нельзя (ревью 2026-08-10, P1.4):
//
//   1. Прогон не дошёл до конца — модель не читается, опция неизвестна, упало по дороге.
//      Признак: `result.error` заполнен. Файла нет, `file.written === false`.
//   2. Прогон дошёл, а результат не прошёл проверку целостности.
//      Признак: `error` пуст, `validation` содержит запись `level:'fail'`,
//      `file.written === true` — файл НА ДИСКЕ ЕСТЬ.
//
// Второе — намеренно (решение Александра 2026-07-30, см. фазу 5): отказ должен быть
// громким, а не запирающим. Спрашивающему «есть ли файл» отвечает `file.written`,
// а не статус: статус говорит о доверии к результату.
// ============================================================================
export async function runOptimize(
  addon: Addon,
  srcPath: string,
  opts: Record<string, unknown> = {},
): Promise<RunResult> {
  const src = path.resolve(String(srcPath));
  const dstName = addon.outputName(src);
  const result: RunResult = {
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
    const err = e as { message?: string } | null | undefined;
    result.status = 'fail';
    result.error = err && err.message ? err.message : String(e);
    return result;
  }
}

async function runFile(
  addon: Addon,
  src: string,
  dstName: string,
  o: NormalizedOpts,
  result: RunResult,
): Promise<RunResult> {
  // dst проставлен в runOptimize до вызова — приведение, а не проверка: проверка была бы
  // новой веткой в собранном коде.
  const dst = result.file.dst as string;
  if (!o.dryRun && !o.force && fs.existsSync(dst)) {
    result.status = 'skip';
    return result;
  }
  const progress = o.onProgress || (() => {});
  const log = o.log;
  const locale = o.locale;
  const addFound = (meta: FoundMeta, v: ReportLines | undefined | null): void => {
    for (const e of entriesOf(v, locale)) {
      result.findings.push(withRefs<FindingEntry>({ ruleId: meta.id, category: meta.category, severity: meta.severity, fixSafety: meta.fixSafety, text: e.text }, { text: e.ref }));
    }
  };
  // kind — почему пропущено. Нужен потребителю отчёта, чтобы отличать «пользователь
  // не включал» и «включено, но делать было нечего» от «отказались по безопасности».
  // Первые два для человека — не предупреждение, а тишина: показывать их наравне с
  // отказом значит топить единственную важную строку в перечислении небытия.
  // Полный список случаев и их смысл — SkipKind в core/types.mts.
  //
  // feature — та самая галочка (advancedFeatures), а не ruleId. Без неё интерфейсу
  // пришлось бы держать свою таблицу «правило → флажок», то есть знание движка,
  // которое разъедется при первом же переименовании правила.
  // reason принимает и готовую строку, и { messageId, data } — тогда причина тоже
  // переживает смену языка. Пропущенный reason означает «причина и есть сам текст».
  const addSkipped = (
    meta: SkipMeta,
    v: ReportLines | undefined | null,
    reason?: Message | null,
    kind: SkipKind = 'nothing',
  ): void => {
    const r = reason == null ? null : entriesOf(reason, locale)[0];
    for (const e of entriesOf(v, locale)) {
      result.skipped.push(withRefs<SkippedEntry>(
        { ruleId: meta.id, feature: meta.feature ?? null, text: e.text, reason: r ? r.text : e.text, kind },
        { text: e.ref, reason: r ? r.ref : e.ref },
      ));
    }
  };
  // Конфликт фич разрешает аддон (он знает свои группы и приоритеты), а движок
  // только честно отражает его в обычном канале skipped. Так HTTP/API-вызов не
  // может молча потерять выбор, а следующий формат получает тот же механизм без
  // знания glTF или конкретных кодеков.
  const addExclusiveConflicts = (): void => {
    for (const conflict of o.exclusiveConflicts || []) {
      const selected: MessageRef = { messageId: conflict.selected.titleKey, data: {} };
      for (const rejected of conflict.rejected || []) {
        const meta: SkipMeta = {
          id: conflict.ruleId,
          feature: rejected.feature,
          titleKey: rejected.titleKey,
        };
        const reason: MessageRef = {
          messageId: 'engine.feature.exclusive',
          data: { selected },
        };
        addSkipped(meta, skipLine(meta, reason), reason, 'exclusive');
      }
    }
  };
  // over — переопределение полей обратимости для отдельных строк (lossy-ветки правил,
  // см. res.irreversible): базовое поведение правила может быть без потерь, а форсированное — нет.
  //
  // fixSafety тоже переопределяется (ревью 2026-08-10, P1.5). Раньше он всегда брался
  // из meta, и запись о РАЗРУШИТЕЛЬНОЙ ветке несла ярлык безопасной: удаление
  // раскрашенных vertex colors отчитывалось как «provable», хотя человек только что
  // потерял данные. Ярлык в отчёте — не украшение: по нему интерфейс решает, что
  // показать перед выгрузкой.
  const addApplied = (
    meta: AppliedMeta,
    v: ReportLines | undefined | null,
    over: AppliedOverrides = {},
  ): void => {
    for (const e of entriesOf(v, locale)) {
      result.applied.push(withRefs<AppliedEntry>({
        ruleId: meta.id,
        fixSafety: over.fixSafety ?? meta.fixSafety,
        reversible: over.reversible ?? meta.reversible ?? false,
        dataLoss: over.dataLoss ?? meta.dataLoss ?? 'none',
        text: e.text,
      }, { text: e.ref }));
    }
  };

  fs.mkdirSync(o.outDir, { recursive: true });
  const io = await addon.createIO();

  // -------- загрузка: исходный файл НЕ трогаем никогда, работаем с копией в памяти --------
  const ctx: Context = {
    document: await addon.load(io, src),
    io,
    opts: o,
    src,
    outDir: o.outDir,
    dstName,
    cache: new Map(),
    log,
  };
  const before = addon.collectMetrics(ctx.document, addon.sourceBytes
    ? addon.sourceBytes(src)
    : fs.statSync(src).size);

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
    addFound(ENGINE_META.inputCompression!, { messageId: 'engine.inputCompression.found', data: { codecs } });
    // Вложенная подстановка: note — само сообщение, а не готовая строка. Иначе при
    // смене языка внешняя фраза перевелась бы, а её хвост остался прежним.
    //
    // compress/codec — поля glTF-аддона, движок читает их через индексную сигнатуру
    // опций. Протечка формата в ядро, замеченная при переводе на TypeScript и оставленная
    // как есть: чинить её нужно отдельной задачей, а не заодно с переносом.
    const reencodeNote: MessageRef = o.compress
      ? { messageId: 'engine.inputCompression.reencode', data: { codec: o.codec } }
      : { messageId: 'engine.inputCompression.noCompress', data: {} };
    addApplied(ENGINE_META.inputCompression!, { messageId: 'engine.inputCompression.applied', data: { codecs, note: reencodeNote } });
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
  const basicPass: Rule[] = [];
  const advancedPass: Rule[] = [];
  const deferredIds = new Set<string>(); // id правил, реально выполняющихся во втором проходе
  for (const rule of orderedRules) {
    const dependsOnDeferred = (rule.meta.runAfter || []).some((d) => deferredIds.has(d));
    if (rule.meta.tier === 'advanced' || dependsOnDeferred) {
      advancedPass.push(rule);
      if (rule.meta.enabled(o)) deferredIds.add(rule.meta.id);
    } else {
      basicPass.push(rule);
    }
  }

  interface Planned { rule: Rule; finding: ReturnType<Rule['analyze']>[number] }

  // Фазы 1–2 одного прохода: АНАЛИЗ (только чтение; анализируются и невыбранные
  // расширения — их находки видны в отчёте, advanced ≠ невидимый) + ПЛАН.
  const analyzeAndPlan = (rules: Rule[]): Planned[] => {
    const findings: Planned[] = [];
    for (const rule of rules) {
      for (const f of rule.analyze(ctx)) findings.push({ rule, finding: f });
    }
    const planned: Planned[] = [];
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
          const reason: MessageRef = { messageId: 'feature.notEnabled', data: { feature: rule.meta.feature } };
          addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'disabled');
        }
        continue;
      }
      // Правило БЕЗ починки — чистое наблюдение: находка идёт в «Анализ» как есть.
      //
      // Передаётся САМА находка, а не `finding.text`. Разница решающая (2026-08-15):
      // находка — это `{ messageId, data }`, а `text` у неё пуст и пустым останется,
      // потому что готовой строке в правиле взяться неоткуда — Правило 8 запрещает
      // пользовательский текст в логике. Здесь стояло `finding.text`, и наблюдение
      // молча пропадало: правило отрабатывало, находку возвращало, в отчёт не
      // попадало ничего. Ветка не работала ни разу — правил без починки в проекте
      // до сих пор не было, и первое же (scene/lod-levels) на это наткнулось.
      //
      // entriesOf раскрывает messageId в строку И сохраняет рецепт, поэтому такая
      // находка переживает смену языка наравне с остальными.
      if (!rule.fix) { addFound(rule.meta, finding); continue; }
      const decision = rule.canFix ? rule.canFix(finding, ctx) : { safe: true };
      if (!decision.safe) {
        const reason: Message = decision.messageId
          ? { messageId: decision.messageId, data: decision.data || {} }
          : (decision.reason || '');
        addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'unsafe');
        continue;
      }
      const tier = finding.fixSafety || rule.meta.fixSafety;
      // Неизвестный уровень не пропускаем даже по force: force — это «я знаю, что этот
      // фикс lossy, и всё равно хочу», а не «применяй что попало». Про уровень, которого
      // движок не знает, никто ничего не знает.
      if (!isKnownTier(tier)) {
        const reason: MessageRef = { messageId: 'engine.policy.unknownSafetyLevel', data: { tier: String(tier) } };
        addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'policy');
        continue;
      }
      if (TIER_RANK[tier] > TIER_RANK[AUTOFIX_MAX_TIER] && !decision.force) {
        const reason: MessageRef = { messageId: 'engine.policy.safetyLevel', data: { tier } };
        addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'policy');
        continue;
      }
      planned.push({ rule, finding });
    }
    return planned;
  };

  // Фаза 3 одного прохода: ПРИМЕНЕНИЕ (по порядку, меняем рабочую копию)
  const applyPlanned = async (planned: Planned[]): Promise<void> => {
    for (const { rule, finding } of planned) {
      const titleText = rule.meta.titleKey ? render(rule.meta.titleKey, {}, locale) : rule.meta.title;
      progress({ type: 'rule', phase: 3, ruleId: rule.meta.id, title: titleText });
      log(`      • ${titleText}`);
      // Сюда доходят только правила с fix (см. analyzeAndPlan); компилятору это
      // приходится сказать отдельно.
      const res: FixResult = (await rule.fix!(finding, ctx)) || {};
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
        const reason: MessageRef = { messageId: 'engine.nothingToDo', data: { feature: rule.meta.feature } };
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
      // Строки с безвозвратной потерей данных (§4d) — UI предупредит перед скачиванием.
      //
      // Уровень безопасности такой строки правило называет само (res.irreversibleSafety).
      // Единого ответа тут нет: у «объединить меши» потеря структурная, но пиксели те
      // же — это не lossy; у «удалить раскрашенные цвета» данные исчезли совсем.
      // Не сказало — остаётся уровень правила, как было до 2026-08-10.
      addApplied(rule.meta, res.irreversible, {
        reversible: false,
        dataLoss: 'significant',
        fixSafety: res.irreversibleSafety,
      });
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
  log(`      baseline-checkpoint: ${addon.BASELINE_METRICS.map((k) => `${k}=${ctx.baselineMetrics![k]}`).join(', ')}`);

  // -------- ПРОХОД 2 · РАСШИРЕНИЯ (фазы 1–3 повторно, только advanced и отложенные) --------
  const advancedPlanned = analyzeAndPlan(advancedPass);
  if (advancedPlanned.length) log(`      extensions (${advancedPlanned.length} fixes)`);
  await applyPlanned(advancedPlanned);

  // -------- ФАЗА 4 · ВАЛИДАЦИЯ (весь ассет; провал НЕ отменяет запись — см. фазу 5) --------
  progress({ type: 'phase', phase: 4, name: 'validation' });
  log('    phase 4/5 · validation');
  // src — ИСХОДНЫЙ файл, не промежуточное состояние: аддон обязан сверяться с тем, что
  // человек положил на вход (правило Александра 2026-08-15). См. writeBytes в addons/gltf.
  const glb = await addon.writeBytes(io, ctx.document, src); // байты будущего файла — в памяти, на диск пока ничего
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
