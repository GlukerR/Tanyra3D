import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function leftoversFrom(previousRun) {
  const uploads = path.join(previousRun, 'uploads');
  const results = path.join(previousRun, 'results');
  fs.mkdirSync(path.join(uploads, 'старый-исходник'), { recursive: true });
  fs.mkdirSync(path.join(results, 'старый-исходник', 'прогон-1'), { recursive: true });
  fs.writeFileSync(path.join(uploads, 'старый-исходник', 'модель.glb'), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(results, 'старый-исходник', 'прогон-1', 'готово.glb'), Buffer.alloc(2048, 9));
  fs.mkdirSync(path.join(previousRun, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(previousRun, 'profiles', 'моя.json'), '{"title":"моя"}');
}

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

    expect(listing(path.join(dataDir, 'uploads')), 'мусор не разложен').toContain('старый-исходник');
    expect(listing(path.join(dataDir, 'results')), 'мусор не разложен').toContain('старый-исходник');

    let child;
    try {
      child = await startOver(dataDir);
      expect(listing(path.join(dataDir, 'uploads')),
        'загрузки прошлого сеанса пережили запуск — после обрыва диск копит чужие модели').toEqual([]);
      expect(listing(path.join(dataDir, 'results')),
        'результаты прошлого сеанса пережили запуск').toEqual([]);

      expect(listing(path.join(dataDir, 'profiles')),
        'уборка при запуске снесла свои площадки человека').toEqual(['моя.json']);
    } finally {
      if (child && !child.killed) child.kill();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {  }
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
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {  }
    }
  }, 180_000);
});
