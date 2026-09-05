import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import gltfAddon from '../addons/gltf/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ДОК = 'docs/ЧТО_УМЕЕТ.md';
const текст = fs.readFileSync(path.join(root, ДОК), 'utf8');
const ПАНЕЛЬ = fs.readFileSync(path.join(root, 'ui', 'app.ts'), 'utf8');

const ОПЦИИ = Object.keys(gltfAddon.ADVANCED_FEATURES);

describe('таблица возможностей знает про все опции движка', () => {
  it('список опций у движка вообще получен', () => {
    expect(ОПЦИИ.length, 'ADVANCED_FEATURES пуст — сторожу нечего сверять').toBeGreaterThan(10);
  });

  for (const id of ОПЦИИ) {
    it(`${id} — назван в ${ДОК}`, () => {
      expect(
        текст.includes(id),
        `Опция «${id}» есть у движка, а в ${ДОК} про неё ни строчки. `
        + 'Документ отвечает на вопрос «что программа умеет» — опция, которой в нём нет, для читателя не существует. '
        + 'Дописать строку в таблицу возможностей.',
      ).toBe(true);
    });
  }
});

describe('панель знает про все опции движка (Правило 12)', () => {
  for (const id of ОПЦИИ) {
    it(`${id} — панель о ней знает`, () => {
      expect(
        ПАНЕЛЬ.includes(`'${id}'`),
        `Опция «${id}» есть у движка, а ui/app.ts её не упоминает ни разу: нажать негде. `
        + 'Либо добавить в группу (OPT_GROUPS), либо показать своим виджетом — но человек должен иметь к ней доступ.',
      ).toBe(true);
    });
  }
});
