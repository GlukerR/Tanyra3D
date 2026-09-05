import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ДОК = 'docs/ЗАВИСИМОСТИ.md';
const текст = fs.readFileSync(path.join(root, ДОК), 'utf8');
const ДОК2 = 'docs/ИСТОЧНИКИ.md';
const текст2 = fs.readFileSync(path.join(root, ДОК2), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function установлено(имя) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', имя, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function объявлено() {
  const out = new Map();
  for (const [строка] of текст.matchAll(/^### Компонент:.*$/gm)) {
    for (const [, имя, версия] of строка.matchAll(/([@a-zA-Z0-9._/-]+)\s*\(v([^)]+)\)/g)) {
      if (!out.has(имя)) out.set(имя, версия.trim());
    }
  }
  return out;
}

const ОБЪЯВЛЕНО = объявлено();
const РАБОЧИЕ = Object.keys(pkg.dependencies || {});
const СБОРОЧНЫЕ = Object.keys(pkg.devDependencies || {});

describe('справка о зависимостях полна', () => {
  for (const имя of РАБОЧИЕ) {
    it(`${имя} — есть своя запись`, () => {
      expect(
        ОБЪЯВЛЕНО.has(имя),
        `${имя} — рабочая зависимость, она уезжает пользователю в установщике, а в ${ДОК} про неё нет записи. `
        + 'Завести раздел «### Компонент: имя (vномер)» с ответом на два вопроса: зачем она и что будет, если убрать.',
      ).toBe(true);
    });
  }
});

describe('номера в справке — установленные, а не вчерашние', () => {
  for (const имя of [...РАБОЧИЕ, ...СБОРОЧНЫЕ]) {
    const объявленная = ОБЪЯВЛЕНО.get(имя);
    const версия = установлено(имя);
    const проверяем = typeof объявленная === 'string' && typeof версия === 'string';
    it(`${имя} — номер в справке совпадает с установленным${проверяем ? '' : ' [нечего сверять]'}`, () => {
      if (!проверяем) return;
      expect(
        объявленная,
        `${имя}: ${ДОК} объявляет ${объявленная}, а установлено ${версия}. `
        + 'Шапка документа требует обновлять запись при КАЖДОЙ смене версии — поправить номер и перечитать текст рядом: '
        + 'вместе с версией обычно устаревает и описание того, как мы библиотеку используем.',
      ).toBe(версия);
    });
  }
});

describe('таблица установленного в ИСТОЧНИКИ.md совпадает с деревом', () => {
  const объявлено = new Map();
  for (const [, имя, версия] of текст2.matchAll(/^\|\s*`([@a-zA-Z0-9._/-]+)`\s*\|\s*([0-9][^|\s]*)\s*\|/gm)) {
    объявлено.set(имя, версия.trim());
  }

  it('таблица вообще разобралась', () => {
    expect(объявлено.size, `в ${ДОК2} не нашлось ни одной строки «| \`пакет\` | версия |» — разбор таблицы сломался`)
      .toBeGreaterThanOrEqual(5);
  });

  for (const имя of [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]) {
    const версия = установлено(имя);
    const указано = объявлено.get(имя);
    const проверяем = typeof указано === 'string' && typeof версия === 'string';
    it(`${имя} — номер в таблице совпадает с установленным${проверяем ? '' : ' [в таблице нет]'}`, () => {
      if (!проверяем) return;
      expect(
        указано,
        `${имя}: ${ДОК2} называет ${указано}, установлено ${версия}. Шапка того документа требует `
        + 'сверять при каждой смене версии в package.json.',
      ).toBe(версия);
    });
  }
});
