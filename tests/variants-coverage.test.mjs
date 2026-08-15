// tests/variants-coverage.test.mjs — варианты материала: где ещё могут потеряться, кроме join.
//
// Задание 2026-08-15-варианты-и-площадки. Дефект со склейкой (join) закрыт 2026-08-15 и
// сторожится tests/variants-survive.test.mjs: там проверены safe, safe+join,
// safe+join+meshopt, safe+join+meshopt+webp. Проверено при этом только то, что чинили —
// вопрос задания: не теряются ли варианты на ОСТАЛЬНЫХ галочках и на втором прогоне.
//
// Утверждение то же, что у готового сторожа: считаем ПРИВЯЗКИ на примитивах, а не
// объявление вариантов в корне документа. Объявление переживало дефект (join стирал
// подмену, оставляя список) и потому ни о чём не говорит.
//
// Матрица фич берётся из RULES (meta.feature) — как в tests/feature-combos.test.mjs:
// девятая фича попадёт в перебор сама. draco в RULES нет (кодек-вариант одного правила),
// resize — флажок resize-1024 (в meta.feature его нет, он едет через maxTextureSize),
// поэтому оба добавлены явно рядом с близнецами.
//
// Слои (ПРАВИЛА_ТЕСТОВ_универсальность.md): утверждения о выходном ФАЙЛЕ (слой 2),
// имён движков тут нет — Babylon прочитает тот же GLB и получит те же варианты.
//
// Найденный дефект здесь НЕ чинится: красный тест оформляется фиксацией (как
// tests/bugs-found.test.mjs), а в отчёте задания описываются модель, галочки и числа.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import { TOKTX, HAS_GLTF_CLI } from '../addons/gltf/tools.mjs';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

// Модели с вариантами материала: три окраски машины, четыре отделки часов.
const MODELS = ['CarConcept.glb', 'ChronographWatch.glb'];
// Отрицательный случай: репо-модель без KHR_materials_variants.
const NO_VARIANT_MODEL = 'Dirty Cube 01.glb';

// Фичи из RULES (meta.feature) — матрица растёт сама. join отдельно не берём: он уже
// закрыт variants-survive; здесь он нужен только в сочетании instance+join.
const RULES_FEATURES = [...new Set(RULES.map((r) => r.meta.feature).filter(Boolean))];
const SINGLE_FEATURES = [...new Set([...RULES_FEATURES.filter((f) => f !== 'join'), 'draco', 'resize-1024'])];
const FLAG_SETS = [
  ...SINGLE_FEATURES.map((f) => ['safe', f]),
  ['safe', 'instance', 'join'],
];

const TOKTX_OK = Boolean(TOKTX && HAS_GLTF_CLI); // ktx2-правило гейтится обоими

// Временные папки прогона с уборкой в afterAll (тесты пишут в %TEMP%, не в output/).
const tmpDirs = [];
function tmpOut(prefix = 'variants-cov-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* занят — подчистит ОС */ }
  }
});

function glbJson(file) {
  const b = fs.readFileSync(file);
  if (b.length < 20 || b.readUInt32LE(0) !== 0x46546c67) return null;
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
}

/** Что реально держит переключение: имена вариантов и ПРИВЯЗКИ на примитивах. */
function variantState(json) {
  const names = (json.extensions?.KHR_materials_variants?.variants || []).map((v) => v.name);
  let prims = 0;
  let mappings = 0;
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const ext = prim.extensions?.KHR_materials_variants;
      if (ext) { prims++; mappings += (ext.mappings || []).length; }
    }
  }
  return { names, prims, mappings };
}

// ============================================================================
// РАЗДЕЛ 1. Остальные галочки и их сочетания.
// ============================================================================
describeIfModels(MODELS, 'варианты материала переживают остальные галочки', () => {
  for (const model of MODELS) {
    describe(model, () => {
      const before = variantState(glbJson(modelPath(model)));

      it('в исходнике есть и имена вариантов, и привязки на примитивах', () => {
        expect(before.names.length, 'модель выбрана за варианты — их нет').toBeGreaterThan(0);
        expect(before.mappings, 'привязок на примитивах нет — проверять нечего').toBeGreaterThan(0);
      });

      for (const flags of FLAG_SETS) {
        const needsToktx = flags.includes('ktx2') && !TOKTX_OK;
        const label = `[${flags.join('+')}] привязки целы`;
        const body = async () => {
          const r = await optimizeFile(modelPath(model), {
            advancedFeatures: flags,
            outDir: tmpOut(),
          });
          expect(r.status).toBe('ok');
          const dst = r.file?.dst;
          expect(dst && fs.existsSync(dst), 'файл не записан').toBe(true);

          const after = variantState(glbJson(dst));
          expect(after.names, 'имена вариантов изменились').toEqual(before.names);
          // Главное утверждение: выбор цвета/отделки жив на примитивах, а не только
          // объявлен в корне. Именно оно краснеет, когда галочка стирает подмену.
          expect(after.prims, 'примитивы с переключением исчезли — выбор мёртв').toBe(before.prims);
          expect(after.mappings, 'привязки вариантов исчезли — выбор мёртв').toBe(before.mappings);
        };
        if (needsToktx) {
          it.skip(`${label} [пропущено: нет toktx/gltf-transform CLI]`, () => {});
        } else {
          it(label, body, 180_000);
        }
      }
    });
  }
});

