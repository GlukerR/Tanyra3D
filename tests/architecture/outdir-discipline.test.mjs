// tests/architecture/outdir-discipline.test.mjs — сторож «тесты не пишут в output/».
//
// Задание 2026-08-15-тесты-не-мусорят-в-output (работа 1). Умолчание аддона —
// `outDir: 'output'` (addons/gltf/index.mts), и это ПРАВИЛЬНОЕ умолчание для человека
// за командной строкой. Но тест, который зовёт `optimizeFile()` без `outDir`, пишет
// модель и отчёт прямо в рабочую папку пользователя — за август так натекло
// 123 файла на 300+ МБ осадка.
//
// Сторож читает ИСХОДНИКИ набора и краснеет на новом вызове `optimizeFile(` (или
// `runOptimize(`), в аргументах которого нет `outDir`. Тот же приём, что у
// rule-resilience и i18n-discipline: ломаемся от нарушения дисциплины, а не от
// плохого результата. Без него через месяц появится одиннадцатый такой вызов.
//
// Токенизация сознательно упрощена до того, что нужно сторожу: комментарии вырезаны
// (с сохранением переносов строк ради номеров), строки/шаблоны/регекспы пропускаются
// как непрозрачные куски — внутри них `optimizeFile(` не ищем. Вызов внутри
// `${...}`-вставки шаблонной строки не ловится: в наборе таких нет, а плата за их
// разбор — отдельный парсер выражений ради одного вызова.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

function listTestFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listTestFiles(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

// Вырезать комментарии, сохранив переносы строк (для честных номеров строк).
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== NL) { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === NL ? NL : ' '; i++; }
      out += '  '; i += 2; continue;
    }
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

function isRegexStart(src, i) {
  const prev = lastNonSpaceChar(src, i);
  return !prev || '=([,:!&|?;{+-*/%<>~^'.includes(prev);
}

// Пропустить строку/шаблон/регексп, начавшийся на позиции i (src[i] — открывающий
// символ). Возвращает позицию сразу ПОСЛЕ закрывающего.
function skipLiteral(src, i) {
  const c = src[i];
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === BS) { j += 2; continue; }
      if (src[j] === c) return j + 1;
      j++;
    }
    return src.length;
  }
  // регексп: /.../  (без учёта класса [..] внутри — в тестах таких нет, но на всякий случай)
  let j = i + 1, inClass = false;
  while (j < src.length) {
    if (src[j] === BS) { j += 2; continue; }
    if (src[j] === '[') inClass = true;
    else if (src[j] === ']') inClass = false;
    else if (src[j] === '/' && !inClass) return j + 1;
    j++;
  }
  return src.length;
}

// Сбалансированная закрывающая скобка, начиная от `open` (src[open] === '(').
function matchParen(src, from) {
  let depth = 1, i = from;
  while (i < src.length && depth > 0) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== NL) i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { i = skipLiteral(src, i); continue; }
    if (c === '/' && isRegexStart(src, i)) { i = skipLiteral(src, i); continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  return i - 1;
}

// Найти все вызовы name( в КОДЕ (комментарии уже вырезаны), вернуть {open, close, args, line}.
function findCallSites(src, name) {
  const sites = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "'" || c === '"' || c === '`') { i = skipLiteral(src, i); continue; }
    if (c === '/' && isRegexStart(src, i) && n !== '/' && n !== '*') { i = skipLiteral(src, i); continue; }
    if (src.startsWith(name, i) && src[i + name.length] === '(') {
      const open = i + name.length;
      const close = matchParen(src, open + 1);
      const args = src.slice(open + 1, close);
      const line = src.slice(0, i).split(NL).length;
      sites.push({ open, close, args, line });
      i = close + 1;
      continue;
    }
    i++;
  }
  return sites;
}

const CALL_NAMES = ['optimizeFile', 'runOptimize'];

function violations() {
  const bad = [];
  for (const file of listTestFiles(TESTS_ROOT)) {
    const rel = path.relative(path.resolve(__dirname, '..', '..'), file).replaceAll(BS, '/');
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const name of CALL_NAMES) {
      for (const site of findCallSites(src, name)) {
        if (!/outDir/.test(site.args)) {
          const snippet = site.args.replace(/\s+/g, ' ').slice(0, 80);
          bad.push(`${rel}:${site.line}  ${name}( ${snippet} )`);
        }
      }
    }
  }
  return bad;
}

describe('тесты не пишут в output/ (сторож outDir)', () => {
  it('каждый вызов optimizeFile/runOptimize в tests/ несёт outDir', () => {
    const bad = violations();
    expect(bad, 'Вызовы без outDir (пишут в рабочую output/):\n  ' + bad.join('\n  ')).toEqual([]);
  });
});
