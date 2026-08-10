// tests/cli-async.test.mjs — кодирование текстур не морозит остальную программу.
//
// Ревью 2026-08-10 (P1.1): внешний CLI запускался через `execFileSync` с потолком в
// десять минут. Сервер зовёт optimizeFile прямо в обработчике запроса, значит всё это
// время event loop занят: прогресс по SSE стоит на месте, вторая модель ждёт молча,
// отменить нельзя, и со стороны программа выглядит зависшей.
//
// Проверяется ровно это: пока CLI работает, таймеры обязаны продолжать срабатывать.
// На старом коде их бы не было ни одного — синхронный вызов не отдаёт управление.

import { describe, it, expect } from 'vitest';
import { runCli, HAS_GLTF_CLI } from '../addons/gltf/tools.mjs';

describe('внешний CLI не занимает event loop', () => {
  it.skipIf(!HAS_GLTF_CLI)('таймеры продолжают тикать, пока CLI работает', async () => {
    let ticks = 0;
    const beat = setInterval(() => { ticks++; }, 20);

    // Команда заведомо отказная: нас интересует не результат, а то, что запуск CLI
    // (node + загрузка бандла — заметно дольше сотни миллисекунд) идёт, не запирая
    // всё остальное. Отказ ловим и выбрасываем.
    await runCli(['такой-команды-нет']).catch(() => {});

    clearInterval(beat);
    expect(ticks, 'за время работы CLI не сработал ни один таймер — event loop был занят')
      .toBeGreaterThan(0);
  }, 60_000);

  it.skipIf(!HAS_GLTF_CLI)('отказ CLI приходит отклонённым обещанием, а не исключением на месте', async () => {
    const call = runCli(['такой-команды-нет']);
    expect(typeof call.then, 'runCli обязан возвращать обещание').toBe('function');
    await expect(call).rejects.toThrow(/gltf-transform/);
  }, 60_000);
});
