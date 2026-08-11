// tests/helpers/source-files.mjs — путь к ИСХОДНИКУ модуля, а не к собранному следу.
//
// Зачем понадобилось. Часть тестов читает код как ТЕКСТ: сторож GAP-005 разбирает список
// baseline-метрик, `path-from-url` ищет возврат старого приёма, `engine-contract` собирает
// ключи сообщений, `electron-config` проверяет, что сервер спрашивает переменные окружения.
// Все они писали имя файла с расширением `.mjs`.
//
// С переходом на TypeScript (2026-08-10, ядро; 2026-08-11, аддон и верхний слой) у части
// модулей источник — `.mts`, а `.mjs` рядом кладёт компилятор. Читать собранное в таких
// тестах неверно сразу по двум причинам:
//
//   1. На чистом клоне до `npm run build` его просто НЕТ — тест падает с ENOENT на пустом
//      месте. Дважды за один день так и вышло (gap-005 в pre-commit, engine-contract в
//      прогоне), пока это не начали делать через общий помощник.
//   2. Сторож должен стеречь то, что человек правит руками. Собранный файл никто не
//      правит; если он разойдётся с источником, виноват не он.
//
// Помощник заведён по Правилу 6 после ПЯТОГО повторения одного и того же исправления.
// Список расширений и порядок предпочтения живут здесь, а не в каждом тесте.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Расширения источника в порядке предпочтения: сначала TypeScript, потом JavaScript. */
// `.ts` — браузерный слой (ui/): у него своя сборка, но правило то же.
const SOURCE_EXTENSIONS = ['.mts', '.ts', '.mjs', '.js', '.cjs'];

/**
 * Абсолютный путь к исходнику модуля по имени БЕЗ расширения.
 *
 * `sourcePath('core/engine')` → `…/core/engine.mts`, пока модуль на TypeScript, и
 * `…/core/engine.mjs`, если его вернут на JavaScript. Тест от этого не зависит.
 *
 * Имя с расширением тоже принимается — оно отбрасывается: так проще переводить
 * существующие списки, не переписывая их поэлементно.
 */
export function sourcePath(moduleName) {
  const base = String(moduleName).replace(/\.(mts|mjs|cjs|js)$/i, '');
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = path.join(ROOT, `${base}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Ни одного файла — это ошибка теста, а не отсутствие возможности. Молчать нельзя:
  // тест, читающий несуществующий путь, упадёт ниже с невнятным ENOENT.
  throw new Error(
    `sourcePath: не найден исходник "${base}" (искали ${SOURCE_EXTENSIONS.join(', ')} в корне проекта)`,
  );
}

/** Текст исходника. Обёртка ради читаемости: два вызова из трёх выглядят именно так. */
export function readSource(moduleName) {
  return fs.readFileSync(sourcePath(moduleName), 'utf8');
}
