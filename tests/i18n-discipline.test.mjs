// tests/i18n-discipline.test.mjs — сторож Правила 8 (CLAUDE.md): ни одной готовой
// пользовательской строки в движке. Задание: assistants/test/ЗАДАНИЕ_2026-08-03-долг-правила-8.md.
//
// Четыре направления, каждое ловит свою возможность появления готовой строки:
//   1. Динамика (на всём корпусе × наборах флагов): каждая запись отчёта
//      (applied / skipped / findings / validation) несёт рецепт i18n.text.messageId;
//      сообщение об ошибке называет правило и текст записи.
//   2. Статика: в addons/gltf/rules.mjs, addons/gltf/index.mjs, core/engine.mjs нет
//      строковых литералов, похожих на фразу для человека; кириллицы в коде нет
//      вовсе. Плюс titleKey у всех правил. Долг meta.reversalNote — отдельным тестом.
//   3. Каталоги: у ключа с подстановкой { n } есть форма единственного числа
//      (BUG-008: «1 текстур»), и у каждого .many-варианта есть базовый ключ.
//   4. localizeResult: смена языка ничего не пересчитывает (структура, числа и
//      metrics те же), и render() не склеивается с конкатенацией в коде.
//
// Уже покрыто соседями, здесь НЕ дублируется: en↔ru симметрия и сироты каталогов —
// tests/locale-keys-symmetry.test.mjs и engine-contract (раздел 3); «правило либо
// сделало, либо объяснило» — engine-contract (раздел 2).
//
// ═══════════════════════════════════════════════════════════════════════════
//  ТЕКУЩИЕ НАХОДКИ (тесты КРАСНЫЕ; движок/каталоги НЕ чиним — задание, правка —
//  работа основного агента). Причина каждой — в отчёте задания снизу
//  ЗАДАНИЕ_2026-08-03-долг-правила-8.md.
//
//  Р-2а (статический скан фраз). Готовые английские строки в коде движка:
//    - addons/gltf/index.mjs ADVANCED_FEATURES — 10 описаний фич (строки 72–81);
//    - addons/gltf/index.mjs:91 «Unknown advancedFeatures: ...» — текст ошибки;
//    - addons/gltf/index.mjs writeReport — шаблон .md-отчёта: заголовки
//      «# Optimization report», «## Found (issues)», «## Skipped (and why)»,
//      «## Applied», «## Validation», «## Estimated improvements», таблица
//      «| Metric | Before | After |», метки «Texture VRAM (GPU)», «Texture weight
//      in file», «Draw calls (primitives)» и заметки «**Dry-run mode**...»,
//      «**The .glb was NOT written**...», флаг « · strip-vertex-colors».
//    Отчёт — то, что человек читает как ИТОГ (Правило 9/8), а не лог: это готовые
//    строки, не переживающие смену языка (файл .md пишется один раз на языке сборки).
//
//  Р-2d (ДОЛГ). meta.reversalNote — готовая английская строка у шести правил
//    (scene/join, scene/instance, textures/ktx2, textures/webp, geometry/compress,
//    geometry/quantize). Поле не читает ни интерфейс, ни отчёт, но по Правилу 8
//    оно неправильное. Долг записан отдельным тестом (ниже), чтобы не потерялся.
//
//  Р-3b (BUG-008, формы единственного числа). Механический прогон n=1 и n=5 по
//    всем ключам с подстановкой { n }: 29 русских и 25 английских ключей
//    различаются только цифрой — «1 текстур», «1 ошибок» (engine.inputValidation.found).
//    Список — в сообщении теста и в отчёте задания. Ключи, которым для рендера
//    нужны ещё данные (list/name/...), механически не проверяются (нет полных
//    данных в тесте) — они в той же находке, но вне цифр.
//
//  Зелёные разделы: 1 (рецепты на корпусе — Н-2 закрыт), 2c (titleKey), 3a
//  (базовые ключи у .many), 4 (localizeResult и render-конкатенация).
// ═══════════════════════════════════════════════════════════════════════════
//
// Порог статического скана (объяснение): «фраза для человека» = литерал
// (одинарные/двойные кавычки или статичная часть шаблона) со ВСЕМИ признаками:
//   - содержит пробел;
//   - длиннее 20 символов (задание: «длиннее ~20»);
//   - содержит латинскую букву (состоит из слов, а не из цифр/разделителей);
//   - не содержит '/' (не путь, не mime, не data-URI);
//   - не начинается с '--' (не аргумент внешнего инструмента).
// Короткие фрагменты шаблона отчёта (## Applied, ## Validation, File, - none)
// порогом не ловятся — класс уже пойман длинными соседями, все строки перечислены
// в отчёте задания. Комментарии вырезаются до скана (Ловушка 3). Легитимные
// случаи — в явном белом списке с объяснением каждой строки (не пополнять ради
// зелёного цвета). meta.title — идентификатор для логов (Ловушка 4), нарушением
// не считается: за него отвечает отдельная проверка titleKey.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optimizeFile } from '../optimize2.mjs';
import { localizeResult, render } from '../core/i18n.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { REPO_MODELS, modelPath, isPresent } from './helpers/model-files.mjs';

