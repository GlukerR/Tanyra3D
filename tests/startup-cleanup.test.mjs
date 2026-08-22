// tests/startup-cleanup.test.mjs — запуск после обрыва не наследует чужой мусор.
//
// ПОВОД (Александр, 2026-08-22): «если было даже прерываение приложения, при запуске
// должна быть автопроверка и чистка старых моделей в темп папке приложения».
//
// Уборка есть в трёх местах, и каждое закрывает свой случай:
//
//   · выход из программы  → `clearWorkDir()` в `desktop/main.cjs` (сторож —
//     `desktop-shell.test.mjs`);
//   · по ходу работы      → `sweepAbandoned()` и `purgeBeyondLimit()` в сервере
//     (сторожа — `abandoned-packs.test.mjs`, `work-limit.test.mjs`);
//   · ЗАПУСК              → две строки `ensureEmptyDir()` в сервере — и вот они не были
//     проверены ничем.
//
// Разница между третьим и первым — ровно тот случай, который назвал Александр. Уборка на
// выходе не срабатывает, когда выхода не было: обрыв питания, снятие процесса,
// падение. Тогда единственное, что стоит между человеком и чужими гигабайтами, — эти две
// строки. Их и стережём, причём НЕ чтением исходника: тест кладёт мусор в рабочую папку,
// поднимает настоящий сервер и смотрит, что от мусора осталось.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Рабочая папка, какой её оставляет ОБОРВАННЫЙ сеанс: загрузки и результаты на месте,
 * никто их не убрал.
 */
function leftoversFrom(previousRun) {
  const uploads = path.join(previousRun, 'uploads');
  const results = path.join(previousRun, 'results');
  fs.mkdirSync(path.join(uploads, 'старый-исходник'), { recursive: true });
  fs.mkdirSync(path.join(results, 'старый-исходник', 'прогон-1'), { recursive: true });
  fs.writeFileSync(path.join(uploads, 'старый-исходник', 'модель.glb'), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(results, 'старый-исходник', 'прогон-1', 'готово.glb'), Buffer.alloc(2048, 9));
  // Своя площадка человека лежит в той же папке данных и мусором НЕ является.
  fs.mkdirSync(path.join(previousRun, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(previousRun, 'profiles', 'моя.json'), '{"title":"моя"}');
}

/** Поднять сервер поверх готовой рабочей папки и дождаться, пока он назовёт порт. */
async function startOver(dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', TANYRA_NO_BROWSER: '1', TANYRA_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '', err = '';
    const timer = setTimeout(() => reject(new Error(`сервер не отозвался.\n${out}\n${err}`)), 120_000);
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.stdout.on('data', (c) => {
      out += c.toString();
      if (/http:\/\/[^:\s]+:\d+/.test(out)) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`сервер вышел с кодом ${code}`)); });
  });
  return child;
}

const listing = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

describe('запуск после обрыва', () => {
  it('стирает загрузки и результаты прошлого сеанса, не дожидаясь ничьей команды', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-'));
    leftoversFrom(dataDir);

    // Убеждаемся, что мусор и правда лежит: тест, начавшийся с пустой папки, доказал бы
    // только то, что пустая папка пуста.
    expect(listing(path.join(dataDir, 'uploads')), 'мусор не разложен').toContain('старый-исходник');
    expect(listing(path.join(dataDir, 'results')), 'мусор не разложен').toContain('старый-исходник');

    let child;
    try {
      child = await startOver(dataDir);
      expect(listing(path.join(dataDir, 'uploads')),
        'загрузки прошлого сеанса пережили запуск — после обрыва диск копит чужие модели').toEqual([]);
      expect(listing(path.join(dataDir, 'results')),
        'результаты прошлого сеанса пережили запуск').toEqual([]);

      // И ровно то, чего уборка касаться не должна. Папка данных общая: снести её целиком
      // значило бы стереть работу человека вместо мусора.
      expect(listing(path.join(dataDir, 'profiles')),
        'уборка при запуске снесла свои площадки человека').toEqual(['моя.json']);
    } finally {
      if (child && !child.killed) child.kill();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* временная папка */ }
    }
  }, 180_000);

  it('заводит рабочие папки, если их нет вовсе — первый запуск на чистой машине', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-fresh-'));
    let child;
    try {
      child = await startOver(dataDir);
      for (const name of ['uploads', 'results']) {
        expect(fs.existsSync(path.join(dataDir, name)), `${name} не заведена — первый запуск упадёт`).toBe(true);
      }
    } finally {
      if (child && !child.killed) child.kill();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* временная папка */ }
    }
  }, 180_000);
});
