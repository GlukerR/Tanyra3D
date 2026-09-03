// tests/profile-unknowns.test.mjs — непонятое в профиле НАЗЫВАЕТСЯ, а не тонет.
//
// РЕШЕНИЕ (Александр, 2026-09-01: «делай решения из аудита как считаешь правильным»).
// Закрывает два вопроса аудита сразу — 1.3 и 1.4 из `docs/АУДИТ_итог_предложения.md`:
//
//   1.4 — человек кладёт СВОЙ профиль и пишет в него `budgets.vertices: 1000`. Порога с
//         таким именем движок не знает. До сегодня: тишина. Порог не применялся ни разу,
//         ошибки не было, и человек считал, что всё работает.
//   1.3 — пометка `by` говорит, ЧЬЁ это число. Понимаются ровно два значения; третье
//         молча не рисовалось вовсе.
//
// ПОЧЕМУ ОДИН КАНАЛ. Изнутри это две разные ошибки, снаружи — одна: «в твоём профиле есть
// то, чего программа не знает», и делать в обоих случаях надо одно и то же — открыть файл
// и поправить строку.
//
// ПОЧЕМУ НЕ ОТКАЗ, а сообщение. Профиль читается на СЕРВЕРЕ, человека у экрана в этот
// момент нет. Уронить площадку целиком из-за одной непонятой строки — потерять и те её
// пороги, которые верны. Поэтому: применяем понятое, называем непонятое.
//
// ЧТО СТЕРЕЖЁМ:
//   1. Неизвестный порог назван.
//   2. Неизвестное значение `by` названо, и названо с именем порога.
//   3. Известное НЕ называется — иначе значок горит всегда и его перестают замечать.
//   4. Встроенные площадки чисты: у них непонятого быть не должно вовсе.
//
// ПРОБА НА КРАСНОТУ (пройдена 2026-09-01): вернул в `profileUnknowns` пустой массив —
// краснеют разделы 1 и 2; убрал проверку `by` — краснеет раздел 2.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listPlatforms } from '../assistant.mjs';

const мусор = [];
let сохранённая;

beforeAll(() => { сохранённая = process.env.TANYRA3D_PROFILES_DIR; });
afterAll(() => {
  if (сохранённая === undefined) delete process.env.TANYRA3D_PROFILES_DIR;
  else process.env.TANYRA3D_PROFILES_DIR = сохранённая;
  for (const d of мусор) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Свой профиль во временной папке.
 *
 * `TANYRA3D_PROFILES_DIR` — та же переменная, которой набор изолируется от настоящих
 * настроек человека (`tests/isolate-profiles.setup.mjs`). Перекрываем уже перекрытое, как
 * это делают соседи `user-profiles` и `profile-form`.
 */
function сПрофилем(json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-unknown-'));
  мусор.push(dir);
  fs.writeFileSync(path.join(dir, `${json.id}.json`), JSON.stringify(json, null, 2));
  process.env.TANYRA3D_PROFILES_DIR = dir;
  return listPlatforms('ru').find((p) => p.id === json.id) || null;
}

const профиль = (budgets) => ({
  id: 'проба-непонятого',
  title: 'Проба',
  enabled: true,
  budgets,
});

describe('непонятое в своём профиле называется', () => {
  it('неизвестный порог назван по имени', () => {
    const p = сПрофилем(профиль({ vertices: { warn: 1000 }, fileMB: { warn: 5 } }));
    expect(p, 'своя площадка не попала в список вовсе').toBeTruthy();
    expect(p.unknown, 'порог `vertices` движку неизвестен и обязан быть назван').toContain('vertices');
  });

  it('известный порог рядом с неизвестным НЕ называется', () => {
    // Иначе значок горит у всех и его перестают замечать.
    const p = сПрофилем(профиль({ vertices: { warn: 1000 }, fileMB: { warn: 5 } }));
    expect(p.unknown, 'названо то, что программа прекрасно понимает').not.toContain('fileMB');
  });

  it('неизвестное значение by названо вместе с именем порога', () => {
    const p = сПрофилем(профиль({ fileMB: { warn: 5, by: 'нашеЧисло' } }));
    expect(p.unknown, 'третье значение by молча не рисовалось — это и чинится')
      .toContain('fileMB.by');
  });

  it('два известных значения by возражений не вызывают', () => {
    const p = сПрофилем(профиль({ fileMB: { warn: 5, by: 'project' }, triangles: { warn: 10, by: 'user' } }));
    expect(p.unknown, 'project и user — ровно те два значения, которые понимаются').toEqual([]);
  });

  it('профиль без единой странности молчит', () => {
    const p = сПрофилем(профиль({ fileMB: { warn: 5 } }));
    expect(p.unknown, 'нечего сказать — значит нечего и показывать').toEqual([]);
  });
});

describe('встроенные площадки понятны целиком', () => {
  it('ни у одной из поставки нет непонятого', () => {
    const пустая = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-empty-'));
    мусор.push(пустая);
    process.env.TANYRA3D_PROFILES_DIR = пустая;
    const плохие = listPlatforms('ru')
      .filter((p) => !p.custom && p.unknown && p.unknown.length)
      .map((p) => `${p.id}: ${p.unknown.join(', ')}`);
    expect(плохие, 'в профиле из поставки есть непонятое движку — это наша ошибка, а не человека')
      .toEqual([]);
  });
});