import gltfEn from '../addons/gltf/messages/en.mjs';
import gltfRu from '../addons/gltf/messages/ru.mjs';
import coreEn from '../core/messages/en.mjs';
import coreRu from '../core/messages/ru.mjs';

const NL = String.fromCharCode(10);
// ── Общий корпус и наборы флагов (те же классы, что в engine-contract) ──────
const LOCAL_MODELS = [
  'parkergirl.glb',
  'RiggedSimple.glb',
  'MosquitoInAmber2.glb',
  'BoomBox.glb',
  'chibi_zenitsu.glb',
  'L-330.glb',
  'SheenWoodLeatherSofa.glb',
  'ToyCar.glb',
];
const ALL_MODELS = [...REPO_MODELS, ...LOCAL_MODELS];

// Advanced-фичи берём из аддона (правило 4 ПРАВИЛА_ТЕСТОВ_универсальность):
// добавят фичу — тест обязан её заметить.
const ADVANCED = Object.keys(gltfAddon.ADVANCED_FEATURES).filter((f) => f !== 'safe');
const FLAG_SETS = [
  [],
  ['safe'],
  ...ADVANCED.map((f) => ['safe', f]),
  ['safe', 'join', 'instance'],
];

function tmpOutDir(prefix = 'i18n-discipline-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Кэш результатов матрицы: один прогон на (модель, флаги), делят разделы 1 и 4.
const _resultCache = new Map();
async function runOnce(name, flags) {
  const key = name + '\u0000' + JSON.stringify(flags);
  if (!_resultCache.has(key)) {
    const outDir = tmpOutDir();
    try {
      const result = await optimizeFile(modelPath(name), { advancedFeatures: flags, dryRun: true, outDir });
      _resultCache.set(key, result);
    } finally {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* занят */ }
    }
  }
  return _resultCache.get(key);
}

const recId = (rec) => rec && rec.i18n && rec.i18n.text && rec.i18n.text.messageId;

// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 1 · КАЖДАЯ ЗАПИСЬ ОТЧЁТА НЕСЁТ РЕЦЕПТ (Правило 8) — динамика на корпусе
// ═══════════════════════════════════════════════════════════════════════════
// Запись без i18n.text.messageId — это готовые строки scene/instance,
// animation/resample и engine/input-validation из находки Н-2 (2026-08-03).
// В сообщении об ошибке видно правило, которое положило запись, и её текст.

function checkRecipe(result, where, violations) {
  for (const list of ['applied', 'skipped', 'findings', 'validation']) {
    const recs = result[list] || [];
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const id = recId(rec);
      const who = rec.ruleId || rec.level || 'без ruleId/level';
      const text = rec.text === undefined ? '(нет поля text)' : JSON.stringify(rec.text);
      if (!id) {
        violations.push('[1·рецепт] ' + list + '[' + i + '] правило ' + who + ' БЕЗ i18n.text.messageId; текст: ' + text);
        continue;
      }
      const inEn = id in gltfEn || id in coreEn;
      const inRu = id in gltfRu || id in coreRu;
      if (!inEn || !inRu) {
        violations.push('[1·рецепт] ' + list + '[' + i + '] правило ' + who + ': messageId ' + JSON.stringify(id) + ' нет в обоих каталогах (en:' + inEn + ', ru:' + inRu + '); текст: ' + text);
      }
      try {
        render(id, rec.i18n.text.data || {}, 'ru');
        render(id, rec.i18n.text.data || {}, 'en');
      } catch (e) {
        violations.push('[1·рецепт] ' + list + '[' + i + '] правило ' + who + ': render(' + JSON.stringify(id) + ') бросает: ' + e.message);
      }
    }
  }
}

