import { describe, it, expect } from 'vitest';

import { readSource } from './helpers/source-files.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const APP = readSource('ui/app');
const HTML = read('ui', 'index.html');

function bookTexts() {
  const out = [];
  for (const dir of ['profiles', 'engines']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.json'))) {
      const json = JSON.parse(read(dir, f));
      const d = json.description;
      if (typeof d === 'string') out.push([`${dir}/${f}`, d]);
      else if (d && typeof d === 'object') {
        for (const [lang, text] of Object.entries(d)) out.push([`${dir}/${f} (${lang})`, text]);
      }
    }
  }
  for (const cat of ['ru.mjs', 'en.mjs']) {
    const src = read('messages', cat);
    for (const m of src.matchAll(/'(option\.[a-z0-9-]+\.(?:description|impact))':\s*\(\)\s*=>\s*'([^']*)'/g)) {
      out.push([`messages/${cat} ${m[1]}`, m[2]]);
    }
  }
  return out;
}

describe('книжечка не объясняет устройство интерфейса', () => {
  const ЦВЕТА = /(?<![a-zа-яё])красн|\bred\b/i;

  it('ни в одном описании площадки, движка или опции не упомянут красный цвет', () => {
    const виноватые = bookTexts()
      .filter(([, text]) => ЦВЕТА.test(text))
      .map(([где, text]) => `${где}: «${text.slice(0, 80)}…»`);
    expect(
      виноватые,
      'про красный человек читает один раз — в окне выгрузки (Правило 10а):\n' + виноватые.join('\n'),
    ).toEqual([]);
  });
});

describe('окно выгрузки объясняет красный бюджет', () => {
  it('в разметке есть блок и место под строки', () => {
    expect(HTML, 'нет блока export-budget').toMatch(/id="export-budget"/);
    expect(HTML, 'нет списка export-budget-details').toMatch(/id="export-budget-details"/);
    expect(HTML).toMatch(/data-i18n="export\.budget\.title"/);
    expect(HTML).toMatch(/data-i18n="export\.budget\.note"/);
  });

  it('ключи есть в обоих каталогах', () => {
    const ru = read('translations', 'ru.js');
    const en = read('ui', 'locales', 'en.js');
    for (const key of ['export.budget.title', 'export.budget.note']) {
      expect(ru, `нет ru: ${key}`).toContain(`'${key}'`);
      expect(en, `нет en: ${key}`).toContain(`'${key}'`);
    }
  });

  it('показываются только настоящие отказы площадки, а не советы', () => {
    const начало = APP.indexOf('function renderExportBudget');
    expect(начало, 'renderExportBudget пропал — объяснять красное стало некому').toBeGreaterThan(-1);
    const тело = APP.slice(начало, APP.indexOf('\n  }', начало));
    expect(тело, 'фильтр не по level === over').toMatch(/level\s*===\s*'over'/);
    expect(тело, 'в окно выгрузки попали жёлтые советы').not.toMatch(/'warn'/);
    expect(тело, 'текст собирается в коде, а не берётся из отчёта').toMatch(/\.advice/);
  });

  it('блок гаснет вместе с остальными предупреждениями окна', () => {
    const начало = APP.indexOf('function renderIntegrity');
    const тело = APP.slice(начало, APP.indexOf('\n  }', начало));
    expect(тело, 'renderIntegrity больше не гасит блок бюджета').toMatch(/renderExportBudget\(/);
  });
});
