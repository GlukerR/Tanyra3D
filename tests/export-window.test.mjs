// tests/export-window.test.mjs — окно выгрузки: последнее место, где человек ещё может
// передумать.
//
// Правило 10а (Александр, 2026-08-10): «красным помечается только настоящий отказ
// конкретной площадки… это вообще не нужно писать в книжечках нигде… тогда только в конце
// при выгрузке модели писать почему красным. и всё».
//
// Отсюда две проверки, и они противоположны по знаку:
//   1. В книжечках (описания площадок, движков, опций) про цвета интерфейса не сказано
//      ни слова. Цвет — устройство интерфейса, а подсказка говорит про свою кнопку.
//   2. В окне выгрузки объяснение ЕСТЬ, и оно берётся из готовых строк отчёта, а не
//      собирается заново (Правило 8: язык отдельно от кода).
//
// Проверки статические: поведение живёт в браузере, а сюда смотрит сторож за теми
// местами, откуда беда возвращается. Сквозная проверка сделана руками в живом
// приложении — модель сверх предела, окно выгрузки, обе смены языка и сброс.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const APP = read('ui', 'app.js');
const HTML = read('ui', 'index.html');

/** Тексты, которые человек читает как подсказку у поля. */
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
  // Слова опций — там же по смыслу: это подсказка у флажка.
  for (const cat of ['ru.mjs', 'en.mjs']) {
    const src = read('messages', cat);
    for (const m of src.matchAll(/'(option\.[a-z0-9-]+\.(?:description|impact))':\s*\(\)\s*=>\s*'([^']*)'/g)) {
      out.push([`messages/${cat} ${m[1]}`, m[2]]);
    }
  }
  return out;
}

describe('книжечка не объясняет устройство интерфейса', () => {
  // Цвет строки бюджета — не свойство площадки и не свойство опции. Он одинаков везде,
  // а значит объяснять его в каждой подсказке значит писать одно и то же N раз.
  //
  // `\b` тут не работает: в JS граница слова считается по [A-Za-z0-9_], и перед
  // кириллической «К» её просто нет — `\bкрасн` не совпадает никогда. Первая версия
  // проверки была именно такой и пропускала мутацию: слово вернули в книжечку, а тест
  // остался зелёным. Поэтому взгляд назад на букву — он же отсекает «прекрасный».
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
    // Заголовок и примечание — по ключу, а не текстом в разметке (Правило 8).
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
    // warn — жёлтый, это рекомендация; в окне выгрузки ему делать нечего.
    const начало = APP.indexOf('function renderExportBudget');
    expect(начало, 'renderExportBudget пропал — объяснять красное стало некому').toBeGreaterThan(-1);
    const тело = APP.slice(начало, APP.indexOf('\n  }', начало));
    expect(тело, 'фильтр не по level === over').toMatch(/level\s*===\s*'over'/);
    expect(тело, 'в окно выгрузки попали жёлтые советы').not.toMatch(/'warn'/);
    // Строку берём готовой из отчёта: своя фраза разошлась бы с панелью и с языком.
    expect(тело, 'текст собирается в коде, а не берётся из отчёта').toMatch(/\.advice/);
  });

  it('блок гаснет вместе с остальными предупреждениями окна', () => {
    // Сбросов результата в интерфейсе шесть, и все они сделаны вызовом
    // renderIntegrity(null). Отдельная точка входа рано или поздно один из путей
    // пропустила бы — и объяснение осталось бы висеть от прошлой модели.
    const начало = APP.indexOf('function renderIntegrity');
    const тело = APP.slice(начало, APP.indexOf('\n  }', начало));
    expect(тело, 'renderIntegrity больше не гасит блок бюджета').toMatch(/renderExportBudget\(/);
  });
});