describe('Правило 8 — раздел 1: каждая запись отчёта несёт рецепт (корпус × флаги)', () => {
  for (const name of ALL_MODELS) {
    for (const flags of FLAG_SETS) {
      const label = name + ' [' + (flags.join(',') || 'passthrough') + ']';
      const body = async () => {
        const result = await runOnce(name, flags);
        const violations = [];
        checkRecipe(result, label, violations);
        expect(violations, label + ':\n  ' + violations.join('\n  ')).toEqual([]);
      };
      if (isPresent(name)) it(label, body, 120_000);
      else it.skip(label + ' [skipped: ' + name + ' missing locally]', () => {}, 120_000);
    }
  }

  it('матрица непустая: модели × наборы флагов', () => {
    expect(ALL_MODELS.length).toBeGreaterThanOrEqual(11);
    expect(FLAG_SETS.length).toBeGreaterThanOrEqual(10);
  });
});
// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 2 · СТАТИЧЕСКИЙ СКАН: готовые строки в коде движка
// ═══════════════════════════════════════════════════════════════════════════
// Комментарии вырезаются до скана (Ловушка 3 задания). Строковые литералы
// извлекаются токенизатором, который понимает одинарные/двойные кавычки,
// шаблонные строки (статичные части) и регулярные выражения (не путает их
// кавычки с границами строк).

function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== NL) i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

function lastNonSpaceChar(src, i) {
  let j = i - 1;
  while (j >= 0) {
    const code = src.charCodeAt(j);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
    j--;
  }
  return j >= 0 ? src[j] : '';
}

function tokenize(src) {
  const tokens = []; // { type:'str'|'tpl'|'regex', value?, start, end, exprs? }
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const q = c; let j = i + 1, buf = '';
      while (j < src.length && src[j] !== q) {
        if (src.charCodeAt(j) === 92 && j + 1 < src.length) { buf += src[j] + src[j + 1]; j += 2; }
        else { buf += src[j]; j++; }
      }
      tokens.push({ type: 'str', value: buf, start: i, end: j });
      i = j + 1;
    } else if (c === '`') {
      let j = i + 1, buf = '', depth = 0;
      const exprs = [];
      let exprStart = -1;
      while (j < src.length) {
        const ch = src[j];
        if (src.charCodeAt(j) === 92 && j + 1 < src.length) { buf += ch + src[j + 1]; j += 2; continue; }
        if (ch === '$' && src[j + 1] === '{') {
          if (depth === 0) exprStart = j;
          depth++; buf += ch + src[j + 1]; j += 2; continue;
        }
        if (ch === '}' && depth > 0) {
          depth--; buf += ch;
          if (depth === 0) exprs.push([exprStart, j]);
          j++; continue;
        }
        if (ch === '`' && depth === 0) break;
        buf += ch; j++;
      }
      tokens.push({ type: 'tpl', value: buf, start: i, end: j, exprs });
      i = j + 1;
    } else if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*') {
      const prev = lastNonSpaceChar(src, i);
      const regexStart = !prev || '=([,:!&|?;{+-*/%<>~^'.includes(prev);
      if (regexStart) {
        let j = i + 1, inClass = false, closed = false;
        while (j < src.length) {
          const ch = src[j];
          if (src.charCodeAt(j) === 92) { j += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { closed = true; break; }
          j++;
        }
        if (closed) { tokens.push({ type: 'regex', start: i, end: j + 1 }); i = j + 1; }
        else i++;
      } else i++;
    } else i++;
  }
  return tokens;
}

function tplStaticParts(v) {
  const parts = [];
  let buf = '', depth = 0, i = 0;
  while (i < v.length) {
    const ch = v[i];
    if (ch === '$' && v[i + 1] === '{' && depth === 0) { parts.push(buf); buf = ''; i += 2; depth = 1; continue; }
    if (ch === '{' && depth > 0) depth++;
    else if (ch === '}' && depth > 0) { depth--; i++; continue; }
    if (depth === 0) buf += ch;
    i++;
  }
  if (depth === 0) parts.push(buf);
  return parts;
}

function lineAt(src, pos) {
  let line = 1;
  for (let i = 0; i < pos; i++) if (src[i] === NL) line++;
  return line;
}

const SCAN_FILES = ['addons/gltf/rules.mjs', 'addons/gltf/index.mjs', 'core/engine.mjs'];

