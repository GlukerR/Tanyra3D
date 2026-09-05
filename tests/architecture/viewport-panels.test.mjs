import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'ui', 'app.ts'), 'utf8');

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

const GROUP_IDS = [
  'lod-controls', 'variant-controls', 'camera-controls', 'anim-controls',
];

const TOOLBAR_GROUP_IDS = ['light-controls'];

const ALL_GROUP_IDS = [...GROUP_IDS, ...TOOLBAR_GROUP_IDS];

describe('панели вьюпорта — устройство', () => {
  it('верхняя панель держит только общее: групп свойств модели в ней нет', () => {
    const toolbar = html.indexOf('class="vp-toolbar"');
    const rail = html.indexOf('class="vp-rail"');
    expect(toolbar, 'в разметке нет .vp-toolbar').toBeGreaterThan(-1);
    expect(rail, 'в разметке нет .vp-rail').toBeGreaterThan(-1);
    expect(rail, 'полка значков должна идти ПОСЛЕ верхней панели').toBeGreaterThan(toolbar);

    const between = html.slice(toolbar, rail);
    for (const id of GROUP_IDS) {
      expect(between.includes(`id="${id}"`),
        `${id} снова в верхней панели — она опять растёт строкой`).toBe(false);
    }
  });

  it('каждая группа живёт там, где ей положено', () => {
    const rail = html.indexOf('class="vp-rail"');
    const tail = html.slice(rail);
    for (const id of GROUP_IDS) {
      expect(tail.includes(`id="${id}"`), `${id} не на полке значков`).toBe(true);
    }
    const between = html.slice(html.indexOf('class="vp-toolbar"'), rail);
    for (const id of TOOLBAR_GROUP_IDS) {
      expect(between.includes(`id="${id}"`), `${id} не в верхней панели`).toBe(true);
    }
  });

  it('условные группы спрятаны в разметке, а постоянные — нет', () => {
    for (const id of GROUP_IDS) {
      const tag = html.slice(html.indexOf(`id="${id}"`));
      expect(tag.slice(0, 120).includes('hidden'), `${id} не скрыт до загрузки модели`).toBe(true);
    }
    for (const id of TOOLBAR_GROUP_IDS) {
      const start = html.indexOf(`id="${id}"`);
      const tag = html.slice(start, html.indexOf('>', start));
      expect(tag.includes('hidden'), `${id} спрятан, хотя должен стоять всегда`).toBe(false);
    }
  });

  it('солнышко открывает меню сразу — без списка внутри и без подписи', () => {
    const start = html.indexOf('id="light-controls"');
    const block = html.slice(start, html.indexOf('id="exposure-slider"', start));
    expect(block.includes('vp-ctl-label'), 'у солнышка появилась подпись словом').toBe(false);
    expect(block.includes('<select'), 'внутри полочки снова список — окно в окне').toBe(false);
    expect(block.includes('vp-pop-menu'), 'полочка солнышка перестала быть меню').toBe(true);
    expect(block.includes('vp-caret'), 'у солнышка нет стрелки выпадающего меню').toBe(true);
  });

  it('у каждой группы есть свой значок с подписью из каталога', () => {
    const zone = html.slice(html.indexOf('class="vp-toolbar"'));
    const buttons = [...zone.matchAll(/<button[^>]*vp-group-btn[^>]*>/g)].map((m) => m[0]);
    expect(buttons.length, 'значков не столько, сколько групп').toBe(ALL_GROUP_IDS.length);
    for (const btn of buttons) {
      expect(/data-i18n-title="/.test(btn), `значок без data-i18n-title: ${btn}`).toBe(true);
      expect(/data-i18n-aria="/.test(btn), `значок без data-i18n-aria: ${btn}`).toBe(true);
      expect(/aria-expanded="/.test(btn), `значок без aria-expanded: ${btn}`).toBe(true);
    }
  });

  it('закрытие полочки не трогает движок просмотра — анимация продолжает идти', () => {
    const code = stripComments(app);
    const start = code.indexOf("document.querySelectorAll('.vp-rail, .vp-toolbar')");
    const end = code.indexOf('window.onOptiViewerModelLoaded =');
    expect(start, 'не нашёл проводку полки — якорь сменился').toBeGreaterThan(-1);
    expect(end, 'не нашёл якорь конца проводки').toBeGreaterThan(start);

    const wiring = code.slice(start, end);
    for (const call of ['OptiViewer', 'setAnimationPlaying', 'selectLod', 'selectVariant', 'seekAnimation']) {
      expect(wiring.includes(call),
        `проводка полки зовёт ${call} — закрытие перестало быть только показом`).toBe(false);
    }
    expect(wiring.includes('is-open'), 'проводка полки не открывает и не закрывает полочки').toBe(true);
    expect(wiring.includes('aria-expanded'), 'состояние полочки не сообщается голосом').toBe(true);
  });
});

describe('пробел — пуск и пауза анимации', () => {
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
    const css = fs.readFileSync(path.join(ROOT, 'ui', 'style.css'), 'utf8');
    const rule = css.slice(css.indexOf('.vp-shading {'), css.indexOf('}', css.indexOf('.vp-shading {')));
    expect(/top:\s*14px/.test(rule), 'группа шариков не прижата к верху').toBe(true);
    expect(/right:\s*14px/.test(rule), 'группа шариков не прижата к правому краю').toBe(true);
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
    for (const b of btns) {
      expect(/data-i18n-title="/.test(b), `шарик без data-i18n-title: ${b}`).toBe(true);
      expect(/data-i18n-aria="/.test(b), `шарик без data-i18n-aria: ${b}`).toBe(true);
    }
  });
});
