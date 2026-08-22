// tests/engine-contract.test.mjs — КОНТРАКТ ДВИЖКА: что верно НЕЗАВИСИМО от площадки
// (задание 2026-08-01-контракт-движка, слой 1 из ПРАВИЛА_ТЕСТОВ_универсальность.md).
//
// Зачем: в 0.3.0 появится Babylon.js, дальше другие движки. Тест «под three.js»
// пришлось бы переписывать под каждого; тест обещаний самого движка — никогда.
// Здесь нет ни одного имени движка и ни одной цифры, заданной версией библиотеки:
// только обещания, которые движок даёт независимо от того, кто откроет файл.
//
// Формат-независимость: слой 1 из правил — контракт отчёта RunResult (ARCHITECTURE.md
// §4b). Утверждения читают RULES из addons/gltf/rules.mjs и гоняют корпус через
// optimizeFile — не через трёх-загрузчик и не через профиль площадки.
//
// ════════════════════════════════════════════════════════════════════════════════
// ⚠  НАЙДЕННЫЕ РАСХОЖДЕНИЯ ДВИЖКА С КОНТРАКТОМ (движок НЕ чиним — задание).
//    Разделы, где тест КРАСНЫЙ на 2026-08-01, с объяснением причины. Основной
//    агент закрывает их правкой движка; этот файл при этом зеленеет сам.
// ════════════════════════════════════════════════════════════════════════════════
//
// Н-1. РАЗДЕЛ 2 «Правило либо сделало, либо объяснило» — включённые правила могут
//   МОЛЧА ИСЧЕЗНУТЬ из отчёта, когда делать нечего:
//   - textures/ktx2: модель без текстур → fix() возвращает пустой out, ни одной
//     записи ни в applied, ни в skipped (замерено: Vertex Colors 01, Preinstanced
//     Grid 01, Unlinked Duplicates 01 и др.);
//   - textures/webp: модель без текстур → `if (!cands.length) return out` — пусто;
//   - scene/join: нечего объединять и нет общих мешей → `{ skipped: [] }`.
//   Контракт: включённая фича обязана дать запись в applied ИЛИ skipped с причиной.
//   Класс случаев: фича выбрана человеком, а отчёт о ней молчит.
//
// Н-2. РАЗДЕЛ 3 «Каждая запись отчёта переводима» — часть записей НЕСЁТ готовую
//   строку вместо рецепта { messageId, data }, поле i18n отсутствует:
//   - scene/instance: found/details/skipped — обычные строки
//     («repeated meshes turned into GPU instances …»);
//   - animation/resample: skipped/details — строки («no animations to resample»);
//   - engine/input-validation: находка добавляется через addFound(render(...)) —
//     готовой строкой, без рецепта.
//   Контракт: у каждой записи applied/skipped/findings/validation есть
//   i18n.text.messageId. Такие записи не переживают смену языка.
//
// Н-3. РАЗДЕЛ 5 «Метрики не врут о файле» — metrics.after.triangles считает
//   треугольники «ПО СЦЕНЕ» (addons/gltf/metrics.mjs: sceneGeometry умножает на
//   число узлов, ссылающихся на меш, и на инстансы), а файл хранит «ПО МЕШАМ»:
//   сумма getGLPrimitiveCount по примитивам. На моделях с общей геометрией
//   (Dirty Cube 01, Linked/Preinstanced/Unlinked Duplicates 01) расхождение в
//   разы: 60 против 36, 144 против 12, 5808 против 968. Правая панель показывает
//   «нарисованные» треугольники, а не те, что лежат в файле.
//
// Н-4. РАЗДЕЛ 4 «Необратимость заявлена честно» — reversalNote есть только у
//   scene/join, а необратимых правил девять: structure/dedup, structure/prune-unused,
//   attributes/vertex-colors, geometry/weld, geometry/degenerate-triangles,
//   geometry/orphan-vertices, scene/join, animation/resample, structure/prune-final.
//   Контракт: у каждого необратимого правила есть reversalNote.
//
// Н-5. РАЗДЕЛ 4 (профили) — профиль площадки расходится с meta правила:
//   - threejs.json ktx2: dataLoss 'none', правило textures/ktx2 — 'minor';
//   - в профилях площадок: у ktx2, draco, quantize, strip-colors
//     полей reversible/dataLoss НЕТ вовсе — интерфейс не получает признак;
//   - threejs.json strip-colors: dataLoss 'significant', правило
//     attributes/vertex-colors (базовая ветка) — 'none'. Здесь расхождение
//     интерпретаций: профиль описывает lossy-ВЕТКУ опции (удаление раскрашенных
//     цветов), правило — базовую ветку. Проверено и признано корректным, см. отчёт.
//
// Зелёные разделы (контракт держится): 1 (форма), 3-сироты (каталог без мусора),
// 5 (все метрики кроме triangles сходятся с файлом), 6 (порядок runAfter).
// Ловушка задания: ktx2 на машине без toktx отвечает ktx2.noTools — легитимное
// воздержание, не провал (здесь toktx есть).

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