// Литералы кода движка (после вырезания комментариев): фраза ли это для человека.
function scanPhrases() {
  const out = []; // { file, line, literal }
  for (const f of SCAN_FILES) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const t of tokenize(src)) {
      const lits = t.type === 'str' ? [t.value]
        : t.type === 'tpl' ? tplStaticParts(t.value) : [];
      for (const lit of lits) {
        if (!lit.includes(' ')) continue;
        if (lit.length <= 20) continue;
        if (!/[A-Za-z]/.test(lit)) continue;
        if (lit.startsWith('--')) continue;
        // meta.title — идентификатор для логов (Ловушка 4), переводится через
        // titleKey (проверка отдельно); reversalNote — долг, свой тест ниже.
        const before = src.slice(Math.max(0, t.start - 60), t.start).trimEnd();
        if (before.endsWith('title:')) continue;
        if (before.endsWith('reversalNote:')) continue;
        out.push({ file: f, line: lineAt(src, t.start), literal: lit });
      }
    }
  }
  return out;
}

// Явный белый список легитимных фраз. Каждая строка — решение, а не подгонка:
// если понадобится добавить — это правка, а не тест.
const PHRASE_WHITELIST = {
  '    phase 1/5 · analysis (rules: ': 'ctx.log движка — подпись фазы 1 в журнале сервера (Ловушка 1: логи не отчёт)',
  '    phase 3/5 · apply · basic (': 'ctx.log движка — подпись фазы 3 в журнале сервера (Ловушка 1)',
  '    phase 4/5 · validation': 'ctx.log движка — подпись фазы 4 в журнале сервера (Ловушка 1)',
  '    phase 5/5 · report': 'ctx.log движка — подпись фазы 5 в журнале сервера (Ловушка 1)',
  '      baseline-checkpoint: ': 'ctx.log движка — сводка baseline-метрик (Ловушка 1)',
};
describe('Правило 8 — раздел 2: статический скан кода движка', () => {
  it('нет готовых пользовательских строк в коде движка (фраза-литерал → красный с текстом)', () => {
    const found = scanPhrases().filter((x) => !(x.literal in PHRASE_WHITELIST));
    const lines = found.map((x) => '  ' + x.file + ':' + x.line + '  ' + JSON.stringify(x.literal));
    expect(found, 'Найденные фразы-кандидаты (движок не чиним, пишем в отчёт):\n' + lines.join('\n')).toEqual([]);
  });

  it('в коде движка нет кириллицы (она должна жить только в каталогах)', () => {
    const bad = [];
    for (const f of SCAN_FILES) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const t of tokenize(src)) {
        const lits = t.type === 'str' ? [t.value] : t.type === 'tpl' ? tplStaticParts(t.value) : [];
        for (const lit of lits) {
          if ([...lit].some((ch) => ch.charCodeAt(0) >= 0x400 && ch.charCodeAt(0) <= 0x4FF)) {
            bad.push(f + ':' + lineAt(src, t.start) + '  ' + JSON.stringify(lit));
          }
        }
      }
    }
    expect(bad, 'Кириллица в коде движка:\n  ' + bad.join('\n  ')).toEqual([]);
  });

  it('у каждого правила есть titleKey, и он существует в обоих каталогах (Ловушка 4)', () => {
    const missing = [];
    for (const r of RULES) {
      const tk = r.meta && r.meta.titleKey;
      if (!tk || typeof tk !== 'string' || !tk.trim()) {
        missing.push(r.meta.id + ': titleKey отсутствует');
        continue;
      }
      const inEn = tk in gltfEn || tk in coreEn;
      const inRu = tk in gltfRu || tk in coreRu;
      if (!inEn || !inRu) missing.push(r.meta.id + ': titleKey ' + JSON.stringify(tk) + ' нет в обоих каталогах');
    }
    expect(missing, missing.join('\n  ')).toEqual([]);
  });

  it('ДОЛГ (задание 2026-08-03-долг-правила-8): meta.reversalNote — ключ каталога, а не готовая строка', () => {
    const bad = RULES.filter((r) => r.meta && typeof r.meta.reversalNote === 'string')
      .map((r) => '  ' + r.meta.id + ': ' + JSON.stringify(r.meta.reversalNote));
    expect(bad, 'Долг открыт — reversalNote это готовая английская строка:\n' + bad.join('\n')).toEqual([]);
  });
});
// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 3 · КАТАЛОГИ: формы единственного числа и база у .many
// ═══════════════════════════════════════════════════════════════════════════
// en↔ru симметрия и сироты — в locale-keys-symmetry и engine-contract (раздел 3),
// здесь не дублируются. Добавляем то, чего там нет: механическую проверку
// BUG-008 (n=1 против n=5 различаются не только цифрой) и наличие базового
// ключа у каждого .many-варианта.

