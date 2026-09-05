import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function известныеКлючи() {
  const src = fs.readFileSync(path.join(ROOT, 'assistant.mts'), 'utf8');
  const от = src.indexOf('const BUDGET_SPEC');
  expect(от, 'в assistant.mts не найден BUDGET_SPEC — проверка ослепла; если объявление '
    + 'переименовали, поправь якорь здесь').toBeGreaterThan(-1);
  const блок = src.slice(от, src.indexOf('\n};', от));
  return [...блок.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
}

const ПРОФИЛИ = fs.readdirSync(path.join(ROOT, 'profiles')).filter((f) => f.endsWith('.json'));

describe('пороги площадки называют то, что движок умеет проверять', () => {
  const известные = известныеКлючи();

  it('список известных бюджетов непуст', () => {
    expect(известные.length, 'BUDGET_SPEC пуст — сторож ниже пропустит что угодно')
      .toBeGreaterThan(3);
  });

  for (const файл of ПРОФИЛИ) {
    it(`${файл}: ни одного бюджета мимо BUDGET_SPEC`, () => {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', файл), 'utf8'));
      const чужие = Object.keys(p.budgets || {}).filter((k) => !известные.includes(k));
      expect(чужие,
        `${файл}: порог(и) ${чужие.join(', ')} движку неизвестны и будут выброшены МОЛЧА — `
        + `ни отказа, ни строки в журнале. Известные: ${известные.join(', ')}`)
        .toEqual([]);
    });
  }

  it('обратная сторона: каждый известный бюджет где-то употребляется', () => {
    const употреблены = new Set();
    for (const файл of ПРОФИЛИ) {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', файл), 'utf8'));
      for (const k of Object.keys(p.budgets || {})) употреблены.add(k);
    }
    const мёртвые = известные.filter((k) => !употреблены.has(k));
    expect(мёртвые,
      `движок умеет проверять ${мёртвые.join(', ')}, но ни одна площадка такого порога `
      + 'не ставит. Либо порог нужен и его стоит объявить, либо запись в BUDGET_SPEC мёртвая')
      .toEqual([]);
  });
});
