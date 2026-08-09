// tests/engine-target-split.test.mjs — движок и площадка остаются разными осями.
//
// Решение Александра 2026-08-09, записано в docs/ARCHITECTURE.md §4g. Три вида фактов
// лежали в одном файле профиля:
//
//   budgets              — принадлежат ПЛОЩАДКЕ (лимиты Shopify — это лимиты Shopify,
//                          чем бы модель ни рисовали);
//   availableExtensions  — принадлежат ДВИЖКУ (читает ли он KTX2 без декодера);
//   reversible/dataLoss  — принадлежат САМОЙ ОПТИМИЗАЦИИ (join необратим всегда).
//
// Третье уже дублировалось: те же поля есть в addons/gltf/rules.mjs. Совпадали — но это
// ровно та форма, которая однажды уже разошлась (EXCLUSIVE_FEATURES против
// EXCLUSIVE_GROUPS, см. комментарий в addons/gltf/index.mjs). Второй список одной правды
// расходится молча, и замечают это по кривому экрану, а не по красному тесту.
//
// Сторожит три вещи, каждая из которых иначе тихо откатится:
//   1. профиль называет свой движок явно, а не прячет его в заголовке «Web (Three.js)»;
//   2. факты правил в профиль не вернулись;
//   3. API отдаёт движок и умеет принимать его в запросе.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFor, listPlatforms } from '../assistant.mjs';
import { listRules } from '../optimize2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = path.join(ROOT, 'profiles');

const profileFiles = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));
const profiles = profileFiles.map((f) => ({
  file: f,
  data: JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8')),
}));

describe('Движок и площадка — разные оси (ARCHITECTURE.md §4g)', () => {
  it('профилей вообще нашлось — иначе тест проверяет пустоту', () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  it('каждая площадка называет свой движок явным полем', () => {
    const без = profiles.filter((p) => !p.data.engine).map((p) => p.file);
    expect(
      без,
      `нет поля "engine": ${без.join(', ')}. Пара «площадка + движок» обязана быть видна `
        + 'в данных, а не в заголовке вида «Web (Three.js)» — иначе второй движок '
        + 'потребует переписывать названия, а не добавлять файл.',
    ).toEqual([]);
  });

  it('факты правил не вернулись в профили', () => {
    const нарушения = [];
    for (const { file, data } of profiles) {
      for (const ext of data.availableExtensions || []) {
        for (const поле of ['reversible', 'dataLoss']) {
          if (поле in ext) нарушения.push(`${file} → ${ext.id}.${поле}`);
        }
      }
    }
    expect(
      нарушения,
      `эти факты принадлежат правилу, а не площадке: ${нарушения.join(', ')}. `
        + 'Они уже есть в addons/gltf/rules.mjs; вторая копия разойдётся молча.',
    ).toEqual([]);
  });

  it('правила по-прежнему остаются единственным источником этих фактов', () => {
    // Если однажды удалить их и ОТТУДА, профили окажутся правы задним числом,
    // а проверка выше — бессмысленной.
    const rules = listRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(typeof rule.reversible, `${rule.id}: нет reversible`).toBe('boolean');
      expect(['none', 'minor', 'significant'], `${rule.id}: странный dataLoss`).toContain(rule.dataLoss);
    }
  });

  it('план отдаёт движок вместе с площадкой', () => {
    for (const { file, data } of profiles) {
      const plan = planFor(data.id);
      expect(plan.engine, `${file}: planFor() не назвал движок`).toBeTruthy();
      expect(plan.engine, `${file}: движок плана разошёлся с профилем`).toBe(data.engine);
    }
  });

  it('движок площадки существует как значение, а не как случайная строка', () => {
    // Пока файла engines/<id>.json нет, единственная проверка — что все площадки
    // называют один и тот же известный движок. Появится второй — этот тест
    // придётся переписать на список движков, и это правильный момент вспомнить о нём.
    const движки = [...new Set(profiles.map((p) => p.data.engine))];
    expect(движки, `движков в профилях: ${движки.join(', ')}`).toEqual(['threejs']);
  });

  it('listPlatforms по-прежнему отдаёт площадки, а не движки', () => {
    const ids = listPlatforms().map((p) => p.id);
    expect(ids.length).toBeGreaterThan(0);
    // Площадка и движок сегодня совпали по имени только у одной записи (threejs) —
    // это наследство, а не правило. Тест фиксирует, что список платформ не подменили
    // списком движков: их должно быть столько же, сколько включённых профилей.
    const включённых = profiles.filter((p) => p.data.enabled !== false).length;
    expect(ids.length).toBe(включённых);
  });
});