// Ключи, исключаемые из механической проверки форм числа.
const PLURAL_SKIP = new Set([
  // лог правила, не отчёт (Ловушка 1 задания) — форма числа там не важна
  'ktx2.log.encoding',
]);

// n=1 против n=5: строки различаются не только цифрой (иначе «1 текстур»).
function pluralViolations(cat, locale) {
  const bad = [];
  for (const key of Object.keys(cat)) {
    if (PLURAL_SKIP.has(key)) continue;
    if (key.endsWith('.many')) continue; // .many эмитится только при n>1; база — проверка ниже
    const one = render(key, { n: 1 }, locale);
    const five = render(key, { n: 5 }, locale);
    if (one === five) continue; // ключ не использует n
    if (one.includes('undefined') || five.includes('undefined')) continue; // не хватает данных — не проверить
    if (one.replace(/[0-9]/g, '') === five.replace(/[0-9]/g, '')) {
      bad.push({ key, one, five });
    }
  }
  return bad;
}

describe('Правило 8 — раздел 3: полнота и формы каталогов', () => {
  it('у каждого .many-ключа есть базовый ключ (форма единственного числа)', () => {
    const problems = [];
    for (const [label, cat] of [['gltf', gltfRu], ['core', coreRu]]) {
      for (const key of Object.keys(cat)) {
        if (!key.endsWith('.many')) continue;
        const base = key.slice(0, -'.many'.length);
        if (!(base in cat)) problems.push(label + ': ' + key + ' — нет базового ключа ' + JSON.stringify(base));
      }
    }
    expect(problems, problems.join('\n  ')).toEqual([]);
  });

  it('русские ключи с { n }: форма единственного числа есть (BUG-008, n=1 против n=5)', () => {
    const gltfBad = pluralViolations(gltfRu, 'ru');
    const coreBad = pluralViolations(coreRu, 'ru');
    const lines = [...gltfBad, ...coreBad]
      .map((b) => '  ' + b.key + '  n=1: ' + b.one + '  ||  n=5: ' + b.five);
    expect([...gltfBad, ...coreBad], 'Ключи без формы единственного числа («1 текстур»):\n' + lines.join('\n')).toEqual([]);
  });

  it('английские ключи с { n }: строки различаются не только цифрой (тот же механический класс)', () => {
    const gltfBad = pluralViolations(gltfEn, 'en');
    const coreBad = pluralViolations(coreEn, 'en');
    const lines = [...gltfBad, ...coreBad]
      .map((b) => '  ' + b.key + '  n=1: ' + b.one + '  ||  n=5: ' + b.five);
    expect([...gltfBad, ...coreBad], 'Английские ключи без формы «1 ...»:\n' + lines.join('\n')).toEqual([]);
  });
});
// ═══════════════════════════════════════════════════════════════════════════
// РАЗДЕЛ 4 · СМЕНА ЯЗЫКА НИЧЕГО НЕ ПЕРЕСЧИТЫВАЕТ + render() НЕ СКЛЕИВАЕТСЯ
// ═══════════════════════════════════════════════════════════════════════════
// 4a. localizeResult(result,'ru') и ('en') на одном результате: тексты разные,
//     структура и числа те же — длины списков, ruleId, messageId, data, level,
//     порядок записей.
// 4b. metrics равны по значению — значит, движок не вызывался повторно.
// 4c. Статика: render(...) не участвует в конкатенации (образец правильного
//     решения — engine.skipped.line с вложенной подстановкой).

