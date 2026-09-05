import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const APP = read('ui/app.ts');
const HTML = read('ui/index.html');
const RU = read('translations/ru.js');
const EN = read('ui/locales/en.js');
const SERVER = read('server.mts');
const CONTRACT = read('ui/viewer/contract.ts');
const GLOBALS = read('ui/globals.d.ts');

const block = (from) => {
  const src = APP.slice(APP.indexOf(from));
  return src.slice(0, src.indexOf('\n  }'));
};

describe('значок «В модели» — единственный ответ про исходный файл', () => {
  const CATALOGS = ['translations/ru.js', 'ui/locales/en.js'];
  const BANNED = /(уже в модели|сейчас в модели|already in the model)/i;

  it.each(CATALOGS)('%s не обещает «уже в модели»', (rel) => {
    const offences = read(rel).split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => !line.startsWith('//') && BANNED.test(line));
    expect(offences.map((o) => `${rel}:${o.n} — ${o.line}`),
      'что пришло в модели, говорит значок «В модели», а не строка над группой').toEqual([]);
  });

  it('значок ставится проходом по таблице, а не именными случаями', () => {
    expect(APP).toMatch(/for \(const id of sourceTechnologies\(\)\) badgeOption\(id\)/);
  });

  it('снятая галочка значка не убирает', () => {
    const handler = APP.slice(APP.indexOf('function onOptionChanged()'));
    const body = handler.slice(0, handler.indexOf('\n  }'));
    expect(body).not.toMatch(/showDetectionBadges|sourceTechnologies/);
  });
});

describe('таблица SOURCE_MARKERS полна', () => {
  const marked = new Set(
    [...APP.slice(APP.indexOf('const SOURCE_MARKERS'), APP.indexOf('function sourceTechnologies'))
      .matchAll(/^\s{4}([a-z0-9-]+):\s*'([A-Z][A-Za-z0-9_]+)'/gm)].map((m) => m[1]),
  );

  const MUST_BE_MARKED = ['meshopt', 'draco', 'quantize', 'ktx2', 'webp', 'instance'];

  it.each(MUST_BE_MARKED)('%s помечается значком «В модели»', (id) => {
    expect(marked.has(id),
      `опция ${id} не в SOURCE_MARKERS: человек с такой моделью значка не увидит`).toBe(true);
  });

  it('каждая помеченная опция и правда существует в движке', () => {
    const rules = read('addons/gltf/rules.mts');
    const index = read('addons/gltf/index.mts');
    for (const id of marked) {
      expect(`${rules}${index}`.includes(`'${id}'`),
        `${id} есть в SOURCE_MARKERS, но такой опции движок не знает`).toBe(true);
    }
  });
});

describe('противоположные кнопки сведены в одну', () => {
  it('над списком моделей один выключатель, а не «все» и «ничего»', () => {
    expect(HTML).not.toMatch(/id="batch-all"|id="batch-none"/);
    expect(HTML).toMatch(/id="batch-toggle"/);
  });

  it('выключатель носит тот же класс, что галочки моделей', () => {
    expect(HTML).toMatch(/id="batch-toggle"[^>]*class="[^"]*\bmodel-pick\b/);
  });

  it('полоса выбора НЕ прокручивается вместе со списком', () => {
    const body = HTML.slice(HTML.indexOf('<div class="outliner-body">'));
    const bodyEnd = body.indexOf('</aside>');
    expect(body.slice(0, bodyEnd), 'полоса вернулась внутрь прокручиваемого тела')
      .not.toMatch(/id="batch-bar"/);
    expect(HTML.indexOf('id="batch-bar"'), 'полоса должна стоять ДО тела сайдбара')
      .toBeLessThan(HTML.indexOf('<div class="outliner-body">'));
  });

  it('полоса держится на месте тем же способом, что «Метаданные» и «Проверка»', () => {
    const css = read('ui/style.css');
    const block = css.slice(css.indexOf('.batch-bar {'));
    expect(block.slice(0, block.indexOf('}'))).toMatch(/flex-shrink: 0;/);
  });

  it('крестик «удалить отмеченные» стоит в колонке крестиков моделей', () => {
    expect(HTML).toMatch(/id="batch-remove"[^>]*class="[^"]*\bmodel-remove\b/);
  });

  it('крестик пачки виден ВСЕГДА, и правило стоит после .model-remove', () => {
    const css = read('ui/style.css');
    expect(css.indexOf('.batch-remove { opacity: 1; }'),
      'правило крестика пачки снова стоит до .model-remove — он станет невидимым')
      .toBeGreaterThan(css.indexOf('.model-remove {'));
  });

  it('удаление пачки СПРАШИВАЕТ, и вопрос называет число', () => {
    const fn = block('batchRemoveBtn.addEventListener');
    expect(fn).toMatch(/showWindow\(confirmRemove\)/);
    expect(fn).toMatch(/batch\.remove\.text', \{ n \}/);
    expect(HTML).toMatch(/id="confirm-remove"/);
    for (const [имя, кат] of [['ru', RU], ['en', EN]]) {
      expect(кат, `в каталоге ${имя} нет текста вопроса`).toMatch(/'batch\.remove\.text'/);
    }
  });

  it('удаление идёт по СНИМКУ списка, а не по живому', () => {
    const fn = block('confirmRemoveYes.addEventListener');
    expect(fn).toMatch(/const doomed = pickedModels\(\)\.map/);
  });

  it('крестик гаснет, когда удалять нечего', () => {
    expect(APP).toMatch(/batchRemoveBtn\.disabled = n === 0/);
  });

  it('промежуточное положение показывается, а не округляется', () => {
    expect(APP).toMatch(/batchToggle\.indeterminate = n > 0 && n < models\.length/);
  });
});

