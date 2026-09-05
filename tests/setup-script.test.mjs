import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(root, 'scripts', 'setup.mjs');

function runSetup(args, env = {}) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [SETUP, ...args], {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 60_000,
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('scripts/setup.mjs', () => {
  it('doctor не меняет окружение и сообщает о состоянии', () => {
    const { code, out } = runSetup(['--check']);
    expect(code).toBe(0);
    expect(out).toContain('Node');
    expect(out).toContain('Dependencies installed');
    expect(out).toContain('not checked in doctor mode');
  });

  it('без TTY не зависает на вопросе и печатает, как поставить руками', () => {
    const { code, out } = runSetup(['--check'], { TANYRA_SETUP_NO_KTX: '1' });
    expect(code).toBe(0);
    expect(out).toContain('KTX2 encoder not found');
    expect(out).toContain('npm start');
  });

  it('доктор не предлагает скачивание — он только смотрит', () => {
    const { out } = runSetup(['--check'], { TANYRA_SETUP_NO_KTX: '1' });
    expect(out).not.toContain('Download and install');
    expect(out).toContain('npm run setup');
  });

  it('обычная установка НЕ качает браузер', () => {
    const { out } = runSetup([]);
    expect(out).not.toMatch(/installing Chromium/i);
    expect(out).toContain('the program does not need it');
    expect(out).toContain('--tests');
  });

  it('отсутствие инструмента не делает прогон провальным', () => {
    const { code } = runSetup(['--check'], { TANYRA_SETUP_NO_KTX: '1' });
    expect(code).toBe(0);
  });
});
