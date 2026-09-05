import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { commentRanges } from './helpers/comment-ranges.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['core', 'addons', 'ui', 'tests', 'scripts', 'desktop', 'translations', 'types'];
const ROOT_FILES = ['assistant.mts', 'optimize2.mts', 'server.mts', 'vitest.config.mjs', 'eslint.config.js'];
const EXT = new Set(['.mts', '.ts', '.mjs', '.js', '.cjs']);
const SKIP = /node_modules|\.min\.|vendor/;

const ПОТОЛОК = 4;

const ДИРЕКТИВЫ = [
  /^\/\/\s*eslint-/, /^\/\*\s*eslint-/, /^\/\/\s*@ts-/, /^\/\*\s*@ts-/,
  /^\/\/\/\s*</, /^#!/, /^\/\/\s*prettier-/, /^\/\*\s*prettier-/,
  /^\/\/\s*@vitest-/, /^\/\*\s*global /, /^\/\/\s*global /,
];

function walk(dir, out = []) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (SKIP.test(p)) continue;
    if (it.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(it.name))) out.push(p);
  }
  return out;
}

const файлы = [];
for (const d of DIRS) walk(path.join(ROOT, d), файлы);
for (const f of ROOT_FILES) файлы.push(path.join(ROOT, f));
const набор = new Set(файлы);
const исходники = файлы.filter((f) => fs.existsSync(f)
  && !((f.endsWith('.js') && набор.has(f.slice(0, -3) + '.ts'))
    || (f.endsWith('.mjs') && набор.has(f.slice(0, -4) + '.mts'))));

const комментарии = [];
for (const f of исходники) {
  const текст = fs.readFileSync(f, 'utf8');
  for (const r of commentRanges(текст)) {
    const сырой = текст.slice(r.start, r.end);
    if (ДИРЕКТИВЫ.some((d) => d.test(сырой))) continue;
    const тело = сырой.replace(/^\/\*+|\*+\/$/g, '').replace(/^\/\//, '').replace(/^\s*\*/gm, '').trim();
    if (!тело) continue;
    комментарии.push({
      файл: path.relative(ROOT, f),
      строка: текст.slice(0, r.start).split('\n').length,
      тело,
    });
  }
}

describe('Правило 13 — комментарий 1–4 слова, по-английски', () => {
  it('дерево вообще просматривается', () => {
    expect(исходники.length, 'не нашлось ни одного исходника — сторож смотрит не туда')
      .toBeGreaterThan(100);
  });

  it('ни один комментарий не длиннее четырёх слов', () => {
    const длинные = комментарии
      .filter((c) => c.тело.split(/\s+/).filter(Boolean).length > ПОТОЛОК)
      .map((c) => `${c.файл}:${c.строка}  ${c.тело.slice(0, 60)}`);
    expect(длинные, `${длинные.length} длинных комментариев:\n${длинные.slice(0, 40).join('\n')}`)
      .toEqual([]);
  });

  it('в комментариях нет кириллицы', () => {
    const русские = комментарии
      .filter((c) => /[а-яёА-ЯЁ]/.test(c.тело))
      .map((c) => `${c.файл}:${c.строка}  ${c.тело.slice(0, 60)}`);
    expect(русские, `${русские.length} комментариев по-русски:\n${русские.slice(0, 40).join('\n')}`)
      .toEqual([]);
  });
});