// ============================================================================
// РАЗДЕЛ 2+3. Двойной прогон и правило истины (EXTENDING §5c).
// ============================================================================
describeIfModels(MODELS, 'варианты переживают двойной прогон — итог сверяется с первоначальным файлом', () => {
  for (const model of MODELS) {
    it(`${model} — [safe+join] дважды, привязки равны ВХОДУ`, async () => {
      const before = variantState(glbJson(modelPath(model)));

      const r1 = await optimizeFile(modelPath(model), {
        advancedFeatures: ['safe', 'join'],
        outDir: tmpOut(),
      });
      expect(r1.status).toBe('ok');
      expect(r1.file?.dst && fs.existsSync(r1.file.dst), 'первый прогон не записал файл').toBe(true);

      // Оптимизируем РЕЗУЛЬТАТ, а не вход. Класс дефектов настоящий: у KTX2 так нашлась
      // запись «уже KTX2», которая на втором заходе выдавала строку на каждую текстуру.
      const r2 = await optimizeFile(r1.file.dst, {
        advancedFeatures: ['safe', 'join'],
        outDir: tmpOut(),
      });
      expect(r2.status).toBe('ok');
      expect(r2.file?.dst && fs.existsSync(r2.file.dst), 'второй прогон не записал файл').toBe(true);

      // Правило истины: сверяем с ПЕРВОНАЧАЛЬНЫМ файлом, а не с промежуточным r1.
      const after = variantState(glbJson(r2.file.dst));
      expect(after.names, 'имена вариантов изменились после двух прогонов').toEqual(before.names);
      expect(after.prims).toBe(before.prims);
      expect(after.mappings).toBe(before.mappings);
    }, 180_000);
  }
});

// ============================================================================
// РАЗДЕЛ 4. Что говорит человеку отчёт.
// ============================================================================
describeIfModels(MODELS, 'отчёт человеку: ровно одна строка join.keptVariants', () => {
  for (const model of MODELS) {
    it(`${model} — [safe+join]: одна строка, переживает смену языка без пересборки`, async () => {
      const r = await optimizeFile(modelPath(model), {
        advancedFeatures: ['safe', 'join'],
        outDir: tmpOut(),
      });
      // localizeResult на ГОТОВОМ результате — движок не вызывается повторно (Правило 8).
      const ru = localizeResult(r, 'ru');
      const en = localizeResult(r, 'en');
      const ruLines = ru.skipped.filter((e) => e.i18n?.text?.messageId === 'join.keptVariants');
      const enLines = en.skipped.filter((e) => e.i18n?.text?.messageId === 'join.keptVariants');
      // Одна строка на класс, а не строка на меш (Правило 9).
      expect(ruLines.length, 'в русском отчёте строка размножилась по мешам или пропала').toBe(1);
      expect(enLines.length, 'в английском отчёте строка размножилась по мешам или пропала').toBe(1);
    }, 180_000);
  }

  it('модель без вариантов — строки join.keptVariants нет вовсе', async () => {
    const r = await optimizeFile(modelPath(NO_VARIANT_MODEL), {
      advancedFeatures: ['safe', 'join'],
      outDir: tmpOut(),
    });
    const ru = localizeResult(r, 'ru');
    const en = localizeResult(r, 'en');
    expect(ru.skipped.some((e) => e.i18n?.text?.messageId === 'join.keptVariants'),
      'строка про варианты появилась на модели без вариантов').toBe(false);
    expect(en.skipped.some((e) => e.i18n?.text?.messageId === 'join.keptVariants'),
      'строка про варианты появилась на модели без вариантов').toBe(false);
  }, 180_000);
});
