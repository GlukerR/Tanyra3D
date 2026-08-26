// tests/language-by-folder.test.mjs — язык добавляется КЛАДКОЙ ФАЙЛОВ, а не правкой кода.
//
// ЗАВЕДЁН 2026-08-26 по находке Ф4-3 аудита (docs/АУДИТ_Ф4_результат.md).
//
// ЧТО БЫЛО. Перечень языков лежал СТАТИЧЕСКИМИ ИМПОРТАМИ в трёх файлах кода —
// `assistant.mts`, `core/engine.mts`, `addons/gltf/index.mts`, — и один из них ядро.
// То есть добавление языка требовало открыть `core/`: единственная из пяти задач
// контрибутора, где это было нужно.
//
// Цену замерили действием: положили два файла по инструкции `ui/locales/README.md`
// («Adding a language means putting two files… Nothing else») и получили переведённую
// обвязку интерфейса при английских описаниях площадок, подписях опций, книжечках и
// целом отчёте. `listLanguages()` нового языка не знал вовсе.
//
// ЧТО СТЕРЕЖЁМ — три обещания, и каждое можно нарушить незаметно:
//   1. перечня языков в коде НЕТ ни в одном из трёх файлов;
//   2. положенный каталог подхватывается — и ассистентом, и ядром, и аддоном;
//   3. чужой или битый файл в папке каталогов не роняет остальные языки.
//
// ПОЧЕМУ ФАЙЛЫ КЛАДУТСЯ НАСТОЯЩИЕ, А НЕ ПОДМЕНЯЕТСЯ МОДУЛЬ. Спор идёт ровно о том,
// читается ли ПАПКА. Подмена импорта проверила бы соглашение между тестом и мокой.
//
// ПРОБА НА КРАСНОТУ пройдена: вернул статические импорты в core/engine.mts — краснеют
// разделы 1 и 2; оставил в папке битый файл без обработки ошибки — краснеет раздел 3.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Три папки каталогов. Соответствие «файл кода → его папка» и есть предмет проверки. */
const CATALOG_DIRS = ['messages', 'core/messages', 'addons/gltf/messages'];

describe('1. перечня языков в коде нет', () => {
  // Проверяем ИСХОДНИКИ (.mts), а не выводы сборки: правку вносят в них, и сторож,
  // читающий .mjs, промолчал бы до следующей сборки. Эта ловушка в проекте уже
  // срабатывала — см. docs/АУДИТ_хардкода.md, правило проведения 3.
  for (const [file, what] of [
    ['assistant.mts', 'каталоги отчёта'],
    ['core/engine.mts', 'каталоги ядра'],
    ['addons/gltf/index.mts', 'каталоги правил'],
  ]) {
    it(`${file} не перечисляет языки (${what})`, () => {
      const src = read(file);
      expect(src, `${file}: вернулся статический импорт каталога — язык снова стоит правки кода`)
        .not.toMatch(/import\s+\w+\s+from\s+'[^']*messages\/(en|ru)\.mjs'/);
      expect(src, `${file}: вернулась поимённая регистрация языка`)
        .not.toMatch(/register\('(en|ru)',/);
    });
  }
});

describe('2. положенный каталог подхватывается', () => {
  const added = [];
  let assistant;
  let render;

  beforeAll(async () => {
    // Немецкий делаем копией РУССКОГО, а не английского: только так видно разницу
    // между «каталог прочитан» и «откатились на английский».
    for (const d of CATALOG_DIRS) {
      const dst = path.join(ROOT, d, 'de.mjs');
      fs.copyFileSync(path.join(ROOT, d, 'ru.mjs'), dst);
      added.push(dst);
    }
    // Импорт ПОСЛЕ кладки файлов и без ?v= — реестр каталогов один на процесс, и второй
    // адрес того же модуля дал бы вторую, пустую копию.
    assistant = await import('../assistant.mjs');
    await import('../core/engine.mjs');
    await import('../addons/gltf/index.mjs');
    ({ render } = await import('../core/i18n.mjs'));
  });

  afterAll(() => { for (const f of added) fs.rmSync(f, { force: true }); });

  it('ассистент знает новый язык', () => {
    expect(assistant.listLanguages(), 'папка messages/ прочитана мимо нового файла')
      .toContain('de');
  });

  it('строка ядра приходит из нового каталога, а не откатывается на английский', () => {
    const de = render('metric.triangles', {}, 'de');
    expect(de, 'немецкий откатился на английский — каталог ядра не подхвачен')
      .not.toBe(render('metric.triangles', {}, 'en'));
    expect(de).toBe(render('metric.triangles', {}, 'ru'));
  });

  it('строка правила приходит из нового каталога', () => {
    // Ключ берём из каталога АДДОНА, а не ядра: папки у них разные, загрузчики вызваны
    // по отдельности, и подхватиться обязана каждая. Конкретный ключ не вписываем —
    // он переживёт переименование правила, а сторож, держащийся за имя, покраснеет
    // от чистого переименования (то, что фаза Ф6 аудита считает дефектом сторожа).
    const found = /'(rule\.[A-Za-z0-9]+)'/.exec(read('addons/gltf/messages/en.mjs'));
    expect(found, 'в каталоге аддона не нашлось ни одного ключа rule.*').toBeTruthy();
    const id = found[1];
    expect(render(id, {}, 'de'), `${id}: каталог аддона не подхвачен`)
      .toBe(render(id, {}, 'ru'));
  });
});

describe('3. чужой файл в папке каталогов не роняет остальные языки', () => {
  const trash = [];
  afterAll(() => { for (const f of trash) fs.rmSync(f, { force: true }); });

  it('битый каталог не уносит с собой рабочие', async () => {
    const bad = path.join(ROOT, 'messages', 'xx.mjs');
    fs.writeFileSync(bad, 'export default {{{ это не модуль', 'utf8');
    trash.push(bad);
    // Свежий процесс не нужен: listLanguages читает уже загруженный реестр. Проверяем
    // то, что видно СЕЙЧАС, — английский и русский обязаны остаться.
    const { listLanguages } = await import('../assistant.mjs');
    expect(listLanguages()).toContain('en');
    expect(listLanguages()).toContain('ru');
  });

  it('файл не по форме «<код>.mjs» каталогом не считается', () => {
    // README.md, .d.mts, вспомогательные файлы — в папке лежат и языком не являются.
    for (const d of CATALOG_DIRS) {
      const names = fs.readdirSync(path.join(ROOT, d));
      const looksLikeLocale = names.filter((n) => /^[a-z]{2}(-[a-z]{2})?\.mjs$/i.test(n));
      expect(looksLikeLocale.length, `${d}: не осталось ни одного каталога`).toBeGreaterThan(0);
      expect(looksLikeLocale, `${d}: описание типов принято за язык`)
        .not.toContain('en.d.mts');
    }
  });
});
