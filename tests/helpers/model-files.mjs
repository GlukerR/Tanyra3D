// tests/helpers/model-files.mjs — общий REPO × LOCAL split для тестов.
//
// Контекст (задание 2026-07-29-корпус2, Работа 3):
//   `fixtures/.gitignore` блокирует коммит всех *.glb/*.gltf/*.bin/*.png/*.jpg/*.webp
//   — репозиторий публичный под Apache-2.0, у сторонних моделей своя лицензия.
//
// Исключения — десять собственных моделей автора, перечисленных ниже. Их можно
// версионировать, потому что у них в sidecar-license.md явно сказано
// «Можно ли распространять: да». Суммарно ~1.1 МБ.
//
// После `git clone` на диске есть только эти десять. Остальные 23 модели
// (Khronos-эталоны, CC-BY-4.0 модели, клиентские) — у автора локально. Чтобы
// `npx vitest run` после свежего clone был зелёным, тесты, ссылающиеся на
// локальные модели, должны graceful-пропускаться, а не падать.
//
// API публичный для tests/ — внутри проекта ничего не нарушает: идёмпотентный
// helper вокруг fs, не импортирует внутренности продукта.
//
// ВАЖНО про vitest-глобалы: `describe`/`it`/`describe.skip`/`it.skip` доступны
// только в test-файлах как глобалы. Helper - это ОБЫЧНЫЙ ESM-модуль, в нём
// глобалов нет — ReferenceError. Поэтому явный импорт здесь.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.resolve(PROJECT_ROOT, 'fixtures/models');

export const REPO_MODELS = new Set([
  'Dirty Cube 01.glb',
  'Instance Grid 01.glb',
  'Morph Cube 01.glb',
  'Vertex Colors 01.glb',
  'Draco Compressed Input 01.glb',
  'Meshopt Compressed Input 01.glb',
  'Linked Duplicates Grid 01.glb',
  'Orphan Texture Cube 01.glb',
  'Preinstanced Grid 01.glb',
  'Truncated Broken 01.glb',
]);

export function modelPath(name) {
  return path.resolve(FIXTURES_DIR, name);
}

/** true, если модель либо коммитится в git, либо присутствует локально. */
export function isPresent(name) {
  return REPO_MODELS.has(name) || fs.existsSync(modelPath(name));
}

/**
 * describe-блок целиком опирается на ОДНУ локальную модель. Если её нет —
 * весь блок graceful-пропускается с понятным именем (видно в vitest-отчёте).
 *   describeLocal('parkergirl.glb', 'parkergirl — heavy morphs', () => { ... })
 */
export function describeLocal(modelName, describeName, fn) {
  return (isPresent(modelName) ? describe : describe.skip)(
    `${describeName} [model=${modelName} ${isPresent(modelName) ? 'present' : 'missing locally — skipped'}]`,
    fn,
  );
}

/**
 * describe-блок опирается на НЕСКОЛЬКО моделей. Пропускаем, если хотя бы
 * одной нет.
 */
export function describeIfModels(required, describeName, fn) {
  const allPresent = required.every(isPresent);
  const missing = required.filter((m) => !isPresent(m));
  const label = allPresent
    ? describeName
    : `${describeName} [skipped: ${missing.length ? missing.join(', ') : 'models missing'}]`;
  return (allPresent ? describe : describe.skip)(label, fn);
}

/**
 * Итератор для `it.each`-стиля. Для каждой модели из списка создаёт `it`,
 * если она присутствует, или `it.skip` с осмысленным маркером — иначе.
 *
 *   eachModel('passthrough returns status ok', GOLDEN_MODELS, async (m) => {...}, TIMEOUT);
 *
 * Не используем vitest it.skipIf: на массиве массивов он схлопывает имена
 * в репортере (см. tests/gap-005-regression.test.mjs). Явный цикл стабильнее.
 */
export function eachModel(prefix, models, body, timeout) {
  for (const m of models) {
    if (isPresent(m)) {
      it(`${m} — ${prefix}`, () => body(m), timeout);
    } else {
      it.skip(`${m} — ${prefix} [skipped: ${m} missing locally]`, () => {}, timeout);
    }
  }
}
