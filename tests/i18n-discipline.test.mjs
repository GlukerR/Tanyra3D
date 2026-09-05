import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import fs from 'node:fs';

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
const LOCAL_MODELS = [
  'parkergirl.glb',
  'RiggedSimple.glb',
  'MosquitoInAmber2.glb',
  'BoomBox.glb',
  'chibi_zenitsu.glb',
  'Production Many Materials 01.glb',
  'SheenWoodLeatherSofa.glb',
  'ToyCar.glb',
];
const ALL_MODELS = [...REPO_MODELS, ...LOCAL_MODELS];

const ADVANCED = Object.keys(gltfAddon.ADVANCED_FEATURES).filter((f) => f !== 'safe');
const FLAG_SETS = [
  [],
  ['safe'],
  ...ADVANCED.map((f) => ['safe', f]),
  ['safe', 'join', 'instance'],
];


const _resultCache = new Map();
async function runOnce(name, flags) {
  const key = name + '\u0000' + JSON.stringify(flags);
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

const recId = (rec) => rec && rec.i18n && rec.i18n.text && rec.i18n.text.messageId;


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
  const tokens = [];
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

function scanPhrases() {
  const out = [];
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
        const before = src.slice(Math.max(0, t.start - 60), t.start).trimEnd();
        if (before.endsWith('title:')) continue;
        if (before.endsWith('reversalNote:')) continue;
        out.push({ file: f, line: lineAt(src, t.start), literal: lit });
      }
    }
  }
  return out;
}

const PHRASE_WHITELIST = {
  '    phase 1/5 · analysis (rules: ': 'ctx.log движка — подпись фазы 1 в журнале сервера (Ловушка 1: логи не отчёт)',
  '    phase 3/5 · apply · basic (': 'ctx.log движка — подпись фазы 3 в журнале сервера (Ловушка 1)',
  '    phase 4/5 · validation': 'ctx.log движка — подпись фазы 4 в журнале сервера (Ловушка 1)',
  '    phase 5/5 · report': 'ctx.log движка — подпись фазы 5 в журнале сервера (Ловушка 1)',
  '      baseline-checkpoint: ': 'ctx.log движка — сводка baseline-метрик (Ловушка 1)',

  '[gltf] carried extensions not restored: ': 'console.warn движка — диагностика отказа возврата (Ловушка 1)',
  ' (addressed arrays shifted)': 'console.warn движка — хвост той же строки (Ловушка 1)',

  'safe lossless cleanup: dedup, prune unused, weld, remove degenerate/orphan geometry': 'ADVANCED_FEATURES — текст ошибки API',
  'Meshopt geometry compression': 'ADVANCED_FEATURES — текст ошибки API',
  'Draco geometry compression (instead of Meshopt)': 'ADVANCED_FEATURES — текст ошибки API',
  'geometry quantization (KHR_mesh_quantization) — smaller geometry, no decoder needed': 'ADVANCED_FEATURES — текст ошибки API',
  'join meshes / flatten scene — fewer draw calls (structural, irreversible)': 'ADVANCED_FEATURES — текст ошибки API',
  'GPU instancing (EXT_mesh_gpu_instancing) — repeated meshes as instances': 'ADVANCED_FEATURES — текст ошибки API',
  'resample animations — drop redundant keyframes (lossless)': 'ADVANCED_FEATURES — текст ошибки API',
  'drop clickable marks with no handler in the behaviour graph (irreversible)': 'ADVANCED_FEATURES — текст ошибки API',
  'keep UV and other vertex data no material reads (for configurators)': 'ADVANCED_FEATURES — текст ошибки API',
  'textures → KTX2 (needs browser/engine support)': 'ADVANCED_FEATURES — текст ошибки API',
  'textures → WebP (EXT_texture_webp; smaller file, video memory unchanged)': 'ADVANCED_FEATURES — текст ошибки API',
  'removal of painted vertex colors (lossy)': 'ADVANCED_FEATURES — текст ошибки API',
  'downscale textures to 4096 px on the longer side (lossy)': 'ADVANCED_FEATURES — текст ошибки API',
  'downscale textures to 2048 px on the longer side (lossy)': 'ADVANCED_FEATURES — текст ошибки API',
  'downscale textures to 1024 px on the longer side (lossy)': 'ADVANCED_FEATURES — текст ошибки API',
  'downscale textures to 512 px on the longer side (lossy)': 'ADVANCED_FEATURES — текст ошибки API',
  'Unknown advancedFeatures: ': 'префикс той же ошибки API — адресат вызывающий код, не человек',

  'unknown runAfter dependency "': 'orderRules — ошибка настройки, адресат автор правила',
  'duplicate runAfter dependency "': 'orderRules — ошибка настройки, адресат автор правила',
  '" depends on itself in runAfter': 'orderRules — ошибка настройки, адресат автор правила',
  ' · strip-vertex-colors': 'имя CLI-флага в шапке отчёта, а не фраза: переводить имя флага нельзя',
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

  it('meta.reversalNote — ключ каталога, а не готовая строка (долг закрыт 2026-08-04)', () => {
    const bad = RULES.filter((r) => r.meta && typeof r.meta.reversalNote === 'string')
      .map((r) => '  ' + r.meta.id + ': ' + JSON.stringify(r.meta.reversalNote));
    expect(bad, 'reversalNote снова готовая строка:\n' + bad.join('\n')).toEqual([]);
  });

  it('reversalNoteKey у каждого правила существует в обоих каталогах', () => {
    const missing = [];
    for (const r of RULES) {
      const key = r.meta && r.meta.reversalNoteKey;
      if (!key) continue;
      if (!(key in gltfEn || key in coreEn)) missing.push(r.meta.id + ': ' + key + ' нет в en');
      if (!(key in gltfRu || key in coreRu)) missing.push(r.meta.id + ': ' + key + ' нет в ru');
    }
    expect(missing, missing.join('\n  ')).toEqual([]);
  });
});

