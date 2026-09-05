import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const ПЕРВЫЙ_С_ПРАВИЛОМ = [0, 2, 9];

const число = (tag) => tag.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);

const новееПравила = (tag) => {
  const [a, b, c] = число(tag);
  const [x, y, z] = ПЕРВЫЙ_С_ПРАВИЛОМ;
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
};

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let выпуски = null;
let можноВыпускать = false;
let почемуМолчим = null;
try {
  gh(['--version']);
} catch (err) {
  почемуМолчим = `gh не установлен: ${String(err?.message || err).split(/\r?\n/)[0]}`;
}
if (почемуМолчим === null) {
  try {
    gh(['auth', 'status']);
    можноВыпускать = true;
  } catch (err) {
    почемуМолчим = `gh без доступа к GitHub: ${String(err?.message || err).split(/\r?\n/)[0]}`;
  }
}
if (можноВыпускать) {
  try {
    выпуски = JSON.parse(gh(['api', 'repos/{owner}/{repo}/releases', '--paginate']))
      .map((r) => ({ tagName: r.tag_name, body: r.body }));
  } catch (err) {
    почемуМолчим = String(err?.message || err).split(/\r?\n/)[0];
  }
}

const пусто = (body) => {
  const строки = String(body || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^\*{0,2}full changelog/i.test(s));
  return строки.length === 0;
};

describe('у каждого выпуска есть описание', () => {
  it.skipIf(!выпуски)('ни один опубликованный выпуск не остался с одной «Full Changelog»', () => {
    const немые = выпуски
      .filter((r) => новееПравила(r.tagName))
      .filter((r) => пусто(r.body))
      .map((r) => r.tagName);
    expect(
      немые,
      'выпуск опубликован без описания — поставить его командой `gh release edit <тег> --notes …` '
      + 'и проверить глазами `gh release view <тег> --json body`. Нечего написать — значит и '
      + 'версию поднимать было не за что (Александр, 2026-09-03)',
    ).toEqual([]);
  });

  it.skipIf(!выпуски)('описание — список, а не сплошной текст', () => {
    const несписки = выпуски
      .filter((r) => новееПравила(r.tagName) && !пусто(r.body))
      .filter((r) => !String(r.body).split('\n').some((s) => /^\s*[-*]\s+\S/.test(s)))
      .map((r) => r.tagName);
    expect(несписки, 'описание выпуска пишется списком: строка на изменение').toEqual([]);
  });

  it('граница правила названа, а не угадывается', () => {
    expect(ПЕРВЫЙ_С_ПРАВИЛОМ).toHaveLength(3);
    expect(новееПравила('v0.2.9'), 'выпуск, с которого правило действует, обязан проверяться').toBe(true);
    expect(новееПравила('v0.2.8'), 'выпуск до правила проверяться не должен').toBe(false);
    expect(новееПравила('v0.3.0'), 'следующая крупная версия обязана проверяться').toBe(true);
  });

  it('молчание разрешено только там, откуда не выпускают', () => {
    if (выпуски) return;
    expect(
      можноВыпускать,
      `права на GitHub есть, а выпуски прочитать не вышло: ${почемуМолчим}. `
      + 'Сторож слеп — чинить его, а не выпускать вслепую',
    ).toBe(false);
    expect(почемуМолчим, 'выпуски не прочитаны, а причина не названа').toBeTruthy();
  });
});
