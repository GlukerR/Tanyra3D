// tests/helpers/input-folder.mjs — доступ к папке `input/` для тестов.
//
// `input/` в .gitignore: там реальные модели автора, включая клиентские работы,
// которые в публичный репозиторий не уходят никогда. После `git clone` этой
// папки НЕТ — ни у стороннего человека, ни на CI.
//
// До 2026-08-05 три файла (input-folder, draco, ktx2) читали папку напрямую и
// утверждали `expect(models.length).toBeGreaterThan(0)`. На машине автора это
// проходило, на чистом клоне давало 8 красных тестов — проверено клонированием
// в отдельную папку. Утверждение само по себе правильное (сторож против
// «тихого зелёного»), неправильно было место: оно должно защищать от пустой
// папки ТАМ, ГДЕ ПАПКА ЕСТЬ, а не требовать её наличия.
//
// Тот же договор, что и у model-files.mjs: нет материала — блок пропускается с
// причиной в названии, а не падает.
//
// ВАЖНО: helper — обычный ESM-модуль, глобалов vitest в нём нет, отсюда импорт.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export const INPUT_DIR = path.resolve(PROJECT_ROOT, 'input');

export const inputExists = fs.existsSync(INPUT_DIR);

/** Модели из `input/`, отсортированные. Пустой массив, если папки нет. */
export function inputModels({ limit = Infinity, ext = ['.glb', '.gltf'] } = {}) {
  if (!inputExists) return [];
  return fs
    .readdirSync(INPUT_DIR)
    .filter((f) => ext.some((e) => f.endsWith(e)))
    .sort()
    .slice(0, limit === Infinity ? undefined : limit);
}

/**
 * describe-блок, которому нужна папка `input/`. Папки нет — блок пропускается
 * с причиной, видимой в отчёте. Папка есть, но пуста — блок ВЫПОЛНЯЕТСЯ, и
 * сторож внутри него честно краснеет: пустая `input/` у автора это ошибка,
 * а не чистый клон.
 */
export function describeInput(describeName, fn) {
  return (inputExists ? describe : describe.skip)(
    inputExists ? describeName : `${describeName} [skipped: папки input/ нет — чистый клон]`,
    fn,
  );
}
