// tests/ui-source-badges.test.mjs — сторож правил интерфейса, введённых 2026-08-26.
//
// Правила и причины — docs/ПРАВИЛА_ИНТЕРФЕЙСА.md. Здесь только проверки, и каждая
// закрывает КЛАСС случаев, а не тот конкретный дефект, который её породил.
//
// ЧТО СТЕРЕЖЁМ.
//
//   1. Значок «В модели» — единственный ответ на вопрос «это уже в моём файле?».
//      Слова «уже / already / сейчас в модели» с экрана убраны: два ответа на один
//      вопрос расходились, и ни один не был полным (таблица в документе).
//
//   2. Таблица SOURCE_MARKERS ПОЛНА. Это главная проверка файла: именно неполнота
//      таблицы и была дефектом — WebP и квантование значка не получали вовсе.
//      Сторож сверяет её не со списком, переписанным сюда руками (такой список
//      устареет молча), а с ФАКТИЧЕСКИМ набором опций сжатия в движке.
//
//   3. Пары кнопок с противоположными действиями не возвращаются.
//
// ПРОБА НА КРАСНОТУ (обязательна, иначе файл — украшение): убрана строка `webp` из
// SOURCE_MARKERS → раздел 2 краснеет с именем `webp`; возвращено слово «Already in
// the model» в en.js → раздел 1 краснеет и называет файл и ключ.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const APP = read('ui/app.ts');
const HTML = read('ui/index.html');

describe('значок «В модели» — единственный ответ про исходный файл', () => {
  // Слово «уже» в подписи к экрану. Проверяем КАТАЛОГИ, а не код: по Правилу 8 весь
  // видимый текст живёт только там, значит там же его и ловить.
  //
  // Комментарии из проверки исключены намеренно: объяснять причину словом «уже» в
  // шапке модуля не запрещено и запрещать нечего — читатель кода и читатель экрана
  // разные люди.
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
    // Именные случаи (`if (lastDetection.draco) …`) и были причиной дыр: технологию
    // добавляли в движок и забывали здесь. Проход по таблице забыть невозможно.
    expect(APP).toMatch(/for \(const id of sourceTechnologies\(\)\) badgeOption\(id\)/);
  });

  it('снятая галочка значка не убирает', () => {
    // Значок отвечает на «что в файле». Пересчёт из onOptionChanged означал бы, что он
    // отвечает на «что выбрано», — и он бы мигал при каждом щелчке.
    const handler = APP.slice(APP.indexOf('function onOptionChanged()'));
    const body = handler.slice(0, handler.indexOf('\n  }'));
    expect(body).not.toMatch(/showDetectionBadges|sourceTechnologies/);
  });
});

describe('таблица SOURCE_MARKERS полна', () => {
  // Набор опций, для которых значок ОБЯЗАТЕЛЕН, выводится из движка: это те, чью
  // технологию он умеет и узнавать на входе, и предлагать галочкой. Список расширений
  // берём из правил аддона — там он и живёт.
  const marked = new Set(
    [...APP.slice(APP.indexOf('const SOURCE_MARKERS'), APP.indexOf('function sourceTechnologies'))
      .matchAll(/^\s{4}([a-z0-9-]+):\s*'([A-Z][A-Za-z0-9_]+)'/gm)].map((m) => m[1]),
  );

  // Опции сжатия и инстансинга — те, у которых вопрос «а это уже есть в файле?»
  // осмыслен. `safe`, `join`, `strip-colors` сюда не входят: они не технология,
  // которую можно «принести в файле», а работа, которую мы делаем.
  const MUST_BE_MARKED = ['meshopt', 'draco', 'quantize', 'ktx2', 'webp', 'instance'];

  it.each(MUST_BE_MARKED)('%s помечается значком «В модели»', (id) => {
    expect(marked.has(id),
      `опция ${id} не в SOURCE_MARKERS: человек с такой моделью значка не увидит`).toBe(true);
  });

  it('каждая помеченная опция и правда существует в движке', () => {
    // Обратная сторона: строка, оставшаяся от снятой опции, обещала бы значок там,
    // где опции нет. Ищем id среди фич движка.
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
    // Он обязан встать РОВНО над ними и выглядеть так же — иначе связь «это
    // выключатель вон тех» не читается, и правило теряет весь свой смысл.
    expect(HTML).toMatch(/id="batch-toggle"[^>]*class="[^"]*\bmodel-pick\b/);
  });

  it('промежуточное положение показывается, а не округляется', () => {
    // Отмечено не всё и не ничего — квадратик обязан сказать «часть». Без этого он
    // выглядел бы снятым при трёх отмеченных из пяти, то есть врал бы.
    expect(APP).toMatch(/batchToggle\.indeterminate = n > 0 && n < models\.length/);
  });
});

describe('галочка значит «предстоит собрать»', () => {
  it('собранные раньше выходят из выбора при добавлении новой модели', () => {
    const add = APP.slice(APP.indexOf('function addModel(file: File'));
    const body = add.slice(0, add.indexOf('\n  }'));
    expect(body).toMatch(/for \(const rec of models\) if \(rec\.state\.lastResult\) rec\.picked = false;/);
  });

  it('несобранные галочку сохраняют', () => {
    // Условие Александра — «если старые с флажками УЖЕ ВЫПОЛНЕНЫ были». Упавшая
    // модель и та, до которой не дошла очередь, из выбора не выходят: им сборка
    // всё ещё предстоит. Сторож на то, что условие не выродилось в «снять всё».
    const add = APP.slice(APP.indexOf('function addModel(file: File'));
    const body = add.slice(0, add.indexOf('\n  }'));
    expect(body).not.toMatch(/for \(const rec of models\) rec\.picked = false;/);
  });
});
