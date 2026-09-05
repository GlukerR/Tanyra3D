import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const РАЗМЕТКА = 'ui/index.html';
const строки = fs.readFileSync(path.join(root, РАЗМЕТКА), 'utf8').split(/\r?\n/);

function безКлюча(атрибут, ключевой) {
  const плохие = [];
  строки.forEach((строка, i) => {
    const re = new RegExp(`\\s${атрибут}="([A-ZА-Я][^"]*)"`, 'g');
    for (const [, текст] of строка.matchAll(re)) {
      if (строка.includes(ключевой)) continue;
      плохие.push(`${РАЗМЕТКА}:${i + 1} → ${атрибут}="${текст}"`);
    }
  });
  return плохие;
}

describe('Правило 8 распространяется и на то, что человек слышит', () => {
  it('у каждого aria-label есть ключ data-i18n-aria', () => {
    expect(
      безКлюча('aria-label', 'data-i18n-aria'),
      'Подпись для читалки экрана без ключа: при русском интерфейсе она будет прочитана по-английски. '
      + 'Добавить data-i18n-aria="ключ" рядом, оставив английский текст запасным вариантом (образец — win.close).',
    ).toEqual([]);
  });

  it('у каждого title есть ключ data-i18n-title', () => {
    expect(
      безКлюча('title', 'data-i18n-title'),
      'Всплывающая подсказка без ключа — тот же случай, что и aria-label: человек её ВИДИТ.',
    ).toEqual([]);
  });

  it('проверять было что (разметка разобралась)', () => {
    const всего = строки.filter((l) => /\saria-label="/.test(l)).length;
    expect(всего, 'в разметке не нашлось ни одного aria-label — разбор сломался').toBeGreaterThan(20);
  });
});
