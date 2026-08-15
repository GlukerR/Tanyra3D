// tests/variants-survive.test.mjs — переключение цветов переживает объединение мешей.
//
// Дефект, найденный 2026-08-15 на вопрос Александра «мы ведь цвета не уничтожаем после
// оптимизации?». Уничтожали — при склейке, и молча.
//
// KHR_materials_variants хранит подмену НА ПРИМИТИВЕ: «этот кусок при варианте „Carmine
// Candy“ берёт материал 7». Объединение сливает примитивы, и место, где записан выбор,
// исчезает вместе с ними. Замер на CarConcept: 25 примитивов с привязками → 0, 75
// привязок → 0.
//
// Хуже честной потери оказалось то, что СПИСОК вариантов живёт в корне документа и
// объединение его не трогает. Файл продолжал заявлять три окраски, не содержа ни одной:
// программа на сайте показала бы человеку выбор из трёх цветов, который ничего не
// переключает. Поэтому проверять объявление в корне бессмысленно — сторож смотрит на
// привязки.
//
// Почему сторож нужен, хотя правка выглядит однострочной. Исключение живёт в фильтре
// join, рядом с исключением для общей геометрии, и обе причины разные (там объединение
// РАЗМНОЖАЕТ данные, здесь СТИРАЕТ). Сведут фильтр обратно к одному условию — этот тест
// покраснеет и назовёт, что именно пропало.
//
// Слои (ПРАВИЛА_ТЕСТОВ_универсальность.md): утверждения о выходном ФАЙЛЕ (слой 2),
// имени движка тут нет — Babylon прочитает тот же GLB и получит те же варианты.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';

import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

// Модели корпуса с вариантами материала: окраски машины и отделки часов.
const MODELS = ['CarConcept.glb', 'ChronographWatch.glb'];

// Наборы галочек: join отдельно и в компании. Остальные фичи тут не для полноты
// матрицы (её держит feature-combos), а потому что дефект нашёлся именно на сочетании.
const FLAG_SETS = [
  ['safe'],
  ['safe', 'join'],
  ['safe', 'join', 'meshopt'],
  ['safe', 'join', 'meshopt', 'webp'],
];

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

// Временные папки — из общего хелпера. Прежде здесь была своя `outRoot` БЕЗ уборки:
// папки копились в %TEMP% от прогона к прогону, а модели тут по десятку мегабайт.
afterAll(cleanupTmpOutDirs);

describeIfModels(MODELS, 'варианты материала переживают оптимизации', () => {
  for (const model of MODELS) {
    describe(model, () => {
      // Читаем исходник ЛЕНИВО, при первом обращении из теста, а не при сборе набора.
      // На чистом клоне этих моделей нет (лицензия Khronos), и describeIfModels
      // помечает блок пропущенным — но тело describe vitest всё равно ВЫПОЛНЯЕТ, чтобы
      // собрать имена тестов. Чтение файла прямо здесь валило весь файл с ENOENT ещё до
      // единого утверждения, и увидеть это можно было только на CI. Найдено 2026-08-15.
      let cached = null;
      const source = () => (cached ||= variantState(glbJson(modelPath(model))));

      it('в исходнике есть и имена вариантов, и привязки на примитивах', () => {
        expect(source().names.length, 'модель выбрана за варианты — их нет').toBeGreaterThan(0);
        expect(source().prims, 'привязок на примитивах нет — проверять нечего').toBeGreaterThan(0);
      });

      for (const flags of FLAG_SETS) {
        it(`[${flags.join('+')}] привязки целы`, async () => {
          const r = await optimizeFile(modelPath(model), {
            advancedFeatures: flags,
            outDir: tmpOutDir(),
          });
          expect(r.status).toBe('ok');
          const dst = r.file?.dst;
          expect(dst && fs.existsSync(dst), 'файл не записан').toBe(true);

          const after = variantState(glbJson(dst));
          expect(after.names, 'имена вариантов изменились').toEqual(source().names);
          // Главное утверждение. Именно оно краснело до правки: примитивы и привязки
          // обнулялись, а имена оставались — файл заявлял выбор, которого уже нет.
          expect(after.prims, 'примитивы с переключением исчезли — выбор цвета мёртв').toBe(source().prims);
          expect(after.mappings, 'привязки вариантов исчезли — выбор цвета мёртв').toBe(source().mappings);
        }, 180_000);
      }

      it('[safe+join] человеку сказано, что меши оставлены ради вариантов', async () => {
        const r = await optimizeFile(modelPath(model), {
          advancedFeatures: ['safe', 'join'],
          outDir: tmpOutDir(),
        });
        // Цена сохранённого выбора — лишние отрисовки, и она обязана быть названа.
        // Молчание здесь было бы тем же дефектом с другой стороны: человек видит
        // меньше экономии, чем ждал, и не знает почему.
        const ru = localizeResult(r, 'ru');
        const en = localizeResult(r, 'en');
        expect(ru.skipped.some((e) => /вариант/i.test(e.text || '')),
          'в русском отчёте нет строки про варианты').toBe(true);
        expect(en.skipped.some((e) => /variant/i.test(e.text || '')),
          'в английском отчёте нет строки про варианты').toBe(true);
        // Одна строка на класс, а не строка на меш (Правило 9).
        expect(ru.skipped.filter((e) => /вариант/i.test(e.text || '')).length).toBe(1);
      }, 180_000);
    });
  }
});