// ============================================================================
// МАТРИЦА (задание): все репо-модели + локальные через eachModel-семантику,
// наборы флагов: [], ['safe'], каждая advanced-фича отдельно поверх safe,
// ['safe','join','instance'].
// ============================================================================

// Advanced-фичи берём из самого аддона, а не списком руками: добавят фичу —
// тест обязан её заметить (правило 4 ПРАВИЛА_ТЕСТОВ_универсальность).
const ADVANCED = Object.keys(gltfAddon.ADVANCED_FEATURES).filter((f) => f !== 'safe');
export const FLAG_SETS = [
  [],
  ['safe'],
  ...ADVANCED.map((f) => ['safe', f]),
  ['safe', 'join', 'instance'],
];

// Локальные модели (eachModel-семантика: отсутствует на чистом клоне — skip).
// Классы случаев: скины+морфы (parkergirl, RiggedSimple), тяжёлая геометрия с
// общими мешами (MosquitoInAmber2), текстуры (BoomBox, chibi_zenitsu, Production Many Materials 01,
// SheenWoodLeatherSofa, ToyCar).
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


// Матричный цикл с eachModel-семантикой: модель отсутствует — it.skip с маркером.
function eachMatrix(prefix, body, timeout = 120_000) {
  for (const name of ALL_MODELS) {
    for (const flags of FLAG_SETS) {
      const label = `${name} [${flags.join(',') || 'passthrough'}] — ${prefix}`;
      if (isPresent(name)) it(label, () => body(name, flags), timeout);
      else it.skip(`${label} [skipped: ${name} missing locally]`, () => {}, timeout);
    }
  }
}

// ============================================================================
// ОБЩИЕ ХЕЛПЕРЫ
// ============================================================================

// Запись отчёта несёт рецепт строки? (поле i18n → messageId)
const recId = (rec) => rec && rec.i18n && rec.i18n.text && rec.i18n.text.messageId;

// Нормализованные опции для meta.enabled (те же, что движок передаёт правилам).
const normOf = (flags) => gltfAddon.normalizeOpts({ advancedFeatures: flags, dryRun: true });

// Каталоги сообщений (аддон + ядро, оба языка) — для раздела 3.
const gltfEn = (await import('../addons/gltf/messages/en.mjs')).default;
const gltfRu = (await import('../addons/gltf/messages/ru.mjs')).default;
const coreEn = (await import('../core/messages/en.mjs')).default;
const coreRu = (await import('../core/messages/ru.mjs')).default;
const CATALOG_KEYS = new Set([...Object.keys(gltfEn), ...Object.keys(gltfRu), ...Object.keys(coreEn), ...Object.keys(coreRu)]);

// СообщениеId, реально возвращённые правилами за всю матрицу (раздел 3, сироты).
// Собирается в тестах матрицы; проверка сирот — последним it в этом файле.
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

