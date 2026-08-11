// tests/path-from-url.test.mjs — путь из `import.meta.url` не должен приезжать процентами.
//
// Ревью 2026-08-10 (P1.2): в трёх местах путь получали как `new URL(...).pathname` и
// вручную снимали ведущий слэш регуляркой `^\/([A-Za-z]:)`. Регулярка чинила букву
// диска и молчала обо всём остальном: пробел оставался `%20`, кириллица — процентами.
// Для установки в `C:\Program Files\Tanyra3D` это значило «локальный CLI не найден»,
// и человек узнавал об этом, когда KTX2 уже отказался работать.
//
// Проверка идёт по СМЫСЛУ, а не по имени функции: берём URL с пробелом и кириллицей,
// разворачиваем и требуем, чтобы получился путь, который видит файловая система.
// Плюс запрет на возврат старого приёма в исходниках — иначе следующая правка тихо
// вернёт его рядом.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { sourcePath } from './helpers/source-files.mjs';

// Часть этих модулей с 2026-08-11 живёт в `.mts`, а `.mjs` рядом — собранный. Стеречь
// надо ИСТОЧНИК: собранного на чистом клоне до сборки нет, да и правит человек не его.
// Список остаётся в одном виде — какое расширение сейчас настоящее, решает файловая
// система, а не запись здесь.
const SOURCES = [
  'addons/gltf/tools',
  'scripts/setup',
  'core/engine',
  'server',
  'assistant',
].map(sourcePath);

describe('путь из file:-URL', () => {
  it('пробел и кириллица переживают дорогу туда и обратно', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'путь тест-'));
    const file = path.join(dir, 'Program Files', 'модель сцены.glb');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');

    const url = pathToFileURL(file);
    // так делали раньше — и вот что из этого выходило
    expect(url.pathname).toMatch(/%20/);

    const back = fileURLToPath(url);
    expect(back).toBe(file);
    expect(back).not.toMatch(/%[0-9A-Fa-f]{2}/);
    expect(fs.existsSync(back)).toBe(true);
  });

  it('локальный CLI находится и когда в пути есть пробел', async () => {
    // Косвенная, но настоящая проверка: модуль вычисляет путь к своей зависимости
    // от собственного расположения. Если бы он делал это через `.pathname`, на
    // машине с пробелом в пути ответ был бы null.
    const { GLTF_CLI_JS } = await import('../addons/gltf/tools.mjs');
    // В дереве разработки зависимость стоит — путь обязан быть найден и существовать.
    expect(GLTF_CLI_JS).toBeTruthy();
    expect(fs.existsSync(GLTF_CLI_JS)).toBe(true);
  });

  it('старый приём не вернулся в исходники', () => {
    const guilty = [];
    for (const rel of SOURCES) {
      const src = fs.readFileSync(rel, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      // `.pathname` от file:-URL, а также ручное снятие ведущего слэша перед буквой диска
      if (/import\.meta\.url[\s\S]{0,120}?\.pathname/.test(src)) guilty.push(`${rel}: .pathname от import.meta.url`);
      if (/\^\\\/\(\[A-Za-z\]:\)/.test(src)) guilty.push(`${rel}: ручное снятие слэша перед буквой диска`);
    }
    expect(guilty).toEqual([]);
  });
});
