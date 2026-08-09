// tests/inspect-metrics.test.mjs — цифры о модели ДО сборки те же, что и ПОСЛЕ.
//
// Зачем это отдельный тест (Александр, 2026-08-09): «нужно чтобы они появлялись
// сразу при загрузке модели, а не после первой оптимизации. мы это уже ранее
// чинили, но в последний раз снова была такая же проблема».
//
// «Ранее чинили, и снова» — признак того, что инвариант держался на договорённости,
// а не на проверке. Держаться ему было и правда не на чем: до сборки интерфейс
// считал цифры сам, из отрисованной сцены three.js, после сборки брал их у движка.
// Два независимых подсчёта одних и тех же строк расходились молча:
//
//   • сцена не знает текстур, которых не касается ни один материал, — а движок
//     знает, и именно они уходят в чистку. На «Dirty Cube 01.glb» это 2 против 5,
//     и число прыгало ровно в момент сборки;
//   • видеопамяти (VRAM) у сцены нет вовсе — строка появлялась только после
//     сборки, хотя решать по ней надо ДО: это главная величина для телефона;
//   • не отрисовалось — не показывалось ничего, хотя файл сервер уже разобрал.
//
// Теперь источник один: inspect() отдаёт metrics, посчитанные той же collectMetrics(),
// что даёт metrics.before в отчёте. Этот тест сторожит равенство. Разъедутся —
// покраснеет здесь, а не всплывёт через полгода как «опять пустая шапка».

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectFile, optimizeFile } from '../optimize2.mjs';
import { modelPath, eachModel } from './helpers/model-files.mjs';

const TIMEOUT = 120_000;

// Модели из git — тест обязан работать на чистом клоне.
const MODELS = [
  'Dirty Cube 01.glb',        // есть текстуры-сироты: расхождение сцены и файла
  'Orphan Texture Cube 01.glb',
  'Instance Grid 01.glb',
  'Texture Only 01.glb',
];

// Ровно те поля, которые интерфейс показывает в левой шапке.
const HUD_FIELDS = ['fileBytes', 'triangles', 'vertices', 'drawCalls', 'materials', 'textures', 'gpuBytes'];

describe('Цифры исходной модели: inspect() = metrics.before', () => {
  eachModel('inspect отдаёт метрики, и они совпадают с before после сборки', MODELS, async (name) => {
    const src = modelPath(name);

    const inspected = await inspectFile(src);
    expect(inspected.metrics, `${name}: inspect() не отдал metrics — левая шапка останется пустой`).toBeTruthy();

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-metrics-'));
    let result;
    try {
      result = await optimizeFile(src, { advancedFeatures: ['safe'], outDir });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    expect(result.status).toBe('ok');

    for (const field of HUD_FIELDS) {
      expect(
        inspected.metrics[field],
        `${name}: ${field} до сборки ${inspected.metrics[field]} ≠ ${result.metrics.before[field]} после. `
          + 'Левая шапка дёрнется в момент сборки — значит источников снова два.',
      ).toBe(result.metrics.before[field]);
    }
  }, TIMEOUT);

  it('размер файла в метриках — настоящий размер на диске', async () => {
    const name = 'Dirty Cube 01.glb';
    const inspected = await inspectFile(modelPath(name));
    expect(inspected.metrics.fileBytes).toBe(fs.statSync(modelPath(name)).size);
  }, TIMEOUT);

  it('поле metrics объявлено в контракте даже у формата без инспекции', async () => {
    // optimize2.inspectFile() отдаёт заглушку, когда аддон не умеет inspect.
    // Ключ обязан присутствовать: интерфейс читает modelInspect.metrics без проверок
    // на существование самого поля.
    const stub = { format: null, asset: {}, extensions: [], metadata: null, metrics: null, validation: [] };
    const src = fs.readFileSync(new URL('../optimize2.mjs', import.meta.url), 'utf8');
    for (const key of Object.keys(stub)) {
      expect(src, `в заглушке inspectFile() пропало поле ${key}`).toMatch(new RegExp(`${key}\\s*:`));
    }
  });
});