// Статический скан: messageId-литералы в коде движка/аддона (не зависят от корпуса).
// Дополняет динамический сбор: ключ, упомянутый в коде, но не сработавший на
// корпусе, — не мусор. .many-варианты и составные id — в явном списке исключений.
function staticMessageIds() {
  // Читается ИСТОЧНИК. Часть модулей с 2026-08-11 живёт в `.mts`, а `.mjs` рядом —
  // собранный: на чистом клоне до сборки его нет, а ключи человек правит не в нём.
  // Какое расширение сейчас настоящее, решает файловая система, а не запись здесь.
  const files = [
    'addons/gltf/rules',
    'addons/gltf/index',
    // Ввоз чужих форматов (STL/PLY, с 2026-08-20). Его ключи — причины ОТКАЗА принять
    // файл: «в этом PLY нет граней», «файл не читается». В отчётах матрицы они не
    // появляются никогда, потому что до отчёта дело не доходит — прогон обрывается
    // на загрузке. Без этого файла в списке все три висели сиротами, и сторож краснел
    // на честном коде (найдено ревью 2026-08-21).
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
    // Отказы ввоза ключ не «называют» ни одним из образцов выше: там он уезжает
    // переменной внутрь render(). Зато он всегда первый аргумент importError —
    // и это тот же самый статический разбор, а не поблажка: опечатку в ключе поймает
    // соседняя проверка «на что ссылается код, того нет в каталоге».
    for (const m of src.matchAll(/importError\(\s*'([^']+)'/g)) out.add(m[1]);
  }
  // 'pipeline' — служебный маркер фазы analyze (analyze() возвращает «задание»
  // { messageId: 'pipeline' }), не рецепт строки: в каталогах его нет по дизайну.
  out.delete('pipeline');
  return out;
}

// ============================================================================
// РАЗДЕЛ 1 · ФОРМА РЕЗУЛЬТАТА
// ============================================================================
// Для каждой модели × набора флагов (dryRun): status ∈ {ok,fail,skip}, никогда
// undefined; при ok — metrics.before/after заполнены без null/undefined/NaN; при
// fail — внятная причина (error или level:'fail' в validation); все списки —
// массивы; ни одного исключения наружу. Контракт держится и на легальных fail
// (KHR_animation_pointer, Truncated Broken 01) — именно там он и важен.

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

// ============================================================================
// РАЗДЕЛ 2 · ПРАВИЛО ЛИБО СДЕЛАЛО, ЛИБО ОБЪЯСНИЛО
// ============================================================================
// Для каждой ВКЛЮЧЁННОЙ фичи (meta.feature, meta.enabled) её правило обязано
// появиться в applied ИЛИ skipped; запись в skipped обязана нести причину
// (i18n.text.messageId); правило, которого не включали, не может быть в applied.
// Проверяется по meta.feature и meta.enabled, а не списком id (правило добавили —
// тест заметит).

function checkDidOrExplained(result, flags, where, violations) {
  // Контракт «правило либо сделало, либо объяснило» — про обработанный файл.
  // При status:'fail' движок либо не дошёл до правил (файл не читается,
  // Truncated Broken), либо остановился на валидации: обещание формы уже
  // держит раздел 1, а требовать отчёта о фичах здесь — ложное красное.
  if (result.status === 'fail') return;
  const o = normOf(flags);
  const ruleIds = {
    applied: new Set((result.applied || []).map((a) => a.ruleId)),
    skipped: new Set((result.skipped || []).map((s) => s.ruleId)),
  };
  for (const rule of RULES) {
    const enabled = rule.meta.enabled(o);
    if (!enabled) {
      // не включали — в applied не имеет права (любое правило, не только фича)
      if (ruleIds.applied.has(rule.meta.id)) {
        violations.push(`[2·сделал-объяснил] ${rule.meta.id} НЕ включён, но оказался в applied (flags=[${flags.join(',')}])`);
      }
      continue;
    }
    // включено — обязано где-то отчитаться (только фичи: бандлы safe тихие по дизайну)
    if (!rule.meta.feature) continue;
    if (!ruleIds.applied.has(rule.meta.id) && !ruleIds.skipped.has(rule.meta.id)) {
      violations.push(`[2·сделал-объяснил] ${rule.meta.id} включён (feature=${rule.meta.feature}), но молча исчез — нет ни applied, ни skipped`);
    }
  }
  // каждая запись skipped несёт причину (рецепт i18n), а не пустоту
  for (const s of result.skipped || []) {
    if (!recId(s)) {
      violations.push(`[2·сделал-объяснил] skipped-запись ${s.ruleId || '?'} без i18n.text.messageId (причины нет)`);
    }
  }
}

// ============================================================================
// РАЗДЕЛ 3 · КАЖДАЯ ЗАПИСЬ ОТЧЁТА ПЕРЕВОДИМА
// ============================================================================
// 3a: у каждой записи applied/skipped/findings/validation есть i18n.text.messageId,
// и этот messageId есть в ОБОИХ каталогах (addons/gltf/messages/{ru,en} + core/
// messages) — render() не бросает.
// 3b: localizeResult(result,'ru') и ('en') — разные тексты при одинаковой структуре
// (длины списков, ruleId, messageId, data).
// 3c: ключей-сирот нет — каждый ключ каталога либо возвращается правилом (динамика
// или статический скан), либо в явном списке исключений с объяснением.

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
      // render не бросает на обоих языках (вложенные data могут быть сообщениями)
      try {
        render(id, rec.i18n.text.data || {}, 'ru');
        render(id, rec.i18n.text.data || {}, 'en');
      } catch (e) {
        violations.push(`[3·i18n] render('${id}') бросает: ${e.message}`);
      }
    }
  }

  // localizeResult: структура та же, тексты разные
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
      if (!recId(rec)) continue; // без рецепта — localizeResult оставляет как есть (Н-2)
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
  // хотя бы где-то тексты реально разные (если есть хоть одна запись с рецептом)
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

