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

function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipLiteral(src, i);
      out += src.slice(i, end); i = end; continue;
    }
    if (c === '/' && n !== '/' && n !== '*' && isRegexStart(src, i)) {
      const end = skipLiteral(src, i);
      out += src.slice(i, end); i = end; continue;
    }
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

const REAL_OUTPUT = /['"]output['"]/;

function violations() {
  const noOutDir = [];
  const realOutput = [];
  for (const file of listTestFiles(TESTS_ROOT)) {
    const rel = path.relative(path.resolve(__dirname, '..', '..'), file).replaceAll(BS, '/');
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const name of CALL_NAMES) {
      for (const site of findCallSites(src, name)) {
        const snippet = site.args.replace(/\s+/g, ' ').slice(0, 80);
        const where = `${rel}:${site.line}  ${name}( ${snippet} )`;
        if (!/outDir/.test(site.args)) noOutDir.push(where);
        else if (REAL_OUTPUT.test(site.args)) realOutput.push(where);
      }
    }
  }
  return { noOutDir, realOutput };
}

describe('тесты не пишут в output/ (сторож outDir)', () => {
  it('каждый вызов optimizeFile/runOptimize в tests/ несёт outDir', () => {
    const { noOutDir } = violations();
    expect(noOutDir, 'Вызовы без outDir (пишут в рабочую output/):\n  ' + noOutDir.join('\n  ')).toEqual([]);
  });

  it('ни один outDir не указывает на настоящую output/', () => {
    const { realOutput } = violations();
    expect(realOutput, 'outDir смотрит в рабочую папку человека:\n  ' + realOutput.join('\n  ')).toEqual([]);
  });
});
