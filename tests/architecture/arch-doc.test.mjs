import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ДОК = 'docs/ARCHITECTURE.md';
const текст = fs.readFileSync(path.join(root, ДОК), 'utf8');
const движок = fs.readFileSync(path.join(root, 'core', 'engine.mts'), 'utf8');

function раздел(заголовок) {
  const от = текст.indexOf(заголовок);
  if (от === -1) return '';
  const дальше = текст.indexOf('\n## ', от + заголовок.length);
  return текст.slice(от, дальше === -1 ? текст.length : дальше);
}

const безСносок = (кусок) => кусок
  .split(/\r?\n/)
  .filter((l) => !l.trimStart().startsWith('>'))
  .join('\n');

const ПЯТЬ_ФАЗ = безСносок(раздел('## 5. Data flow'));

describe('§5 не называет полей профиля, которых нет', () => {
  const поля = new Set();
  for (const f of fs.readdirSync(path.join(root, 'profiles')).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'profiles', f), 'utf8'));
    for (const k of Object.keys(j)) поля.add(k);
  }

  it('раздел найден', () => {
    expect(ПЯТЬ_ФАЗ.length, `в ${ДОК} не нашёлся раздел «## 5. Data flow»`).toBeGreaterThan(200);
  });

  const названные = [...new Set([...ПЯТЬ_ФАЗ.matchAll(/\bprofile\.([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
  for (const имя of названные) {
    it(`profile.${имя} — такое поле у профилей есть`, () => {
      expect(
        поля.has(имя),
        `${ДОК} §5 описывает механизм через «profile.${имя}», а такого поля нет ни в одном profiles/*.json. `
        + 'Либо поле называется иначе, либо механизм вообще не в профиле — проверить по core/ и поправить документ. '
        + '§4 под это правило не подпадает: он помечен design sketch.',
      ).toBe(true);
    });
  }
});

describe('число фаз в документе и в движке совпадает', () => {
  it('пять там и пять здесь', () => {
    const вДоке = new Set([...ПЯТЬ_ФАЗ.matchAll(/^\s*PHASE (\d)/gm)].map((m) => m[1]));
    const вДвижке = new Set([...движок.matchAll(/type:\s*'phase',\s*phase:\s*(\d)/g)].map((m) => m[1]));
    expect(вДоке.size, 'в §5 не разобрана ни одна строка «PHASE N» — формат раздела сменился')
      .toBeGreaterThan(0);
    expect(
      [...вДоке].sort(),
      `${ДОК} §5 описывает ${вДоке.size} фаз(ы), а core/engine.mts объявляет ${вДвижке.size}. `
      + 'Фазу добавили или убрали, а документ об этом не узнал.',
    ).toEqual([...вДвижке].sort());
  });
});