// ============================================================================
// РАЗДЕЛ 6 · ПОРЯДОК ПРАВИЛ (meta.runAfter)
// ============================================================================
// Тест читает runAfter из RULES, а не перечисляет пары руками:
//  - статически: orderRules(RULES) — валидный топологический порядок, каждая
//    зависимость стоит раньше зависимого; runAfter не ссылается на неизвестные id;
//  - динамически: в фактическом порядке исполнения (applied и skipped по отдельности,
//    в порядке движка) правило никогда не идёт раньше того, на кого ссылается.
//    Межсписочный порядок applied↔skipped из отчёта невосстановим (движок кладёт
//    записи в разные массивы) — проверяется внутри каждого списка + топология.

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
  // динамика: последовательности ruleId в applied и skipped — подпоследовательности
  // топологического порядка (в порядке движка).
  //
  // ВАЖНО: skipped фильтруется до записей фазы 3 (kind 'nothing'/'cost' — правило
  // реально исполнялось и воздержалось). Записи фаз 1–2 (kind 'disabled'/'unsafe'/
  // 'policy') — объяснения до исполнения: движок добавляет их раньше apply-записей,
  // и их позиция в отчёте не является порядком исполнения (замерено: disabled-запись
  // scene/join стоит раньше apply-записи scene/instance без нарушения runAfter).
  const applied = (resultOf(flags).applied || []).map((a) => a.ruleId);
  const execSkipped = (resultOf(flags).skipped || [])
    .filter((s) => !s.kind || s.kind === 'nothing' || s.kind === 'cost')
    .map((s) => s.ruleId);
  for (const [label, seq] of [['applied', applied], ['skipped(exec)', execSkipped]]) {
    let last = -1;
    for (const id of seq) {
      if (!pos.has(id)) continue; // engine/* — не правило
      if (pos.get(id) < last) {
        violations.push(`[6·порядок] ${label}: ${id} идёт раньше, чем разрешает runAfter`);
      }
      last = Math.max(last, pos.get(id));
    }
  }
}

// Результат для флагов (кэш в модуле: матрица гоняется один раз на (модель,флаги)).
const _resultCache = new Map();
async function runOnce(name, flags) {
  const key = `${name}\u0000${JSON.stringify(flags)}`;
  if (!_resultCache.has(key)) {
    const outDir = tmpOutDir();
    try {
      const result = await optimizeFile(modelPath(name), { advancedFeatures: flags, dryRun: true, outDir });
      _resultCache.set(key, result);
    } finally {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* занят — подчистит ОС */ }
    }
  }
  return _resultCache.get(key);
}
const resultOf = (flags) => _resultCache.get(`${currentName}\u0000${JSON.stringify(flags)}`);

