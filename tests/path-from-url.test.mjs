import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { sourcePath } from './helpers/source-files.mjs';

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
    expect(url.pathname).toMatch(/%20/);

    const back = fileURLToPath(url);
    expect(back).toBe(file);
    expect(back).not.toMatch(/%[0-9A-Fa-f]{2}/);
    expect(fs.existsSync(back)).toBe(true);
  });

  it('локальный CLI находится и когда в пути есть пробел', async () => {
    const { GLTF_CLI_JS } = await import('../addons/gltf/tools.mjs');
    expect(GLTF_CLI_JS).toBeTruthy();
    expect(fs.existsSync(GLTF_CLI_JS)).toBe(true);
  });

  function offences(rel) {
    const found = [];
    const src = fs.readFileSync(rel, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    if (/import\.meta\.url[\s\S]{0,120}?\.pathname/.test(src)) found.push(`${rel}: .pathname от import.meta.url`);
    if (/\^\\\/\(\[A-Za-z\]:\)/.test(src)) found.push(`${rel}: ручное снятие слэша перед буквой диска`);
    return found;
  }

  it('старый приём не вернулся в исходники', () => {
    expect(SOURCES.flatMap(offences)).toEqual([]);
  });

  it('старый приём не завёлся и в самих тестах', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : (/\.(mjs|js)$/.test(e.name) ? [full] : []);
    });
    const files = walk(path.join(path.dirname(fileURLToPath(import.meta.url))));
    expect(files.length, 'не нашёл тестов — сторож проверяет пустоту').toBeGreaterThan(20);
    const self = fileURLToPath(import.meta.url);
    expect(files.filter((f) => f !== self).flatMap(offences)).toEqual([]);
  });
});
