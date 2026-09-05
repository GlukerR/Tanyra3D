import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSource } from './helpers/source-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const APP = readSource('ui/app');
const EN = fs.readFileSync(path.join(ROOT, 'ui', 'locales', 'en.js'), 'utf8');
const RU = fs.readFileSync(path.join(ROOT, 'translations', 'ru.js'), 'utf8');

function кнопка(id) {
  const m = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(HTML);
  expect(m, `в разметке нет кнопки #${id}`).toBeTruthy();
  return m[0];
}

describe('тяжёлый способ показа включается в настройках', () => {
  it('основных кнопок показа три, четвёртая скрыта в разметке', () => {
    for (const id of ['display-wire', 'display-clay', 'display-file']) {
      expect(кнопка(id), `#${id} — основной способ показа, он не прячется`)
        .not.toMatch(/class="[^"]*\bhidden\b/);
    }
    expect(кнопка('display-texdiff'), 'четвёртая кнопка обязана быть скрытой по умолчанию')
      .toMatch(/class="[^"]*\bhidden\b/);
  });

  it('в настройках есть галочка и сказано, чем за неё платишь', () => {
    expect(HTML).toMatch(/<input[^>]*type="checkbox"[^>]*id="setting-texdiff"/);
    expect(HTML).toContain('data-i18n="menu.settings.texdiff"');
    expect(HTML).toContain('data-i18n="menu.settings.texdiff.hint"');
    for (const [имя, каталог] of [['en', EN], ['ru', RU]]) {
      for (const ключ of ['menu.settings.viewport', 'menu.settings.texdiff', 'menu.settings.texdiff.hint']) {
        expect(каталог, `в каталоге ${имя} нет ключа ${ключ}`).toContain(`'${ключ}'`);
      }
    }
  });

  it('выбор помнится между запусками', () => {
    expect(APP).toMatch(/localStorage\.getItem\(ТЯЖЁЛЫЙ_РЕЖИМ\)/);
    expect(APP).toMatch(/localStorage\.setItem\(ТЯЖЁЛЫЙ_РЕЖИМ/);
    expect(APP).toMatch(/ТЯЖЁЛЫЙ_РЕЖИМ = 'tanyra\.texdiff'/);
    expect(APP.match(/catch \(e\) \{ return false; \}/g) ?? []).not.toHaveLength(0);
  });

  it('снятая галочка убирает кнопку и выводит из режима', () => {
    const тело = /function применитьTexdiff\([\s\S]*?\n {2}\}/.exec(APP);
    expect(тело, 'применитьTexdiff пропала — кнопкой больше никто не управляет').toBeTruthy();
    const код = тело[0];
    expect(код).toMatch(/displayTexdiffBtn\?\.classList\.toggle\('hidden', !on\)/);
    expect(код).toMatch(/getDisplayMaterial\?\.\(\) === 'texdiff'/);
    expect(код).toMatch(/setDisplayMaterial\('file'\)/);
  });

  it('сам способ показа из движка НЕ удалён', () => {
    expect(readSource('ui/viewer/contract'))
      .toMatch(/DISPLAY_MODES = \['wire', 'clay', 'file', 'texdiff'\]/);
  });
});
