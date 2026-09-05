import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { REPO_MODELS, modelPath } from './helpers/model-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = new Set(REPO_MODELS);

function guardedNames(line) {
  const one = line.match(/(?:itIfModel|describeLocal)\(\s*'([^']+)'/);
  if (one) return [one[1]];
  const many = line.match(/describeIfModels\(\s*\[([^\]]*)\]/);
  if (many) return [...many[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (/describeIfModels\(\s*[A-Za-z_$]/.test(line)) return ['*'];
  if (/eachModel\s*\(/.test(line)) return ['*'];
  return null;
}

function unguarded(file) {
  const lines = fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n');
  const stack = [];
  const bad = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('//')) { continue; }

    const names = guardedNames(line);
    const opensBlock = names !== null || /\b(describe|it)\s*\(/.test(line);

    for (const m of line.matchAll(/modelPath\(\s*'([^']+)'/g)) {
      const model = m[1];
      if (repo.has(model)) continue;
      if (model === 'does_not_exist.glb') continue;
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

  it('список коммитимых моделей разобран, а не пуст', () => {
    expect(REPO_MODELS.size).toBeGreaterThan(20);
  });

  it('в списке ровно то, что лежит в fixtures/models на диске', () => {
    const missing = [...REPO_MODELS].filter((n) => !fs.existsSync(modelPath(n)));
    expect(missing,
      'эти модели объявлены коммитимыми в fixtures/.gitignore, но на диске их нет')
      .toEqual([]);
  });

  it('разбор берёт только строки-исключения, а не весь файл', () => {
    for (const name of REPO_MODELS) {
      expect(name.includes('*'), `в списке шаблон, а не имя: ${name}`).toBe(false);
      expect(name.startsWith('models/'), `имя не очищено от пути: ${name}`).toBe(false);
    }
  });

  it('сторож действительно ловит — проверка на себе', () => {
    const tmp = path.join(__dirname, '__guard-probe.test.mjs');
    fs.writeFileSync(tmp, "describe('d', () => {\n  it('x', async () => {\n    await io.read(modelPath('НетТакой.glb'));\n  });\n});\n");
    try {
      expect(unguarded('__guard-probe.test.mjs')).toHaveLength(1);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
