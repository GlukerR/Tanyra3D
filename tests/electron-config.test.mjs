// tests/electron-config.test.mjs — сторож настройки сборки приложения.
//
// Введён 2026-08-09, после ДВУХ одинаковых поломок подряд. Оба раза сборка падала не
// на упаковке, а на проверке схемы — то есть разом на всех четырёх платформах, ещё до
// первого скопированного файла:
//
//   1. `desktopName` положен в build.linux. Такого ключа там нет: он живёт в корне
//      package.json, а в секции linux — только парный ему syncDesktopName.
//   2. Пояснение `_comment_mac_targets` положено внутрь build. Корень package.json
//      чужие ключи терпит (npm их игнорирует), объект build — нет.
//
// Цена ошибки несоразмерна: строка в JSON против прогона на четырёх машинах, который
// выясняется через пять минут ожидания. А заметить её глазами нельзя — обе выглядят
// совершенно естественно рядом с соседними строками.
//
// Проверяется не «работает ли сборка» (для этого нужны четыре платформы), а ровно то,
// что ломалось: состав ключей. Схему берём ту же, по которой судит сам electron-builder,
// из его пакета — значит сторож не разойдётся с ним при обновлении.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const SCHEME = path.join(ROOT, 'node_modules', 'app-builder-lib', 'scheme.json');
const scheme = fs.existsSync(SCHEME) ? JSON.parse(fs.readFileSync(SCHEME, 'utf8')) : null;

/** Допустимые ключи секции по её описанию в схеме electron-builder. */
function allowedKeys(defName) {
  const def = scheme && scheme.definitions && scheme.definitions[defName];
  if (!def) return null;
  const out = new Set(Object.keys(def.properties || {}));
  for (const branch of def.allOf || def.anyOf || []) {
    const ref = branch.$ref && branch.$ref.split('/').pop();
    const target = ref && scheme.definitions[ref];
    for (const k of Object.keys((target && target.properties) || branch.properties || {})) out.add(k);
  }
  return out.size ? out : null;
}

describe('Настройка сборки приложения', () => {
  it('внутри build нет посторонних ключей — комментарии живут в корне', () => {
    const strays = Object.keys(pkg.build || {}).filter((k) => k.startsWith('_'));
    expect(strays, `в build попали ключи-комментарии: ${strays.join(', ')}. `
      + 'Корень package.json их терпит, объект build — нет: сборка падает на проверке схемы.')
      .toEqual([]);
  });

  it('ключи build.linux, build.win и build.mac существуют в схеме electron-builder', () => {
    if (!scheme) return; // пакет не установлен (голый клон без devDependencies)
    const sections = [
      ['linux', 'LinuxConfiguration'],
      ['win', 'WindowsConfiguration'],
      ['mac', 'MacConfiguration'],
    ];
    const unknown = [];
    for (const [key, defName] of sections) {
      const section = (pkg.build || {})[key];
      const allowed = allowedKeys(defName);
      if (!section || !allowed) continue;
      for (const k of Object.keys(section)) {
        if (!allowed.has(k)) unknown.push(`build.${key}.${k}`);
      }
    }
    expect(unknown, `таких ключей у electron-builder нет: ${unknown.join(', ')}. `
      + 'Проверьте, не корневое ли это поле package.json (как desktopName).')
      .toEqual([]);
  });

  it('оболочка и иконка на месте — без них собирать нечего', () => {
    expect(pkg.main, 'package.json.main должен указывать на оболочку').toBe('desktop/main.cjs');
    for (const rel of ['desktop/main.cjs', 'desktop/build/icon.png']) {
      expect(fs.existsSync(path.join(ROOT, rel)), `нет ${rel}`).toBe(true);
    }
  });

  it('у пакета .deb есть сопровождающий с почтой — иначе он не соберётся', () => {
    const who = pkg.build?.linux?.maintainer || pkg.author;
    expect(who, 'ни build.linux.maintainer, ни author не заданы').toBeTruthy();
    expect(String(who), `«${who}» — Debian требует адрес в угловых скобках`).toMatch(/<[^@\s]+@[^>\s]+>/);
  });

  // 2026-08-09. Александр скачал установщик 0.0.10 и обнаружил, что модель
  // загружается, а вьюпорта нет ни одного. Причина: electron-builder по
  // умолчанию выбрасывает из зависимостей папки с именем examples, считая их
  // документацией. У three в examples/jsm лежит не документация, а рабочий код
  // вьюера — GLTFLoader, OrbitControls, RoomEnvironment, декодеры Draco и KTX2.
  //
  // Поймать это тестами было нечем: браузерные тесты гоняют вьюер из исходного
  // дерева, где папка на месте, а проверка упакованной сборки ограничивалась
  // тем, что она поднимается и считает метрики. Рендер не открывали.
  //
  // Сторож сверяет ДВЕ вещи: путь, который вьюер просит по HTTP, существует в
  // node_modules — и он же попадает в пакет по той же раскладке. Добавят импорт
  // из ещё одной выбрасываемой папки — тест назовёт её.
  describe('файлы вьюера доезжают до пакета', () => {
    // Имена папок, которые electron-builder вырезает из node_modules сам.
    const STRIPPED = /(^|\/)(example|examples|test|tests|__tests__|powered-test|doc|docs)(\/|$)/;

    /** Пути под /vendor/three/, которые упоминает код вьюера и разметка. */
    const vendorRefs = () => {
      const sources = ['ui/index.html', 'ui/viewer/viewer.js'];
      const refs = new Set();
      for (const rel of sources) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        for (const m of src.matchAll(/\/vendor\/three\/([A-Za-z0-9_./-]*)/g)) {
          if (m[1]) refs.add(m[1].replace(/\/$/, ''));
        }
      }
      return [...refs];
    };

    /**
     * Кладёт ли extraResources этот путь в пакет ПО ТОМУ ЖЕ адресу.
     * Раскладка обязана совпасть с исходным деревом: server.mjs ищет three
     * рядом с собой, и никакой особой ветки для собранного пакета в нём нет.
     */
    const copiedByExtraResources = (rel) =>
      (pkg.build?.extraResources || []).some((e) => {
        if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') return false;
        const from = e.from.replace(/\\/g, '/');
        if (rel !== from && !rel.startsWith(from + '/')) return false;
        return e.to.replace(/\\/g, '/') + rel.slice(from.length) === 'app/' + rel;
      });

    it('каждый путь из /vendor/three/ существует в node_modules', () => {
      const refs = vendorRefs();
      expect(refs.length, 'в ui/ не нашлось ни одной ссылки на /vendor/three/ — тест устарел').toBeGreaterThan(0);
      const missing = refs.filter((r) => !fs.existsSync(path.join(ROOT, 'node_modules', 'three', r)));
      expect(missing, `нет в node_modules/three: ${missing.join(', ')}`).toEqual([]);
    });

    it('пути из выбрасываемых папок возвращены через extraResources', () => {
      const unpackaged = vendorRefs()
        .filter((r) => STRIPPED.test(r))
        .filter((r) => !copiedByExtraResources('node_modules/three/' + r));
      expect(
        unpackaged,
        `electron-builder вырежет это из пакета, а вьюер без них не запустится: ${unpackaged.join(', ')}. `
          + 'Добавить в build.extraResources копию с адресом «app/<тот же путь>» — в files добавлять бесполезно, '
          + 'правило-умолчание выбрасывает саму папку, и обход внутрь неё не заходит.',
      ).toEqual([]);
    });
  });
});