function checkLocalize(result, where, violations) {
  const ru = localizeResult(result, 'ru');
  const en = localizeResult(result, 'en');
  for (const list of ['applied', 'skipped', 'findings', 'validation']) {
    const a = result[list] || [];
    const r = ru[list] || [];
    const e = en[list] || [];
    if (a.length !== r.length || a.length !== e.length) {
      violations.push('[4·локализация] ' + list + ': длина изменилась ' + a.length + ' → ru ' + r.length + ' / en ' + e.length);
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const xr = r[i];
      const xe = e[i];
      // порядок, ruleId, messageId, data, level — не тронуты
      if (xr.ruleId !== x.ruleId || xe.ruleId !== x.ruleId) violations.push('[4·локализация] ' + list + '[' + i + '] ruleId изменился');
      if (xr.level !== x.level || xe.level !== x.level) violations.push('[4·локализация] ' + list + '[' + i + '] level изменился');
      const m1 = xr.i18n && xr.i18n.text && xr.i18n.text.messageId;
      const m2 = xe.i18n && xe.i18n.text && xe.i18n.text.messageId;
      const m0 = x.i18n && x.i18n.text && x.i18n.text.messageId;
      if (m1 !== m0 || m2 !== m0) violations.push('[4·локализация] ' + list + '[' + i + '] messageId изменился');
      if (JSON.stringify(xr.i18n && xr.i18n.text && xr.i18n.text.data) !== JSON.stringify(x.i18n && x.i18n.text && x.i18n.text.data)) {
        violations.push('[4·локализация] ' + list + '[' + i + '] data изменился');
      }
      // рецепт есть — тексты обязаны разойтись (иначе перевод не работает)
      if (m0 && xr.text === xe.text && xr.text === x.text) {
        violations.push('[4·локализация] ' + list + '[' + i + '] текст не изменился при смене языка: ' + JSON.stringify(x.text));
      }
    }
  }
  // тексты хотя бы где-то различаются (если есть хоть одна запись с рецептом)
  const anyRecipe = ['applied', 'skipped', 'findings', 'validation'].some(
    (l) => (result[l] || []).some((r) => recId(r)),
  );
  if (anyRecipe) {
    const txt = (l) => (l || []).map((r) => r.text).join('|');
    const same = ['applied', 'skipped', 'findings', 'validation'].every(
      (l) => txt(ru[l]) === txt(en[l]),
    );
    if (same) violations.push('[4·локализация] ru и en тексты полностью совпали');
  }
  // 4b: metrics не тронуты — движок не вызывался
  if (JSON.stringify(result.metrics) !== JSON.stringify(ru.metrics)) {
    violations.push('[4·локализация] metrics изменились после localizeResult — движок был вызван повторно?');
  }
  if (JSON.stringify(result.metrics) !== JSON.stringify(en.metrics)) {
    violations.push('[4·локализация] metrics изменились после localizeResult (en)');
  }
}

describe('Правило 8 — раздел 4: смена языка ничего не пересчитывает', () => {
  for (const name of ALL_MODELS) {
    for (const flags of FLAG_SETS) {
      const label = name + ' [' + (flags.join(',') || 'passthrough') + ']';
      const body = async () => {
        const result = await runOnce(name, flags);
        const violations = [];
        checkLocalize(result, label, violations);
        expect(violations, label + ':\n  ' + violations.join('\n  ')).toEqual([]);
      };
      if (isPresent(name)) it(label, body, 120_000);
      else it.skip(label + ' [skipped: ' + name + ' missing locally]', () => {}, 120_000);
    }
  }

  it('render() не участвует в конкатенации строк (Правило 8, пункт 3)', () => {
    const bad = [];
    for (const f of SCAN_FILES) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      const tokens = tokenize(src);
      for (const t of tokens) {
        if (t.type !== 'tpl') continue;
        for (const [es, ee] of t.exprs || []) {
          const expr = src.slice(es + 2, ee);
          if (expr.includes('render(')) {
            bad.push(f + ':' + lineAt(src, es) + '  render() внутри шаблона: ' + expr.trim().slice(0, 80));
          }
        }
      }
      // отдельные вызовы render(...) — не должны соседствовать с '+' снаружи
      let i = 0;
      while ((i = src.indexOf('render(', i)) !== -1) {
        const end = matchParen(src, i + 'render('.length);
        const after = src[end + 1];
        const before = src[i - 1];
        if (after === '+') bad.push(f + ':' + lineAt(src, i) + '  render(...) + ... конкатенация');
        if (before === '+') bad.push(f + ':' + lineAt(src, i) + '  ... + render(...) конкатенация');
        i = end + 1;
      }
    }
    expect(bad, 'Конкатенация с render() (образец правильно — engine.skipped.line):\n  ' + bad.join('\n  ')).toEqual([]);
  });
});

// Парные скобки для render( ... ) с учётом вложенности и строк.
function matchParen(src, from) {
  let depth = 1, i = from, q = '';
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (q) {
      if (src.charCodeAt(i) === 92) { i += 2; continue; }
      if (c === q) q = '';
      i++; continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  return i - 1;
}
