// tests/validator-net.test.mjs — сеть по валидатору Khronos.
//
// Заведена 2026-08-10 по просьбе Александра: «надо проверять разные ошибки валидации
// во время тестов при загрузке модели, и решать все проблемы валидации в идеале».
//
// ГЛАВНОЕ ОБЕЩАНИЕ, которое здесь закрепляется: **мы не портим файл**. Что во входной
// модели было сломано — дефект её экспортёра, и чинить это отдельная работа
// (docs/ROADMAP.md §5b1). А вот КОД ОШИБКИ, которого во входном файле не было, а в
// нашем результате появился, — всегда наша вина, при любом наборе флажков.
//
// Почему сеть, а не проверка на конкретную модель. Ошибки валидатора появляются от
// СОЧЕТАНИЙ: правило само по себе корректно, но после другого правила оставляет
// вырожденную сцену. Поймать это можно только матрицей, и она себя оправдала в первый
// же прогон: `join` на четырёх моделях корпуса оставлял пустую сцену, а сериализатор
// писал её как `"nodes": []` — валидатор отвечал EMPTY_ENTITY. Той же природы оказался
// `"buffers": [{}]` без byteLength. Оба чинятся в addons/gltf/index.mjs
// (dropEmptyArrays), и оба нашла эта сеть, а не человек.
//
// Дёшево: пятнадцать моделей корпуса на семь наборов флажков — около трёх секунд.
// Валидатор работает с байтами в памяти, модели корпуса маленькие.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optimizeFile } from '../optimize2.mjs';
import { REPO_MODELS, modelPath, isPresent } from './helpers/model-files.mjs';

const validator = await import('gltf-validator');

// Наборы флажков. Не все подряд: взяты те, что МЕНЯЮТ СТРУКТУРУ сцены или
// перекладывают буферы, — именно от них и появляются новые замечания валидатора.
// Текстурные (ktx2/webp) сюда не входят намеренно: они требуют внешнего кодировщика,
// идут минутами и к структуре документа отношения не имеют.
const FLAG_SETS = [
  [],
  ['safe'],
  ['safe', 'join'],
  ['safe', 'instance'],
  ['safe', 'meshopt'],
  ['safe', 'draco'],
  ['safe', 'quantize'],
  ['safe', 'join', 'instance'],
];

// Список исключений намеренно ПУСТ. Он заводился 2026-08-14 на одну модель
// (Animated Pointer 01 под флажками отдавала VALUE_NOT_IN_LIST) и прожил один день:
// дефект закрыт, см. TESTBUG-011 в tests/bugs-found.test.mjs. Оставлен как место,
// а не как содержимое — исключение из этой сети допустимо только именное и с адресом
// задокументированного дефекта, иначе оно прячет поломку вместо того, чтобы о ней
// отчитаться.
const KNOWN_BROKEN = new Map([]);

const MODELS = [...REPO_MODELS];

/** Коды замечаний валидатора, разложенные по строгости. */
async function issues(bytes) {
  const res = await validator.validateBytes(new Uint8Array(bytes));
  const all = res.issues.messages || [];
  return {
    errors: all.filter((m) => m.severity === 0),
    warnings: all.filter((m) => m.severity === 1),
  };
}

const codesOf = (list) => new Set(list.map((m) => m.code));

async function run(model, flags) {
  const src = modelPath(model);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-net-'));
  try {
    const result = await optimizeFile(src, {
      outDir, force: true, locale: 'ru', advancedFeatures: flags,
    });
    return { result, outDir };
  } catch (e) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw e;
  }
}

describe('сеть по валидатору — наша обработка не добавляет замечаний', () => {
  for (const model of MODELS) {
    for (const flags of FLAG_SETS) {
      const label = `${model} [${flags.join(',') || 'passthrough'}]`;
      const body = async () => {
        const before = await issues(fs.readFileSync(modelPath(model)));
        const { result, outDir } = await run(model, flags);
        try {
          // Прогон не дошёл до файла — это отдельная беда, и её ловят другие наборы.
          // Здесь проверять нечего: сравнивать не с чем.
          if (!result.file.written || !result.file.dst) return;

          const after = await issues(fs.readFileSync(result.file.dst));
          const wasErr = codesOf(before.errors);
          const wasWarn = codesOf(before.warnings);

          const newErrors = [...codesOf(after.errors)].filter((c) => !wasErr.has(c));
          expect(
            newErrors,
            `появились ОШИБКИ, которых во входном файле не было: ${newErrors.join(', ')}. `
              + 'Это наша порча файла, а не дефект модели.',
          ).toEqual([]);

          // Предупреждения тоже не должны появляться из ниоткуда, но спрос мягче:
          // они не делают файл невалидным. Отдельным утверждением, чтобы в отчёте было
          // видно, что именно сломалось.
          const newWarnings = [...codesOf(after.warnings)].filter((c) => !wasWarn.has(c));
          expect(
            newWarnings,
            `появились предупреждения, которых во входном файле не было: ${newWarnings.join(', ')}`,
          ).toEqual([]);
        } finally {
          fs.rmSync(outDir, { recursive: true, force: true });
        }
      };
      const known = flags.length ? KNOWN_BROKEN.get(model) : null;
      if (known) it.skip(`${label} [известный дефект ${known}, закреплён в bugs-found]`, () => {}, 120_000);
      else if (isPresent(model)) it(label, body, 120_000);
      else it.skip(`${label} [skipped: ${model} missing locally]`, () => {}, 120_000);
    }
  }
});

// ----------------------------------------------------------------------------
// Закрепление двух конкретных находок этой сети. Общее утверждение выше их уже
// ловит, но общее говорит «появился код X», а эти — что именно было сломано и
// почему; вернётся дефект — по имени теста сразу видно, куда смотреть.
// ----------------------------------------------------------------------------

describe('вырожденные записи сериализатора', () => {
  const CASES = ['Texture Only 01.glb', 'Empty Nodes 01.glb', 'Two Scenes 01.glb', 'Pre KTX2 01.glb'];

  for (const model of CASES) {
    const body = async () => {
      const { result, outDir } = await run(model, ['safe', 'join']);
      try {
        expect(result.file.written).toBe(true);
        const glb = fs.readFileSync(result.file.dst);
        const jsonLen = glb.readUInt32LE(12);
        const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));

        // «nodes»: [] — спецификация требует непустой массив, если он объявлен
        for (const scene of json.scenes || []) {
          expect(scene.nodes, `сцена "${scene.name || '—'}" пишется с пустым nodes`).not.toEqual([]);
        }
        // «buffers»: [{}] — запись буфера без обязательного byteLength
        for (const buffer of json.buffers || []) {
          expect(buffer.byteLength, 'запись буфера без byteLength').toBeTypeOf('number');
        }

        // и заголовок GLB остался согласован — файл ведь пересобирался
        expect(glb.readUInt32LE(8), 'длина в заголовке GLB разошлась с размером файла').toBe(glb.length);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    };
    if (isPresent(model)) it(`${model} — join не оставляет пустых записей`, body, 120_000);
    else it.skip(`${model} [skipped: missing locally]`, () => {}, 120_000);
  }
});
