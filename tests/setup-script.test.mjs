// Проверка scripts/setup.mjs — ветки «инструмента нет».
//
// Зачем отдельный файл. Ветка, которая предлагает скачать KTX-Software, на машине
// разработчика недостижима: там инструмент уже стоит. А именно она качает чужой
// исполняемый файл и именно она способна ЗАВИСНУТЬ, ожидая ответа там, где отвечать
// некому — в CI, в пайпе, при запуске из другого скрипта. Зависший прогон выглядит
// как медленный, и его находят через полчаса.
//
// Ветка достижима через TANYRA_SETUP_NO_KTX=1 (шов, описанный в самом скрипте).
// Здесь ничего не скачивается: проверяется, что без TTY скрипт спрашивать НЕ лезет,
// доходит до конца и печатает человеку, что делать руками.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(root, 'scripts', 'setup.mjs');

/** stdio: 'pipe' — потомок наследует НЕ-TTY, ровно как в CI. */
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
    // Режим проверки не должен качать Chromium — это и есть «ничего не менять».
    expect(out).toContain('not checked in doctor mode');
  });

  it('без TTY не зависает на вопросе и печатает, как поставить руками', () => {
    const { code, out } = runSetup(['--check'], { TANYRA_SETUP_NO_KTX: '1' });
    expect(code).toBe(0);
    expect(out).toContain('KTX2 encoder not found');
    // Главное: дошёл до конца, а не остался ждать ввода.
    expect(out).toContain('npm start');
  });

  it('доктор не предлагает скачивание — он только смотрит', () => {
    const { out } = runSetup(['--check'], { TANYRA_SETUP_NO_KTX: '1' });
    expect(out).not.toContain('Download and install');
    expect(out).toContain('npm run setup');
  });

  it('обычная установка НЕ качает браузер', () => {
    // Браузер нужен только тестам: ни server.mjs, ни ui/ о нём не знают. Он весит
    // сотни мегабайт, и человек, которому нужно просто открыть приложение, качал
    // его впустую. Сторож на то, чтобы это не вернулось тихо.
    //
    // Без --check: проверяем НАСТОЯЩУЮ установку, а не режим осмотра. Безопасно —
    // без TTY скрипт ничего не спрашивает, а без --tests браузер не трогает.
    const { out } = runSetup([]);
    expect(out).not.toMatch(/installing Chromium/i);
    expect(out).toContain('the program does not need it');
    expect(out).toContain('--tests');
  });

  it('отсутствие инструмента не делает прогон провальным', () => {
    // Без ktx работает всё, кроме KTX2. Ненулевой код превратил бы
    // «нет одной необязательной утилиты» в «установка сломалась».
    const { code } = runSetup(['--check'], { TANYRA_SETUP_NO_KTX: '1' });
    expect(code).toBe(0);
  });
});
