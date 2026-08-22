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

/**
 * Группы СВОЙСТВ МОДЕЛИ: появляются только у той модели, где это свойство есть. У модели
 * без своих камер значка камер быть не должно — «камера автора» без камер бессмысленна.
 */
const GROUP_IDS = [
  'lod-controls', 'variant-controls', 'camera-controls', 'light-controls', 'anim-controls',
];

/**
 * Групп, стоящих ВСЕГДА, больше нет ни одной — и это не потеря, а упрощение.
 *
 * Такая группа была ровно одна: «Поверхность» (материалы модели или наша глина,
 * 2026-08-20). Полочка со списком из двух строк стоила двух нажатий там, где хватает
 * одного, и 2026-08-22 Александр это назвал: «пусть там будет не материал\глина а просто
 * шарик на который нажимаешь и меняется отображение». Теперь это кнопка-переключатель
 * `#display-toggle` прямо на полке, без полочки и без списка.
 *
 * Список оставлен пустым НАМЕРЕННО, а не удалён: постоянная группа — законный род, и
 * появись она снова, ей есть куда встать.
 */
const ALWAYS_GROUP_IDS = [];

const ALL_GROUP_IDS = [...GROUP_IDS, ...ALWAYS_GROUP_IDS];

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
    for (const id of ALL_GROUP_IDS) {
      expect(tail.includes(`id="${id}"`), `${id} не на полке значков`).toBe(true);
    }
  });

  it('условные группы спрятаны в разметке, а постоянные — нет', () => {
    // Разница видна ровно здесь. Группа свойства модели обязана стартовать скрытой:
    // до загрузки модели неизвестно, есть ли у неё это свойство, а показанный пустой
    // значок обещал бы то, чего нет (Правило 12). Постоянная группа, наоборот, скрытой
    // быть не должна — иначе способ показа стал бы недоступен на пустом экране.
    for (const id of GROUP_IDS) {
      const tag = html.slice(html.indexOf(`id="${id}"`));
      expect(tag.slice(0, 120).includes('hidden'), `${id} не скрыт до загрузки модели`).toBe(true);
    }
    for (const id of ALWAYS_GROUP_IDS) {
      const start = html.indexOf(`id="${id}"`);
      const tag = html.slice(start, html.indexOf('>', start));
      expect(tag.includes('hidden'), `${id} спрятан, хотя должен стоять всегда`).toBe(false);
    }
  });

  it('у каждой группы есть свой значок с подписью из каталога', () => {
    const rail = html.slice(html.indexOf('class="vp-rail"'));
    const buttons = [...rail.matchAll(/<button[^>]*vp-group-btn[^>]*>/g)].map((m) => m[0]);
    expect(buttons.length, 'значков на полке не столько, сколько групп').toBe(ALL_GROUP_IDS.length);
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

describe('пробел — пуск и пауза анимации', () => {
  // Просьба Александра 2026-08-22. Клавиша и кнопка обязаны делать ОДНО И ТО ЖЕ, иначе
  // две копии переключателя разойдутся на первой же правке.
  //
  // И пробел не всегда наш: в поле ввода это пробел, на кнопке в фокусе он уже работает
  // (нажимает её), а без анимации нажимать нечего. Клавиша, которая делает вид, что
  // сработала, хуже клавиши, которая молчит.

  it('кнопка и клавиша зовут один переключатель', () => {
    expect(app, 'переключение анимации снова написано на месте, а не одной функцией')
      .toMatch(/function toggleAnimation\(\)/);
    expect(app, 'кнопка перестала звать общий переключатель')
      .toMatch(/animPlayBtn\.addEventListener\('click', toggleAnimation\)/);
  });

  it('пробел перехватывается и не листает страницу', () => {
    const at = app.indexOf("if (e.key !== ' ' && e.code !== 'Space') return;");
    expect(at, 'обработчика пробела нет').toBeGreaterThan(-1);
    const handler = app.slice(at, at + 900);
    expect(handler, 'пробел не переключает анимацию').toContain('toggleAnimation()');
    expect(handler, 'без preventDefault пробел пролистает страницу').toContain('e.preventDefault()');
  });

  it('в поле ввода и на клавише пробел остаётся чужим', () => {
    const at = app.indexOf("if (e.key !== ' ' && e.code !== 'Space') return;");
    const handler = app.slice(at, at + 900);
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) {
      expect(handler, `пробел отбирается у ${tag} — там он и так работает`).toContain(tag);
    }
    expect(handler, 'редактируемая область не учтена').toContain('isContentEditable');
  });

  it('без анимации клавиша молчит', () => {
    const at = app.indexOf("if (e.key !== ' ' && e.code !== 'Space') return;");
    const handler = app.slice(at, at + 900);
    expect(handler, 'пробел срабатывает и на модели без анимации — панели-то нет')
      .toMatch(/animControls[\s\S]{0,80}hidden/);
  });
});

describe('чем показывать — два шарика в правом верхнем углу', () => {
  // Александр 2026-08-22: «Можно сделать как в блендере 2 шарика. но тогда как и в
  // блендере лучше сделать сверху справа. Что бы уж точно понятно и нативно было».
  //
  // Верхняя панель для этого не годится: она ЦЕНТРИРОВАНА, и на широком экране её правый
  // край оказывается посреди вьюпорта, а не справа. Поэтому отдельная группа в углу.
  it('стоит своей группой, а не внутри центральной панели и не на полке значков', () => {
    const bar = html.indexOf('class="vp-toolbar"');
    const barEnd = html.indexOf('</div>', html.indexOf('id="exposure-value"'));
    const shading = html.indexOf('class="vp-shading"');
    expect(shading, 'группы шариков нет в разметке').toBeGreaterThan(-1);
    expect(shading, 'шарики оказались ВНУТРИ центральной панели — она снова растёт')
      .toBeGreaterThan(barEnd);
    expect(bar).toBeGreaterThan(-1);
    for (const id of ['display-file', 'display-clay']) {
      expect(html.includes(`id="${id}"`), `${id} пропал`).toBe(true);
    }
    expect(html.includes('id="display-select"'), 'список показа вернулся').toBe(false);
    expect(html.includes('id="display-controls"'), 'шарики снова завёрнуты в полочку').toBe(false);
  });

  it('прижата к правому верхнему углу и не накрывает числа', () => {
    // Две половины одного требования. Угол — то, о чём просили; отодвинутые числа — то,
    // без чего угол занимать нельзя: там показания, ради которых окно и открыто.
    const css = fs.readFileSync(path.join(ROOT, 'ui', 'style.css'), 'utf8');
    const rule = css.slice(css.indexOf('.vp-shading {'), css.indexOf('}', css.indexOf('.vp-shading {')));
    expect(/top:\s*14px/.test(rule), 'группа шариков не прижата к верху').toBe(true);
    expect(/right:\s*14px/.test(rule), 'группа шариков не прижата к правому краю').toBe(true);
    // Числа не теснятся вбок, а стоят СТРОКОЙ НИЖЕ верхнего ряда (Александр, 2026-08-22:
    // «пусть "исходная модель" и "после оптимизации" и все цифры будут ниже чем панель с
    // экспозицией камерой и материалами»). Проверяем именно это: у каждой вещи своя
    // строка, и ни одна никого не отодвигает.
    const hud = css.slice(css.indexOf('.vp-hud {'), css.indexOf('}', css.indexOf('.vp-hud {')));
    const top = /top:\s*(\d+)px/.exec(hud);
    expect(top, 'у HUD нет отступа сверху').toBeTruthy();
    expect(Number(top[1]), 'подписи и числа снова вровень с верхним рядом').toBeGreaterThan(52);
  });

  it('это переключатель из двух положений, а не две независимые кнопки', () => {
    const btns = [...html.matchAll(/<button id="display-(file|clay)"[^>]*>/g)].map((m) => m[0]);
    expect(btns.length, 'кнопок показа не две').toBe(2);
    const pressed = btns.filter((b) => /aria-pressed="true"/.test(b));
    expect(pressed.length, 'нажатым должен быть ровно один шарик').toBe(1);
    expect(/id="display-file"/.test(pressed[0]), 'на старте нажата не «как в файле»').toBe(true);
    // Правило 8: у значка нет текста — подпись обязана идти по ключу.
    for (const b of btns) {
      expect(/data-i18n-title="/.test(b), `шарик без data-i18n-title: ${b}`).toBe(true);
      expect(/data-i18n-aria="/.test(b), `шарик без data-i18n-aria: ${b}`).toBe(true);
    }
  });
});
