// tests/architecture/viewport-panels.test.mjs — устройство панелей над вьюпортом.
//
// Заведено 2026-08-15 вместе с переносом свойств модели на полку значков.
//
// Что защищаем и почему именно это.
//
// 1. Верхняя панель не растёт. До перестройки всё жило одной строкой внизу, и строка
//    прибавляла по группе с каждой возможностью: при трёх она уже не помещалась во
//    вьюпорт. Впереди камеры автора и свет из файла — без сторожа строка соберётся
//    заново, просто в другом месте.
//
// 2. Закрытие полочки — это ТОЛЬКО показ. Требование Александра дословно: «схлопывается,
//    но анимация-то не останавливается». Гарантия держится на том, что обработчик полки
//    не зовёт движок просмотра вообще: он трогает классы и `aria-expanded`, и больше
//    ничего. Проверяем именно это — отсутствие связи, а не её последствие.
//
// 3. У значка нет текста, поэтому подпись обязана идти из каталога (Правило 8).
//    Немой ряд иероглифов без title/aria — это не интерфейс.
//
// Ограничение метода названо честно: разметку и код читаем как ТЕКСТ, DOM в node-тестах
// нет. Проверки опираются на порядок кусков в файле и на границы, помеченные якорями.
// Переставят блоки местами — тест придётся поправить; это цена дешёвого сторожа, и она
// меньше, чем цена молча расползшейся панели.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'ui', 'app.ts'), 'utf8');

// Комментарии из кода вырезаем: они объясняют, ПОЧЕМУ движка тут нет, и упоминают его
// по имени. Без вырезания сторож краснел бы ровно на объяснении своего же правила.
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

/** Группы свойств модели: появляются только у той модели, где это есть. */
const GROUP_IDS = [
  'lod-controls', 'variant-controls', 'camera-controls', 'light-controls', 'anim-controls',
];

describe('панели вьюпорта — устройство', () => {
  it('верхняя панель держит только общее: групп свойств модели в ней нет', () => {
    const toolbar = html.indexOf('class="vp-toolbar"');
    const rail = html.indexOf('class="vp-rail"');
    expect(toolbar, 'в разметке нет .vp-toolbar').toBeGreaterThan(-1);
    expect(rail, 'в разметке нет .vp-rail').toBeGreaterThan(-1);
    expect(rail, 'полка значков должна идти ПОСЛЕ верхней панели').toBeGreaterThan(toolbar);

    // Ни одна группа не должна оказаться между началом верхней панели и началом полки.
    const between = html.slice(toolbar, rail);
    for (const id of GROUP_IDS) {
      expect(between.includes(`id="${id}"`),
        `${id} снова в верхней панели — она опять растёт строкой`).toBe(false);
    }
  });

  it('каждая группа живёт на полке значков', () => {
    const rail = html.indexOf('class="vp-rail"');
    const tail = html.slice(rail);
    for (const id of GROUP_IDS) {
      expect(tail.includes(`id="${id}"`), `${id} не на полке значков`).toBe(true);
    }
  });

  it('у каждой группы есть свой значок с подписью из каталога', () => {
    const rail = html.slice(html.indexOf('class="vp-rail"'));
    const buttons = [...rail.matchAll(/<button[^>]*vp-group-btn[^>]*>/g)].map((m) => m[0]);
    expect(buttons.length, 'значков на полке меньше, чем групп').toBe(GROUP_IDS.length);
    for (const btn of buttons) {
      // Правило 8: у значка нет текста, подпись берётся по ключу — иначе он немой.
      expect(/data-i18n-title="/.test(btn), `значок без data-i18n-title: ${btn}`).toBe(true);
      expect(/data-i18n-aria="/.test(btn), `значок без data-i18n-aria: ${btn}`).toBe(true);
      expect(/aria-expanded="/.test(btn), `значок без aria-expanded: ${btn}`).toBe(true);
    }
  });

  // Главное утверждение файла. Между якорями лежит вся проводка полки; движка
  // просмотра там быть не должно ни в каком виде.
  it('закрытие полочки не трогает движок просмотра — анимация продолжает идти', () => {
    const code = stripComments(app);
    const start = code.indexOf("document.querySelector('.vp-rail')");
    const end = code.indexOf('window.onOptiViewerModelLoaded =');
    expect(start, 'не нашёл проводку полки — якорь сменился').toBeGreaterThan(-1);
    expect(end, 'не нашёл якорь конца проводки').toBeGreaterThan(start);

    const wiring = code.slice(start, end);
    // Именно эти вызовы означали бы, что закрытие ВЫКЛЮЧАЕТ, а не прячет.
    for (const call of ['OptiViewer', 'setAnimationPlaying', 'selectLod', 'selectVariant', 'seekAnimation']) {
      expect(wiring.includes(call),
        `проводка полки зовёт ${call} — закрытие перестало быть только показом`).toBe(false);
    }
    // И наоборот: она обязана делать ровно своё дело.
    expect(wiring.includes('is-open'), 'проводка полки не открывает и не закрывает полочки').toBe(true);
    expect(wiring.includes('aria-expanded'), 'состояние полочки не сообщается голосом').toBe(true);
  });
});
