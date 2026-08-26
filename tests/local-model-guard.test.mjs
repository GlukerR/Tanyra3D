// tests/local-model-guard.test.mjs — сторож от повторения истории 2026-08-18
//
// В git лежат не все модели корпуса: клиентские и чужие (Khronos, Sketchfab) в публичный
// репозиторий не идут — список того, что коммитится, в REPO_MODELS. Тест, который читает
// ЛОКАЛЬНУЮ модель без обёртки, на машине разработчика зелёный, а на CI падает с ENOENT.
//
// Ровно это и случилось. Раздел «WebP — ползунок качества считается от исходника» писался
// 2026-08-17 с голым `describe`, тогда как все соседние блоки в том же файле обёрнуты в
// `describeIfModels`. На машине разработчика он был зелёным сутки; на CI при первом же
// прогоне дал СЕМЬ красных на трёх версиях Node — BoomBox.glb, ABeautifulGame.glb и
// Production Many Materials 01.glb там просто нет.
//
// Сторож `global-setup-model-guard` эту беду не ловит: он смотрит только файлы
// globalSetup. Этот смотрит тела тестов.
//
// ЧТО ИМЕННО ПРОВЕРЯЕТСЯ: каждое обращение `modelPath('имя.glb')` с ЛИТЕРАЛЬНЫМ именем
// локальной модели обязано стоять внутри блока, который эту модель назвал —
// `itIfModel('имя', …)`, `describeLocal('имя', …)`, `describeIfModels(['имя', …], …)`
// или `eachModel(…)` — все четыре обёртки из tests/helpers/model-files.mjs.
//
// Чего сторож НЕ ловит, и это честно: имя, собранное в переменной
// (`const m = 'Boom' + 'Box.glb'`), и обращения через собственные помощники файла, если
// имя приходит туда параметром. Такие места ловятся только прогоном на чистом клоне.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { REPO_MODELS, modelPath } from './helpers/model-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = new Set(REPO_MODELS);

/** Имена моделей, названные в обёртке на этой строке. */
function guardedNames(line) {
  const one = line.match(/(?:itIfModel|describeLocal)\(\s*'([^']+)'/);
  if (one) return [one[1]];
  const many = line.match(/describeIfModels\(\s*\[([^\]]*)\]/);
  if (many) return [...many[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // Список моделей переменной (describeIfModels(THREE_LOCAL, …)) — обёртка есть, состав
  // статически не виден. Считаем закрытым: автор её поставил, а разбирать значение
  // идентификатора здесь нечем и незачем.
  if (/describeIfModels\(\s*[A-Za-z_$]/.test(line)) return ['*'];
  if (/eachModel\s*\(/.test(line)) return ['*']; // сам перебирает то, что есть на диске
  return null;
}

/** Незакрытые обращения к локальным моделям в одном файле. */
function unguarded(file) {
  const lines = fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n');
  const stack = []; // { depth, names }
  const bad = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('//')) { continue; }

    const names = guardedNames(line);
    const opensBlock = names !== null || /\b(describe|it)\s*\(/.test(line);

    for (const m of line.matchAll(/modelPath\(\s*'([^']+)'/g)) {
      const model = m[1];
      if (repo.has(model)) continue; // лежит в git — на CI будет
      // Намеренно отсутствующий файл: им проверяют обработку ошибки, а не читают модель.
      if (model === 'does_not_exist.glb') continue;
      // Верхний уровень модуля — это КОНСТАНТА ПУТИ (const MODEL = modelPath('X')), а не
      // чтение. Файл откроют внутри теста, и там обёртка уже проверяется.
      if (!stack.length) continue;
      const закрыт = stack.some((f) => f.names.includes('*') || f.names.includes(model))
        || (names || []).includes(model) || (names || []).includes('*');
      if (!закрыт) bad.push(`${file}:${i + 1} → ${model}`);
    }

    const before = depth;
    depth += (line.match(/[{(]/g) || []).length - (line.match(/[})]/g) || []).length;
    if (opensBlock && depth > before) stack.push({ depth: before, names: names || [] });
    while (stack.length && depth <= stack[stack.length - 1].depth) stack.pop();
  }
  return bad;
}

describe('локальные модели в тестах закрыты обёрткой (сторож CI)', () => {
  // Себя исключаем: внутри лежит зонд с заведомо отсутствующей моделью.
  const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.mjs') && f !== 'local-model-guard.test.mjs');

  it('файлы тестов вообще нашлись — иначе сторож проверяет пустоту', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('ни одно обращение к локальной модели не стоит без обёртки', () => {
    const bad = files.flatMap(unguarded);
    expect(
      bad,
      'эти обращения читают модель, которой НЕТ в git, и на CI упадут с ENOENT:\n'
        + bad.join('\n')
        + '\n\nЗакрыть обёрткой: itIfModel(\'имя.glb\', …) для одного теста или '
        + 'describeIfModels([\'имя.glb\'], …) для блока.',
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // Сам список REPO_MODELS. Весь сторож выше стоит на нём: модель, которой в списке
  // нет, считается ЛОКАЛЬНОЙ, и всё, что на неё опирается, на CI молча пропускается.
  //
  // Раньше список был рукописным и разошёлся с `fixtures/.gitignore` ДВАЖДЫ —
  // `GLUKE Purple 01.glb` и `Skinned Morphs 01.glb` закоммитили, а вписать забыли.
  // Вторая заводилась ровно затем, чтобы сторож скиннинга гонялся на чистом клоне,
  // и из-за расхождения не гонялся бы. Теперь список ЧИТАЕТСЯ из `.gitignore`, а эти
  // три проверки стерегут сам разбор: сломается он — молча получим пустой набор,
  // и «ни одно обращение не без обёртки» станет зелёным на пустоте.
  // ------------------------------------------------------------------
  it('список коммитимых моделей разобран, а не пуст', () => {
    expect(REPO_MODELS.size).toBeGreaterThan(20);
  });

  it('в списке ровно то, что лежит в fixtures/models на диске', () => {
    // Косвенная сверка с git, без запуска git: после клона коммитимая модель обязана
    // быть на диске. Имя, переименованное в .gitignore и не переименованное в файлах
    // (или наоборот), ловится здесь.
    const missing = [...REPO_MODELS].filter((n) => !fs.existsSync(modelPath(n)));
    expect(missing,
      'эти модели объявлены коммитимыми в fixtures/.gitignore, но на диске их нет')
      .toEqual([]);
  });

  it('разбор берёт только строки-исключения, а не весь файл', () => {
    // Если бы регулярка ловила лишнее, сюда попали бы шаблоны запрета (`*.glb`).
    for (const name of REPO_MODELS) {
      expect(name.includes('*'), `в списке шаблон, а не имя: ${name}`).toBe(false);
      expect(name.startsWith('models/'), `имя не очищено от пути: ${name}`).toBe(false);
    }
  });

  it('сторож действительно ловит — проверка на себе', () => {
    // Без этого тест выше зелёный и когда разбор сломан: пустой список сойдёт за порядок.
    const tmp = path.join(__dirname, '__guard-probe.test.mjs');
    // Обращение ВНУТРИ блока — то есть настоящее чтение, а не константа пути наверху файла.
    fs.writeFileSync(tmp, "describe('d', () => {\n  it('x', async () => {\n    await io.read(modelPath('НетТакой.glb'));\n  });\n});\n");
    try {
      expect(unguarded('__guard-probe.test.mjs')).toHaveLength(1);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
