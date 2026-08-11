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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, HAS_GLTF_CLI, makeTextCollector } from '../addons/gltf/tools.mjs';

describe('внешний CLI не занимает event loop', () => {
  it.skipIf(!HAS_GLTF_CLI)('таймеры продолжают тикать, пока CLI работает', async () => {
    let ticks = 0;
    const beat = setInterval(() => { ticks++; }, 20);

    // Команда заведомо отказная: нас интересует не результат, а то, что запуск CLI
    // (node + загрузка бандла — заметно дольше сотни миллисекунд) идёт, не запирая
    // всё остальное. Отказ ловим и выбрасываем.
    const call = runCli(['такой-команды-нет']).catch(() => {});

    // Ждём не окончания чужой программы, а ПЕРВЫХ тиков.
    //
    // Раньше здесь стояло ожидание конца CLI, и 2026-08-11 в полном прогоне тест упал
    // по потолку в 60 с, хотя в одиночку проходит за четыре: полсотни наборов делили
    // одну машину, и запуск node с бандлом растянулся. Утверждение от длительности
    // чужого запуска не зависит вовсе — «цикл не занят» доказывает первый же тик.
    await Promise.race([call, new Promise((r) => setTimeout(r, 1500))]);
    const тиков = ticks;
    clearInterval(beat);
    expect(тиков, 'за время работы CLI не сработал ни один таймер — event loop был занят')
      .toBeGreaterThan(0);

    // Дождаться конца процесса уже без утверждений: оставить его жить дольше набора
    // нельзя — он держит трубы, и рабочий поток не завершится.
    await call;
  }, 180_000);

  it.skipIf(!HAS_GLTF_CLI)('отказ CLI приходит отклонённым обещанием, а не исключением на месте', async () => {
    const call = runCli(['такой-команды-нет']);
    expect(typeof call.then, 'runCli обязан возвращать обещание').toBe('function');
    await expect(call).rejects.toThrow(/gltf-transform/);
  }, 60_000);

  it.skipIf(!HAS_GLTF_CLI)('кириллица в пути доезжает до сообщения об ошибке целой', async () => {
    // Проверка сквозная, на живом CLI. Она НЕ ловит разрыв многобайтного символа —
    // короткий вывод приезжает одним куском (проверено мутацией). Разрыв ловит набор
    // ниже, прямо на сборщике; здесь важно, что путь вообще доходит до человека.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'кириллица-'));
    const missing = path.join(dir, 'модель которой нет.glb');
    try {
      await expect(runCli(['inspect', missing])).rejects.toThrow(/модель которой нет/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ----------------------------------------------------------------------------
// Сборка вывода из кусков. Дефект, внесённый переводом на spawn 2026-08-10 и
// найденный ревью в тот же день: поток режется по границе БАЙТА, а буква в UTF-8
// занимает два-три байта. `chunk.toString()` на каждом куске превращал разорванную
// букву в «□», и путь с кириллицей приезжал в сообщение об ошибке кашей.
// ----------------------------------------------------------------------------

describe('сборщик текста из кусков потока', () => {
  const TEXT = 'Ошибка: не найден файл «модель кириллица».glb';

  const feed = (bytes, step) => {
    const c = makeTextCollector();
    for (let i = 0; i < bytes.length; i += step) c.push(bytes.subarray(i, Math.min(i + step, bytes.length)));
    return c.end();
  };

  it('буква, разорванная между кусками, собирается обратно', () => {
    const bytes = Buffer.from(TEXT, 'utf8');
    // перебираем ВСЕ размеры куска: при каком-то из них разрыв придётся на середину
    // буквы обязательно, и гадать, при каком именно, не нужно
    for (let step = 1; step <= bytes.length; step++) {
      expect(feed(bytes, step), `размер куска ${step}`).toBe(TEXT);
    }
  });

  it('и ни при каком размере куска не появляется символ замены', () => {
    const bytes = Buffer.from(TEXT, 'utf8');
    for (let step = 1; step <= bytes.length; step++) {
      expect(feed(bytes, step)).not.toMatch(/�/);
    }
  });

  it('потолок режет начало, а не хвост — причина отказа всегда в конце', () => {
    const c = makeTextCollector(10);
    c.push(Buffer.from('1234567890abcdef', 'utf8'));
    expect(c.end()).toBe('7890abcdef');
  });

  it('переполнение потолка не превращается в квадрат', () => {
    // Ревью 2026-08-10 (D5): при `acc = acc + кусок` каждая порция ПОСЛЕ переполнения
    // расплющивала всю строку заново. На боевом потолке 32 МБ это давало 11,7 секунды
    // полностью занятого event loop — ровно та беда, ради которой CLI переводили на
    // spawn. Запас в проверке большой: она стережёт порядок величины, а не миллисекунды.
    const c = makeTextCollector(32 * 1024 * 1024);
    const chunk = Buffer.from('x'.repeat(20_000));
    const t0 = Date.now();
    for (let i = 0; i < 2000; i++) c.push(chunk);
    const text = c.end();
    const ms = Date.now() - t0;
    expect(text.length, 'потолок не соблюдён').toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(ms, `сборка 40 МБ вывода заняла ${ms} мс — похоже на квадрат`).toBeLessThan(2000);
  });

  it('незавершённая буква в самом конце потока не теряется', () => {
    const bytes = Buffer.from('конец', 'utf8');
    const c = makeTextCollector();
    c.push(bytes.subarray(0, bytes.length - 1)); // обрыв на середине последней буквы
    const partial = c.end();
    expect(partial.length, 'хвост декодера потерялся').toBeGreaterThan(0);
  });
});
