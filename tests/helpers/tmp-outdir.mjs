// tests/helpers/tmp-outdir.mjs — временная папка прогона и уборка за собой.
//
// Задание 2026-08-15-тесты-не-мусорят-в-output (работа 1). Умолчание аддона —
// `outDir: 'output'` (addons/gltf/index.mts) — правильное для человека за командной
// строкой, но тесты обязаны писать во временную папку и убирать за собой.
//
// Образец — tmpOutDir() из tests/feature-combos.test.mjs; сюда он вынесен общим,
// потому что «одна и та же осторожность в десяти местах» — это ровно то, что
// разбирало ревью 2026-08-15. Каждый тестовый файл держит свой экземпляр модуля
// (vitest изолирует файлы), поэтому список created здесь — на файл, и
// afterAll(cleanupTmpOutDirs) убирает именно папки своего файла.
//
// Уникальность — fs.mkdtempSync, а не самодельный счётчик: тесты идут параллельно,
// и два прогона одной модели не должны писать в один файл. Модели бывают по
// 600 МБ — неубранный %TEMP% за месяц превращается в десятки гигабайт.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = [];

/** Новая уникальная временная папка на один прогон; убирается cleanupTmpOutDirs(). */
export function tmpOutDir(prefix = 'tests-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Удалить все папки, созданные tmpOutDir() в этом файле. Звать в afterAll. */
export function cleanupTmpOutDirs() {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // занят — подчистит ОС при следующей перезагрузке
    }
  }
}
