// tests/helpers/model-files.mjs — общий REPO × LOCAL split для тестов.
//
// Контекст (задание 2026-07-29-корпус2, Работа 3):
//   `fixtures/.gitignore` блокирует коммит всех *.glb/*.gltf/*.bin/*.png/*.jpg/*.webp
//   — репозиторий публичный под Apache-2.0, у сторонних моделей своя лицензия.
//
// Исключения — пятнадцать собственных моделей автора, перечисленных ниже. Их можно
// версионировать, потому что у них в sidecar-license.md явно сказано
// «Можно ли распространять: да». Суммарно ~1.1 МБ.
//
// После `git clone` на диске есть только эти пятнадцать. Остальные 26 моделей
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
  'Unlinked Duplicates 01.glb',
  // Закрытие дыр реестра ситуаций, 2026-08-04: у классов no-geometry,
  // textures-only, multi-scene и pre-ktx2 не было ни одного представителя,
  // и обещания движка для них не проверял никто. Первый же прогон нашёл два
  // дефекта — см. sidecar-лицензии рядом.
  'Empty Nodes 01.glb',
  'Texture Only 01.glb',
  'Two Scenes 01.glb',
  'Pre KTX2 01.glb',
  // Расширения, которых библиотека не знает (2026-08-14, _work/make-unknown-ext-fixtures.mjs).
  // Такие модели были представлены в корпусе только образцами Khronos, а они в git не
  // едут — на чистом клоне и на CI защита от их порчи не проверялась ВООБЩЕ.
  'Unknown Ext LOD 01.glb',
  'Unknown Ext Interactivity 01.glb',
  'Unknown Ext Pointer 01.glb',
  // Анимация по указателю, которая действительно проигрывается (2026-08-14,
  // _work/make-animation-pointer-fixture.mjs). Три модели выше только ОБЪЯВЛЯЮТ
  // расширение — на них нельзя проверить показ. Класс `animated` до этой модели
  // держался на чужих файлах и на CI не проверялся вообще.
  'Animated Pointer 01.glb',
  // Две дыры, найденные фальсификацией 2026-08-15 (_work/make-viewer-gap-fixtures.mjs).
  // Обе одного рода: код был верный, тесты его проверяли, но НИ ОДНА модель корпуса не
  // отличала верный код от подменённого. Ортографических камер в корпусе не было вовсе;
  // форм, которых анимация не касается, — тоже (у Morph Cube 01 клипов нет ВООБЩЕ).
  'Ortho Camera 01.glb',
  'Still Morphs 01.glb',
  // Третья — уже с CI: коммитимой модели с АНИМИРОВАННЫМИ формами не было ни одной,
  // и на чистом клоне вторая половина правила scene/morph-targets не выполнялась.
  'Animated Morphs 01.glb',
  'Two UV Islands 01.glb',
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
