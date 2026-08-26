// tests/helpers/model-files.mjs — общий REPO × LOCAL split для тестов.
//
// Контекст (задание 2026-07-29-корпус2, Работа 3):
//   `fixtures/.gitignore` блокирует коммит всех *.glb/*.gltf/*.bin/*.png/*.jpg/*.webp
//   — репозиторий публичный под Apache-2.0, у сторонних моделей своя лицензия.
//
// Исключения — собственные модели автора, перечисленные строками `!models/…` в том же
// файле. Их можно версионировать, потому что у них в sidecar-license.md явно сказано
// «Можно ли распространять: да». Числа здесь намеренно не названо: корпус растёт, а
// число в комментарии устаревает молча — так уже было со словом «пятнадцать».
//
// После `git clone` на диске есть только они. Остальные модели (Khronos-эталоны,
// CC-BY-4.0, клиентские) — у автора локально. Чтобы
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

// Что коммитится в git — ЧИТАЕТСЯ ИЗ `fixtures/.gitignore`, а не переписывается сюда.
//
// Там стоит общий запрет на бинарники моделей и явные исключения строками `!models/имя`.
// Это и есть решение о том, едет модель в публичный репозиторий или нет: у исключения
// в sidecar-лицензии обязано стоять «Можно ли распространять: да».
//
// РАНЬШЕ ЗДЕСЬ ЛЕЖАЛ ВТОРОЙ СПИСОК — рукописная копия того же факта. Он разошёлся с
// первым дважды и оба раза молча: `GLUKE Purple 01.glb` (2026-08-22) и
// `Skinned Morphs 01.glb` (2026-08-23) закоммитили, а сюда не вписали. Цена расхождения
// не косметическая: модель, которой тут нет, считается ЛОКАЛЬНОЙ, и всё, что на неё
// опирается, на CI graceful-пропускается. Вторая из них для того и заводилась, чтобы
// сторож скиннинга наконец гонялся на чистом клоне, — и не гонялся бы.
//
// Нашлось это не глазами, а мета-тестом покрытия классов: он объявил класс `skinned`
// без представителя в git, хотя представитель был закоммичен. Сторож на сам разбор —
// в tests/local-model-guard.test.mjs (пустой или куцый список = красное).
export const REPO_MODELS = new Set(
  fs.readFileSync(path.resolve(PROJECT_ROOT, 'fixtures/.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => /^!models\/(.+\.(?:glb|gltf))\s*$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => m[1]),
);

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
  const present = isPresent(modelName);
  return (present ? describe : describe.skip)(
    `${describeName} [model=${modelName} ${present ? 'present' : 'missing locally — skipped'}]`,
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
 * Одиночный тест про ОДНУ модель. Модели нет на диске — `it.skip` с причиной.
 * Для утверждений о конкретной модели внутри общего describe, где заводить
 * отдельный describeLocal не за что.
 *
 *   itIfModel('parkergirl.glb', 'скин и морфы вместе', () => { ... });
 */
export function itIfModel(modelName, label, body, timeout) {
  if (isPresent(modelName)) {
    it(`${modelName} — ${label}`, body, timeout);
  } else {
    it.skip(`${modelName} — ${label} [skipped: ${modelName} missing locally]`, () => {}, timeout);
  }
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
