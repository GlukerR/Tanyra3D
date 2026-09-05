import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, HAS_GLTF_CLI, makeTextCollector } from '../addons/gltf/tools.mjs';

describe('внешний CLI не занимает event loop', () => {
  it.skipIf(!HAS_GLTF_CLI)('таймеры продолжают тикать, пока CLI работает', async () => {
    let ticks = 0;
    const beat = setInterval(() => { ticks++; }, 20);

    const call = runCli(['такой-команды-нет']).catch(() => {});

    await Promise.race([call, new Promise((r) => setTimeout(r, 1500))]);
    const тиков = ticks;
    clearInterval(beat);
    expect(тиков, 'за время работы CLI не сработал ни один таймер — event loop был занят')
      .toBeGreaterThan(0);

    await call;
  }, 180_000);

  it.skipIf(!HAS_GLTF_CLI)('отказ CLI приходит отклонённым обещанием, а не исключением на месте', async () => {
    const call = runCli(['такой-команды-нет']);
    expect(typeof call.then, 'runCli обязан возвращать обещание').toBe('function');
    await expect(call).rejects.toThrow(/gltf-transform/);
  }, 60_000);

  it.skipIf(!HAS_GLTF_CLI)('кириллица в пути доезжает до сообщения об ошибке целой', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'кириллица-'));
    const missing = path.join(dir, 'модель которой нет.glb');
    try {
      await expect(runCli(['inspect', missing])).rejects.toThrow(/модель которой нет/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});


describe('сборщик текста из кусков потока', () => {
  const TEXT = 'Ошибка: не найден файл «модель кириллица».glb';

  const feed = (bytes, step) => {
    const c = makeTextCollector();
    for (let i = 0; i < bytes.length; i += step) c.push(bytes.subarray(i, Math.min(i + step, bytes.length)));
    return c.end();
  };

  it('буква, разорванная между кусками, собирается обратно', () => {
    const bytes = Buffer.from(TEXT, 'utf8');
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
    c.push(bytes.subarray(0, bytes.length - 1));
    const partial = c.end();
    expect(partial.length, 'хвост декодера потерялся').toBeGreaterThan(0);
  });
});