const PLURAL_SKIP = new Set([
  'ktx2.log.encoding',
  'prune.done.textures',
  'prune.done.materials',
]);

const NUMBER_GOVERNS_WORD = /\d+\s+\p{L}/u;

function pluralViolations(cat, locale) {
  const bad = [];
  for (const key of Object.keys(cat)) {
    if (PLURAL_SKIP.has(key)) continue;
    if (key.endsWith('.many')) continue;
    const one = render(key, { n: 1 }, locale);
    const five = render(key, { n: 5 }, locale);
    if (one === five) continue;
    if (one.includes('undefined') || five.includes('undefined')) continue;
    if (!NUMBER_GOVERNS_WORD.test(one)) continue;
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
      if (xr.ruleId !== x.ruleId || xe.ruleId !== x.ruleId) violations.push('[4·локализация] ' + list + '[' + i + '] ruleId изменился');
      if (xr.level !== x.level || xe.level !== x.level) violations.push('[4·локализация] ' + list + '[' + i + '] level изменился');
      const m1 = xr.i18n && xr.i18n.text && xr.i18n.text.messageId;
      const m2 = xe.i18n && xe.i18n.text && xe.i18n.text.messageId;
      const m0 = x.i18n && x.i18n.text && x.i18n.text.messageId;
      if (m1 !== m0 || m2 !== m0) violations.push('[4·локализация] ' + list + '[' + i + '] messageId изменился');
      if (JSON.stringify(xr.i18n && xr.i18n.text && xr.i18n.text.data) !== JSON.stringify(x.i18n && x.i18n.text && x.i18n.text.data)) {
        violations.push('[4·локализация] ' + list + '[' + i + '] data изменился');
      }
      if (m0 && xr.text === xe.text && xr.text === x.text) {
        violations.push('[4·локализация] ' + list + '[' + i + '] текст не изменился при смене языка: ' + JSON.stringify(x.text));
      }
    }
  }
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

afterAll(cleanupTmpOutDirs);