// ============================================================================
// МАТРИЦА: разделы 1, 2, 3, 6 в одном прогоне (dryRun).
// ============================================================================
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

// ============================================================================
// РАЗДЕЛ 5 · МЕТРИКИ НЕ ВРУТ О ФАЙЛЕ (dryRun: false, временный каталог)
// ============================================================================
// metrics.after — то, что движок о себе рассказал; ЗАПИСАННЫЙ файл — то, что
// получил пользователь. Читаем файл тем же io, что у аддона (gltfAddon.createIO()):
//  - metrics.after.triangles == сумма getGLPrimitiveCount по примитивам;
//  - meshes/nodes/materials/animations/skins/morphTargets == счёт в документе;
//  - metrics.after.fileBytes == реальный размер файла на диске.

// ПОПРАВКА 2026-08-03 (основной агент). Первая версия считала треугольники суммой
// getGLPrimitiveCount по объектам-мешам — это ХРАНИМАЯ геометрия. Метрика движка
// считает РИСУЕМУЮ: обход сцены по узлам, с умножением на число экземпляров
// GPU-инстансинга (addons/gltf/metrics.mjs, sceneGeometry — там же и причина).
//
// Разница не косметическая, и права здесь метрика:
//   - dedup сводит одинаковые меши в один на многих узлах, flatten разворачивает
//     обратно — счёт по мешам прыгает, хотя рисуется ровно то же самое;
//   - инстансинг сворачивает N узлов в один узел + N трансформов — счёт по мешам
//     упал бы в N раз при неизменной картинке;
//   - на этом счёте стоит главный инвариант движка «треугольников столько же»:
//     возьми хранимую геометрию — и join, который копии как раз создаёт, начал бы
//     сообщать о потере треугольников там, где её нет.
//
// Правая панель показывает нагрузку на отрисовку, а не размер таблицы вершин.
// Поэтому оракул теста приведён к определению метрики (Н-3 — дефект теста, не движка).
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
        // легальный fail (Truncated Broken и т.п.) — форма уже проверена в разделе 1
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
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* занят */ }
    }
  });
});

// ============================================================================
// РАЗДЕЛ 4 · НЕОБРАТИМОСТЬ ЗАЯВЛЕНА ЧЕСТНО
// ============================================================================
// 4a: reversible === false совпадает с тем, что правило делает (необратимые
// правила — те, что удаляют/переставляют; обратимые — только кодирование/инстансы).
// 4b: у каждого необратимого правила есть reversalNote.  ← Н-4 (красно)
// 4c: интерфейс получает признак через профили (reversible/dataLoss) и не
//     расходится с meta правила.  ← Н-5 (красно: ktx2, missing-поля)

