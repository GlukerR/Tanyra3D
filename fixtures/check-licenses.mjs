#!/usr/bin/env node
// fixtures/check-licenses.mjs
// Проверка встроенных лицензий у моделей golden-корпуса.
//
// Повторяющаяся проверка «есть ли внутри модели лицензия» вынесена в скрипт, чтобы
// для каждой новой модели корпуса не делать это вручную. Живёт рядом с корпусом
// (а не в gitignored _work/), чтобы переживать сессии.
//
// Что делает:
//   1. Сканирует fixtures/models/ (рекурсивно) на *.glb и *.gltf.
//   2. Достаёт встроенную лицензию/атрибуцию: asset.copyright, asset.generator,
//      asset.extras.{author,license,source,title} и top-level extras.
//   3. Рядом с каждой моделью создаёт sidecar <имя>.license.md, ЕСЛИ его ещё нет
//      (не затирает то, что заполнено вручную).
//   4. Печатает сводку: у кого лицензия найдена, у кого нет (нужна ручная атрибуция).
//
// Запуск:  node fixtures/check-licenses.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(HERE, 'models');

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

// Достать JSON-чанк из GLB-контейнера (первый чанк, тип JSON).
function parseGlbJson(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) return null;
  const chunkLen = buf.readUInt32LE(12);
  const chunkType = buf.readUInt32LE(16);
  if (chunkType !== CHUNK_JSON) return null;
  return JSON.parse(buf.slice(20, 20 + chunkLen).toString('utf8'));
}

function parseModel(file) {
  const buf = readFileSync(file);
  if (extname(file).toLowerCase() === '.glb') return parseGlbJson(buf);
  return JSON.parse(buf.toString('utf8')); // .gltf — JSON напрямую
}

// Собрать всё, что похоже на лицензию/атрибуцию, из glTF JSON.
// Sketchfab и др. кладут это в asset.extras (author/license/source/title); стандартное
// поле — asset.copyright. Проверяем оба + top-level extras.
function extractLicense(json) {
  const a = (json && json.asset) || {};
  const sources = [a.extras || {}, json.extras || {}];
  const pick = (...keys) => {
    for (const src of sources) {
      for (const k of keys) {
        const v = src && src[k];
        if (v != null && String(v).trim() !== '') return String(v).trim();
      }
    }
    return '';
  };
  return {
    copyright: (a.copyright || '').trim(),
    generator: (a.generator || '').trim(),
    author: pick('author', 'authors', 'creator'),
    license: pick('license', 'licence', 'rights'),
    source: pick('source', 'sourceUrl', 'url', 'link'),
    title: pick('title', 'name'),
  };
}

function hasAny(lic) {
  return !!(lic.copyright || lic.author || lic.license || lic.source || lic.title);
}

function sidecarPath(modelFile) {
  return join(dirname(modelFile), `${basename(modelFile, extname(modelFile))}.license.md`);
}

function renderSidecar(modelFile, lic) {
  const name = basename(modelFile);
  const today = new Date().toISOString().slice(0, 10);
  const field = (v) => (v ? v : '_(не найдено — заполнить вручную)_');
  return `# Лицензия: ${name}

> Sidecar-файл лицензии модели golden-корпуса. Часть полей извлечена автоматически из
> встроенных метаданных glTF (\`fixtures/check-licenses.mjs\`), остальные — заполнить вручную.
> Проверено: ${today}.

- **Файл модели:** ${name}
- **Название (title):** ${field(lic.title)}
- **Автор:** ${field(lic.author)}
- **Лицензия:** ${field(lic.license)}
- **Copyright (asset.copyright):** ${field(lic.copyright)}
- **Источник / URL:** ${field(lic.source)}
- **Generator:** ${field(lic.generator)}

## Заполнить вручную

- **Можно ли распространять (redistributable)?** _(да / нет — от этого зависит, коммитить ли сам бинарник)_
- **Требуется атрибуция?** _(да / нет; если да — как именно)_
- **Ссылка на страницу модели/лицензии:** _()_
- **Примечания:** _()_
`;
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else {
      const e = extname(p).toLowerCase();
      if (e === '.glb' || e === '.gltf') out.push(p);
    }
  }
  return out;
}

function main() {
  const models = walk(MODELS_DIR);
  if (!models.length) {
    console.log('Моделей в fixtures/models/ пока нет. Положи модели и запусти снова.');
    return;
  }
  let withLicense = 0, without = 0, created = 0, skipped = 0;
  for (const file of models) {
    let lic;
    try {
      lic = extractLicense(parseModel(file) || {});
    } catch (e) {
      console.log(`[ОШИБКА] ${basename(file)} — не разобрать: ${e.message}`);
      continue;
    }
    const found = hasAny(lic);
    found ? withLicense++ : without++;
    const sc = sidecarPath(file);
    if (existsSync(sc)) {
      skipped++;
      console.log(`[есть sidecar] ${basename(file)} — ${found ? 'лицензия найдена' : 'лицензия НЕ найдена в модели'}`);
    } else {
      writeFileSync(sc, renderSidecar(file, lic), 'utf8');
      created++;
      console.log(`[создан ${basename(sc)}] ${basename(file)} — ${found ? 'лицензия найдена' : 'ЛИЦЕНЗИЯ НЕ НАЙДЕНА → заполнить вручную'}`);
    }
  }
  console.log(`\nИтог: моделей ${models.length}; с лицензией ${withLicense}, без ${without}; sidecar создано ${created}, пропущено ${skipped}.`);
  if (without) console.log('⚠ Для моделей без встроенной лицензии заполни sidecar вручную (автор / источник / можно ли распространять).');
}

main();
