// tests/user-profiles.test.mjs — свои профили площадок (решение 2026-08-12).
//
// Механика «положил файл — площадка появилась» работала и раньше, но класть файл было
// некуда, кроме папки установки: её затирает обновление приложения. Вторая папка рядом
// с настройками решает это.
//
// Здесь сторожатся три обещания, каждое из которых можно нарушить незаметно:
//   1. свой профиль ВИДЕН и работает наравне со встроенным;
//   2. его пороги ПОМЕЧЕНЫ как свои — иначе через полгода никто не отличит выверенное
//      по первоисточнику число от придуманного;
//   3. свой профиль НЕ подменяет встроенный молча — чужое число под ссылкой на
//      документ настоящей площадки было бы худшим из возможных исходов.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listPlatforms, explainResult, planFor, customProfilesDir } from '../assistant.mjs';

let dir;
let saved;

beforeEach(() => {
  saved = process.env.TANYRA3D_PROFILES_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-profiles-'));
  process.env.TANYRA3D_PROFILES_DIR = dir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.TANYRA3D_PROFILES_DIR;
  else process.env.TANYRA3D_PROFILES_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Профиль «Озон» — ровно то, что человек напишет сам: числа без ссылок. */
function writeProfile(name, body) {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body, null, 2), 'utf8');
}

const OZON = {
  id: 'ozon',
  engine: 'threejs',
  enabled: true,
  title: 'Ozon',
  description: { en: 'My own target', ru: 'Своя площадка' },
  budgets: {
    triangles: { warn: 50000 },
    fileMB: { warn: 8 },
  },
  baselineOpts: { codec: 'meshopt', texMode: 'uastc', keepParts: false, noKtx: true },
};

const metricsWith = (over) => ({
  fileBytes: 20 * 1024 * 1024,
  gpuBytes: 1,
  triangles: over ? 999999 : 10,
  materials: 1,
  drawCalls: 1,
});

describe('свой профиль виден и работает', () => {
  it('появляется в списке площадок и помечен как свой', () => {
    writeProfile('ozon', OZON);
    const found = listPlatforms('ru').find((p) => p.id === 'ozon');
    expect(found, 'своего профиля нет в списке площадок').toBeTruthy();
    expect(found.custom, 'свой профиль не помечен — интерфейс не отличит его от встроенного').toBe(true);
    expect(found.title).toBe('Ozon');
    expect(found.engine, 'движок своего профиля потерялся').toBe('threejs');
  });

  it('встроенные площадки помечены как НЕ свои', () => {
    const builtin = listPlatforms('ru').find((p) => p.id === 'shopify');
    expect(builtin, 'встроенная площадка пропала из списка').toBeTruthy();
    expect(builtin.custom).toBe(false);
  });

  it('его бюджеты действительно сверяются', () => {
    writeProfile('ozon', OZON);
    const rr = { status: 'ok', metrics: { before: metricsWith(true), after: metricsWith(true) } };
    const checks = explainResult(rr, 'ozon', 'ru').budgetChecks;
    const tri = checks.find((c) => c.id === 'triangles');
    expect(tri, 'порог своего профиля не дошёл до сверки').toBeTruthy();
    expect(tri.level, '999 999 треугольников при пороге 50 000 — это жёлтый').toBe('warn');
  });

  it('план обработки по своей площадке считается', () => {
    writeProfile('ozon', OZON);
    const plan = planFor('ozon', 'ru');
    expect(plan.engine).toBe('threejs');
    expect(plan.availableExtensions.length, 'у своей площадки пустой список опций').toBeGreaterThan(0);
  });
});

describe('порог своего профиля виден как СВОЙ', () => {
  it('число без источника помечается «ваш порог»', () => {
    writeProfile('ozon', OZON);
    const rr = { status: 'ok', metrics: { before: metricsWith(true), after: metricsWith(true) } };
    const tri = explainResult(rr, 'ozon', 'ru').budgetChecks.find((c) => c.id === 'triangles');
    expect(tri.by, 'свой порог выдан за выверенный по первоисточнику').toBe('user');
    expect(tri.source, 'у своего числа не может быть ссылки на документ площадки').toBeUndefined();
  });

  // Файл не должен уметь объявить себя встроенным: пометку ставит загрузчик по тому,
  // ОТКУДА взят файл.
  it('поле custom:false внутри файла ничего не меняет', () => {
    writeProfile('ozon', { ...OZON, custom: false });
    const found = listPlatforms('ru').find((p) => p.id === 'ozon');
    expect(found.custom).toBe(true);

    const rr = { status: 'ok', metrics: { before: metricsWith(true), after: metricsWith(true) } };
    const tri = explainResult(rr, 'ozon', 'ru').budgetChecks.find((c) => c.id === 'triangles');
    expect(tri.by).toBe('user');
  });

  it('встроенный порог остаётся со своей ссылкой на источник', () => {
    const rr = { status: 'ok', metrics: { before: metricsWith(true), after: metricsWith(true) } };
    const tri = explainResult(rr, 'shopify', 'ru').budgetChecks.find((c) => c.id === 'triangles');
    if (!tri) return; // у площадки может не быть этого порога — тогда проверять нечего
    expect(tri.by, 'встроенный порог пометился как пользовательский').not.toBe('user');
  });
});

describe('свой профиль не подменяет встроенный', () => {
  it('файл с чужим id не вытесняет встроенную площадку', () => {
    writeProfile('shopify', { ...OZON, id: 'shopify', title: 'ПОДМЕНА', budgets: { fileMB: { warn: 1 } } });
    const shopify = listPlatforms('ru').filter((p) => p.id === 'shopify');
    expect(shopify.length, 'в списке две площадки с одним id').toBe(1);
    expect(shopify[0].title, 'встроенная площадка подменена своим файлом').not.toBe('ПОДМЕНА');
    expect(shopify[0].custom).toBe(false);
  });
});

describe('устойчивость', () => {
  it('битый файл в своей папке не роняет список', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ это не json', 'utf8');
    writeProfile('ozon', OZON);
    const ids = listPlatforms('ru').map((p) => p.id);
    expect(ids, 'битый сосед унёс с собой рабочий профиль').toContain('ozon');
  });

  it('нет папки — просто нет своих профилей, а не ошибка', () => {
    process.env.TANYRA3D_PROFILES_DIR = path.join(dir, 'её-нет');
    expect(() => listPlatforms('ru')).not.toThrow();
    expect(listPlatforms('ru').length, 'встроенные площадки пропали вместе с несуществующей папкой').toBeGreaterThan(0);
  });

  it('customProfilesDir показывает ту папку, куда класть файлы', () => {
    expect(customProfilesDir()).toBe(process.env.TANYRA3D_PROFILES_DIR);
  });
});