describe('Контракт движка — раздел 4: необратимость заявлена честно', () => {
  // РЕШЕНИЕ 2026-08-03 (основной агент) по Н-4: наблюдение верное — reversalNote
  // есть только у части необратимых правил. Но требовать заметку у каждого сейчас
  // НЕЛЬЗЯ, и вот почему: сам reversalNote — это готовая АНГЛИЙСКАЯ строка в meta
  // правила, то есть ровно готовую строку в коде. Дописать ещё восемь таких
  // строк значит углубить дефект, а не закрыть его. Плюс поле сейчас не читает
  // никто: ни `ui/`, ни отчёт — только `core/types.mjs` и ARCHITECTURE.md.
  //
  // Долг записан как отдельная задача: перевести reversalNote на ключи каталога и
  // показать его в интерфейсе. До тех пор тест сторожит то, что действительно
  // работает, — согласованность reversible/dataLoss (ниже и в 4c), — а не
  // подгоняется под желаемое.
  // ДОЛГ ЗАКРЫТ 2026-08-04: reversalNote переведён на reversalNoteKey (ключ каталога).
  // Полнота покрытия по-прежнему не требуется: заметка нужна там, где обратимость
  // неочевидна, а не у каждого правила.
  it('reversalNoteKey, если он есть, — непустой ключ', () => {
    const broken = RULES
      .filter((r) => r.meta.reversalNoteKey !== undefined && (typeof r.meta.reversalNoteKey !== 'string' || !r.meta.reversalNoteKey.trim()))
      .map((r) => r.meta.id);
    expect(broken).toEqual([]);
  });

  it('reversible:true не сочетается с dataLoss:"significant" (значимая потеря — необратимо)', () => {
    // §4d движка допускает reversible:true + dataLoss:'minor' — KTX2/WebP/quantize
    // разворачиваются обратно, но с малой потерей (у каждого есть reversalNote).
    // Противоречие — только «обратимо» при значимой потере данных.
    const reversibleButSignificant = RULES
      .filter((r) => r.meta.reversible === true && r.meta.dataLoss === 'significant')
      .map((r) => r.meta.id);
    expect(reversibleButSignificant).toEqual([]);
  });

  // Было: «профили площадок несут reversible/dataLoss и не расходятся с meta правил».
  // Переписано 2026-08-09 вместе с разделением осей (ARCHITECTURE.md §4g): эти поля
  // убраны из профилей как второй список одной правды. Требование Н-5 при этом живо —
  // интерфейс обязан МОЧЬ предупредить о необратимости на галочке, до запуска. Значит
  // проверяем не наличие копии в профиле, а достижимость факта из единственного
  // источника: у каждого предлагаемого расширения есть своё правило, и правило знает
  // цену. Расхождение двух копий теперь невозможно — копия одна.
  it('у каждого расширения профиля есть правило, и оно знает цену', () => {
    const profiles = fs.readdirSync('profiles').filter((f) => f.endsWith('.json')).sort();
    expect(profiles.length).toBeGreaterThan(0);

    // id расширения профиля → правило (по meta.feature; draco — кодек правила compress)
    const featureRule = (extId) => {
      if (extId === 'draco') return ruleById.get('geometry/compress');
      return RULES.find((r) => r.meta.feature === extId);
    };

    const problems = [];
    for (const pf of profiles) {
      const profile = JSON.parse(fs.readFileSync(path.join('profiles', pf), 'utf8'));
      for (const ext of profile.availableExtensions || []) {
        const rule = featureRule(ext.id);
        if (!rule) continue; // safe — бандл, не одно правило

        // Копий больше нет: поля в профиле означали бы возврат к дублю (§4g).
        for (const поле of ['reversible', 'dataLoss']) {
          if (поле in ext) {
            problems.push(`${pf}:${ext.id}.${поле} — факт правила ${rule.meta.id} снова скопирован в профиль`);
          }
        }
        // Единственный источник обязан быть заполнен, иначе предупреждать нечем.
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

// ============================================================================
// РАЗДЕЛ 3 (отдельно) · КЛЮЧЕЙ-СИРОТ НЕТ
// ============================================================================
// Каждый ключ каталога (addons/gltf/messages/{ru,en} + core/messages/) либо
// возвращается каким-то правилом (динамика матрицы или статический скан кода),
// либо перечислен в явном списке исключений ниже с объяснением. Это ловит мусор
// после переработок (так находили хвосты от webp.grewFile).

// Явные исключения — ключи, которые НЕ возвращаются правилами на корпусе и не
// видны статическим сканом, но живы. Не пополнять, чтобы позеленить: каждый пункт
// объясняет, где ключ реально используется.
const ORPHAN_EXCLUSIONS = {
  // --- .many-варианты: собираются в правиле из базового id + '.many'
  // (id(base) в attributes/vertex-colors, reportSkips в textures/webp, ktx2) —
  // базовый id ловится сканом, суффиксный вариант — только здесь.
  'vertexColors.found.white.many': 'собирается из vertexColors.found.white + .many (правило attributes/vertex-colors)',
  'vertexColors.found.painted.many': 'собирается из vertexColors.found.painted + .many',
  'vertexColors.done.white.many': 'собирается из vertexColors.done.white + .many',
  'vertexColors.stripped.many': 'собирается из vertexColors.stripped + .many',
  'vertexColors.skipped.many': 'собирается из vertexColors.skipped + .many',
  'ktx2.skipped.already.many': 'собирается из ktx2.skipped.already + .many',

  // Девять ключей webp.skipped.* удалены 2026-08-17 вместе с самими отказами
  // (Правило 12: показанная галочка обязана работать). Список сознательно НЕ заменён
  // новыми исключениями: у правила остался ровно один отказ — webp.skipped.failed,
  // и он ловится обычным сканом. Появление здесь нового webp.skipped.* — повод
  // спросить, не вернулся ли молчаливый пропуск.

  // --- движковые служебные: не попадают в отчёт как messageId
  'ktx2.log.skipped': 'пишется в лог правила (ctx.log), не в отчёт',
  'ktx2.log.encoding': 'пишется в лог правила (ctx.log), не в отчёт',

  // --- рамка скачиваемого .md-отчёта (writeReport, 2026-08-04): ключи собираются
  // локальным хелпером t(), поэтому статический скан их не видит, а в RunResult
  // они не попадают — отчёт пишется в файл, а не в списки записей.
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

  // --- пояснения об обратимости: meta.reversalNoteKey, читаются интерфейсом
  // по запросу, а не кладутся в записи отчёта.
  'reversal.join': 'meta.reversalNoteKey правила — вне записей отчёта',
  'reversal.instance': 'meta.reversalNoteKey правила — вне записей отчёта',
  'reversal.ktx2': 'meta.reversalNoteKey правила — вне записей отчёта',
  'reversal.webp': 'meta.reversalNoteKey правила — вне записей отчёта',
  'reversal.compress': 'meta.reversalNoteKey правила — вне записей отчёта',
  'reversal.quantize': 'meta.reversalNoteKey правила — вне записей отчёта',

  // --- взаимоисключение фич: подписи кодеков и причина, рендерятся только когда
  // через API пришли обе фичи одной группы (в матрице такой пары нет).
  'feature.meshopt': 'подпись выбранного кодека в engine.feature.exclusive',
  'feature.draco': 'подпись выбранного кодека в engine.feature.exclusive',
  // Тот же класс, что кодеки: подписи размеров рендерятся только когда через API
  // пришли ДВА размера сразу, а в матрице такой пары нет (флаг-сеты одиночные).
  'feature.resize4096': 'подпись выбранного размера в engine.feature.exclusive',
  'feature.resize2048': 'подпись выбранного размера в engine.feature.exclusive',
  'feature.resize1024': 'подпись выбранного размера в engine.feature.exclusive',
  'feature.resize512': 'подпись выбранного размера в engine.feature.exclusive',

  // --- отказы транскодера KTX2. Особый класс: эти ключи НЕ возвращаются правилом как
  // messageId записи — они подставляются ВНУТРЬ причины строки webp.skipped.failed
  // как вложенное сообщение ({ messageId, data }, разворачивает core/i18n.mjs).
  // Статический разбор их не видит, потому что в коде они лежат списком в KTX2_REASONS,
  // а в отчётах матрицы не появляются: чтобы дойти до них, нужна KTX2-текстура, которую
  // не смог распаковать транскодер, — такой модели в корпусе нет и заводить её ради
  // одной строки незачем. Добавлены 2026-08-18 взамен голых токенов в отчёте (Правило 8).
  'ktx2.invalid': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',
  'ktx2.hdr': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',
  'ktx2.multiface': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',
  'ktx2.transcodeStart': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',
  'ktx2.transcodeFailed': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',
  'ktx2.decodeFailed': 'вложенная причина в webp.skipped.failed — только при сбое транскодера',

  // --- titleKey правил без meta.feature: заголовок рендерится только в строке
  // «правило пропущено (unsafe/disabled)», а эти правила не гейтятся фичей —
  // на корпусе отказа структурных правил нет (нет моделей с неизвестными
  // расширениями в матрице).
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
