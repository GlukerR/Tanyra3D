import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CATALOG_DIRS = ['messages', 'core/messages', 'addons/gltf/messages'];

describe('1. перечня языков в коде нет', () => {
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
    for (const d of CATALOG_DIRS) {
      const dst = path.join(ROOT, d, 'de.mjs');
      fs.copyFileSync(path.join(ROOT, d, 'ru.mjs'), dst);
      added.push(dst);
    }
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
    const { listLanguages } = await import('../assistant.mjs');
    expect(listLanguages()).toContain('en');
    expect(listLanguages()).toContain('ru');
  });

  it('файл не по форме «<код>.mjs» каталогом не считается', () => {
    for (const d of CATALOG_DIRS) {
      const names = fs.readdirSync(path.join(ROOT, d));
      const looksLikeLocale = names.filter((n) => /^[a-z]{2}(-[a-z]{2})?\.mjs$/i.test(n));
      expect(looksLikeLocale.length, `${d}: не осталось ни одного каталога`).toBeGreaterThan(0);
      expect(looksLikeLocale, `${d}: описание типов принято за язык`)
        .not.toContain('en.d.mts');
    }
  });
});