describe('отбор отдельно, работа отдельно', () => {
  it('добавление модели не снимает чужих галочек', () => {
    expect(block('function addModel(file: File')).not.toMatch(/rec\.picked = false/);
  });

  it('сборка фильтрует отмеченное через needsBuild', () => {
    expect(block('async function runBatch(')).toMatch(/const list = picked\.filter\(needsBuild\)/);
  });

  it('список к сборке считается ДО первого переключения модели', () => {
    const batch = block('async function runBatch(');
    expect(batch.indexOf('picked.filter(needsBuild)'))
      .toBeLessThan(batch.indexOf('selectModel('));
  });

  it('пропуск не молчит', () => {
    expect(block('async function runBatch(')).toMatch(/log\.batchAlreadyBuilt/);
    expect(RU).toMatch(/'log\.batchAlreadyBuilt'/);
    expect(EN).toMatch(/'log\.batchAlreadyBuilt'/);
  });

  it('флажки принадлежат человеку — при показе модели их не переставляют', () => {
    const fn = block('function applyDetection(');
    expect(fn).toMatch(/else if \(selection\) restoreSelection\(selection\)/);
    expect(fn).toMatch(/else \{ seedSelection\(\); selection = currentSelection\(\); \}/);
  });

  it('расстановка флажков зовётся ровно из одного места', () => {
    const calls = [...APP.matchAll(/(?<!function )seedSelection\(\)/g)];
    expect(calls.length, 'seedSelection зовётся не один раз — кто-то решает за человека')
      .toBe(1);
  });

  it('режима «Советуем / Мой выбор» и памяти выбора по площадкам больше нет', () => {
    expect(APP).not.toMatch(/adviceMode|savedSelections\[/);
    expect(HTML).not.toMatch(/advice-mode/);
    for (const [имя, кат] of [['ru', RU], ['en', EN]]) {
      expect(кат, `в каталоге ${имя} остались строки снятого переключателя`)
        .not.toMatch(/menu\.settings\.(advise|manual|priority)|log\.adviceMode/);
    }
  });

  it('кодек ПЛОЩАДКИ главнее того, что лежит в модели', () => {
    const fn = block('function seedSelection()');
    expect(fn).toMatch(/const codec = platformCodec\(\)/);
    expect(fn).toMatch(/!codec && lastDetection\.draco/);
    expect(fn).toMatch(/!codec && lastDetection\.meshopt/);
  });

  it('ПРОЧЕРК не назначает кодек — у него нет голоса', () => {
    const fn = block('function platformCodec()');
    expect(fn).toMatch(/if \(!platformSelect\.value\) return null;/);
  });

  it('выбор площадки применяет её кодек, а не откладывает до следующей модели', () => {
    expect(APP).toMatch(/await loadExtensions\(platformSelect\.value\);\s+applyPlatformChoice\(\);/);
  });

  it('кодек площадки доезжает до интерфейса от сервера', () => {
    expect(SERVER).toMatch(/defaults: \{ texMode: advisedTexMode, codec: advisedCodec \}/);
  });

  it('готовность меряется ОДНОЙ мерой — подписью настроек', () => {
    const fn = block('function needsBuild(');
    expect(fn).toMatch(/signature !== currentSettingsSignature\(\)/);
    expect(fn, 'счётчик нажатий и отпечаток сюда возвращать нельзя')
      .not.toMatch(/settingsRevision|builtRevision|builtStamp|settingsStamp/);
  });

  it('отмечена одна модель — собирается ОНА, а не та, что на экране', () => {
    const fn = block('async function onRunClick()');
    expect(fn).toMatch(/picked\.length === 1 && picked\[0\]!\.id !== activeModelId/);
  });

  it('упавшая сборка не показывает «собрана»', () => {
    expect(APP).toMatch(/const built = !!result && result\.status !== 'fail'/);
  });
  it('число на кнопке — сколько СОБЕРЁТСЯ, а не сколько отмечено', () => {
    const fn = block('function updateRunButtonState()');
    expect(fn).toMatch(/const todo = modelsToBuild\(\)\.length/);
    expect(fn).toMatch(/btn\.buildPicked', \{ n: todo \}/);
  });

  it('когда собирать нечего — кнопка гаснет с причиной, а не молча', () => {
    const fn = block('function updateRunButtonState()');
    expect(fn).toMatch(/if \(!todo\)[\s\S]{0,500}?btn\.changeSetting/);
  });
});



describe('скрытая подчинённая строка ничего не просит', () => {
  it('просьба про развёртку выводится из ВИДИМОСТИ строки, а не из одной галочки', () => {
    const тело = block('const keepingUnusedUv = () => {');
    expect(тело, 'keepingUnusedUv перестал смотреть, видна ли строка — скрытая галочка снова просит')
      .toMatch(/hidden/);
  });

  it('видимость строки решает ЧИСТКА В ЦЕЛОМ, а не один флажок safe', () => {
    const тело = block('function toggleUvSubRow() {');
    expect(тело, 'видимость снова решается на месте, мимо общего условия')
      .toMatch(/чисткаБудет/);

    const условие = block('function чисткаБудет(): boolean {');
    for (const признак of ['ext-safe', 'ext-join', 'geometryChoice']) {
      expect(условие, `условие видимости забыло про ${признак} — строка спрячется там, где чистка идёт`)
        .toContain(признак);
    }
  });

  it('видимость пересчитывается на ЛЮБОЙ смене опции', () => {
    expect(block('function onOptionChanged() {'), 'onOptionChanged перестал пересчитывать строку развёртки')
      .toMatch(/toggleUvSubRow\(\)/);
  });
});



describe('способы показа названы в одном месте', () => {
  const изКонтракта = () => {
    const m = /export const DISPLAY_MODES = \[([^\]]*)\] as const;/.exec(CONTRACT);
    expect(m, 'в contract.ts не найден DISPLAY_MODES — источник списка переехал или переименован')
      .toBeTruthy();
    return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
  };

  it('contract.ts объявляет список, а тип выводится из него', () => {
    expect(CONTRACT, 'тип DisplayMode перестал выводиться из списка')
      .toMatch(/export type DisplayMode = \(typeof DISPLAY_MODES\)\[number\];/);
  });

  it('никто, кроме contract.ts и globals.d.ts, не выписывает список руками', () => {
    for (const [имя, код] of [['ui/viewer/viewer.ts', read('ui/viewer/viewer.ts')], ['ui/viewer/index.ts', read('ui/viewer/index.ts')]]) {
      expect(
        /\['wire',\s*'clay',\s*'file'\]|'clay'\s*\|\|\s*mode === 'wire'/.test(код),
        `${имя} снова выписывает список способов показа руками — ввозить DISPLAY_MODES из contract.ts`,
      ).toBe(false);
    }
  });

  it('намеренная копия в globals.d.ts перечисляет ровно те же значения', () => {
    const m = /setDisplayMaterial\(mode: ([^)]*)\): void;/.exec(GLOBALS);
    expect(m, 'в globals.d.ts не найдено объявление setDisplayMaterial').toBeTruthy();
    const там = m[1].split('|').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).sort();
    expect(там, 'globals.d.ts разошёлся с contract.ts — добавили способ показа и забыли это место')
      .toEqual(изКонтракта());
  });
});
