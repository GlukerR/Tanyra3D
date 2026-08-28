// tests/interactivity-survives.test.mjs — настоящие модели с интерактивом доезжают целыми.
//
// ОТКУДА ОНИ. 2026-08-28 Александр скачал официальный набор Khronos
// (github.com/KhronosGroup/glTF-Test-Assets-Interactivity, CC BY 4.0) — до этого дня в
// корпусе не было НИ ОДНОЙ настоящей модели с `KHR_interactivity`, только наша
// синтетическая заготовка `Unknown Ext Interactivity 01`, у которой в графе нет ни одной
// ссылки. Вся логика вокруг непрозрачных расширений держалась на ней и на спецификации.
//
// ЧТО ЖИВЫЕ ФАЙЛЫ ТУТ ЖЕ ПОКАЗАЛИ, а заготовка показать не могла:
//
//   1. `WhackAMole` теряла СЕМЬ мест `KHR_node_selectability` с телом `{selectable:true}`.
//      В теле нет ни одного числа — адресовать нечем, ломаться нечему; терялось оно
//      из-за сдвига `accessors`, которых оно не касается вовсе.
//   2. `Calculator` и `WhackAMole` теряли САМ `KHR_interactivity`. Его указатели смотрят
//      в `nodes`, а сборка дописывает узлы: 23 → 24 и 68 → 82. Проверка сравнивала ДЛИНЫ
//      и объявляла номера сломанными — хотя все исходные узлы остались на своих местах
//      (совпал весь префикс имён), и указатель `/nodes/3/translation` по-прежнему верен.
//
// Обе потери шли МОЛЧА: в отчёте о них не было ни строчки, только предупреждение в
// журнале сервера.
//
// ПОЧЕМУ ЭТОТ ФАЙЛ ОТДЕЛЬНО от `unknown-extension-survives`. Тот сторожит РАЗБОР —
// на заготовках и на единицах измерения. Этот сторожит ИТОГ на живых файлах: прогнали
// настоящую модель через настоящий набор галочек — все ли расширения на месте. Такую
// проверку нельзя подделать заготовкой: обе находки выше пришли из данных, которых мы
// сами бы не придумали.
//
// В git моделей нет и не будет (Правило 0), поэтому проверки пропускаются там, где
// файлов на диске нет, — как и весь остальной корпус.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';

import { optimizeFile } from '../optimize2.mjs';
import { modelPath, isPresent } from './helpers/model-files.mjs';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

afterAll(cleanupTmpOutDirs);

/** Модели набора и то, ради чего каждая здесь. */
const MODELS = [
  ['TrafficLight.glb', 'указатели в materials'],
  ['Calculator.glb', 'указатели и в nodes, и в materials; узлы дописываются 23 → 24'],
  ['WhackAMole.glb', 'семь KHR_node_selectability без единого числа; узлы 68 → 82'],
  ['MagicBall.glb', 'двадцать два указателя в nodes'],
  ['ConstructionSite.glb', 'самая тяжёлая, 6.8 МБ'],
];

/** JSON-чанк GLB. Читаем сами: спор идёт о том, что лежит в ФАЙЛЕ, а не в документе. */
function glbJson(file) {
  const buf = fs.readFileSync(file);
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
}

/**
 * Сколько МЕСТ занимает каждое расширение во всём документе.
 *
 * Именно мест, а не «объявлено ли имя». Имя в `extensionsUsed` переживает потерю тела —
 * ровно этим враньём и была поломка 0.2.18: файл заявлял способность, которой у него
 * больше не было.
 */
function spotsByExtension(json) {
  const found = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (k === 'extensions' && val && typeof val === 'object') {
        for (const name of Object.keys(val)) found.set(name, (found.get(name) || 0) + 1);
      }
      walk(val);
    }
  };
  walk(json);
  return found;
}

describe('модели Khronos с KHR_interactivity доезжают целыми', () => {
  for (const [model, зачем] of MODELS) {
    const runIt = isPresent(model) ? it : it.skip;

    runIt(`${model} — ${зачем}`, async () => {
      const src = modelPath(model);
      const before = spotsByExtension(glbJson(src));
      // Полный набор, а не `safe`: обе находки вылезли именно на нём. `webp` двигает
      // текстуры и образцы, `meshopt` — аксессоры, `safe` — узлы.
      const result = await optimizeFile(src, {
        advancedFeatures: ['safe', 'meshopt', 'webp'],
        outDir: tmpOutDir(),
      });
      expect(result.status, 'сборка не прошла').toBe('ok');

      const after = spotsByExtension(glbJson(result.file.dst));
      const потеряно = [...before]
        .filter(([name, n]) => (after.get(name) || 0) < n)
        .map(([name, n]) => `${name}: было ${n}, стало ${after.get(name) || 0}`);

      expect(потеряно, `расширения потеряны при сборке:\n  ${потеряно.join('\n  ')}`).toEqual([]);
    }, 300000);
  }

  const ГЛАВНАЯ = 'WhackAMole.glb';
  const мышьIt = isPresent(ГЛАВНАЯ) ? it : it.skip;

  мышьIt('WhackAMole — тело графа доезжает БАЙТ В БАЙТ, а не пустым', async () => {
    // Отдельная проверка к предыдущей: место может уцелеть, а тело оказаться пустым —
    // так и выглядела поломка 0.2.18. Сравниваем сам граф целиком.
    const src = modelPath(ГЛАВНАЯ);
    const before = glbJson(src).extensions.KHR_interactivity;
    const result = await optimizeFile(src, {
      advancedFeatures: ['safe', 'meshopt', 'webp'],
      outDir: tmpOutDir(),
    });
    const after = glbJson(result.file.dst).extensions?.KHR_interactivity;
    expect(after, 'граф поведения исчез целиком').toBeTruthy();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  }, 300000);

  мышьIt('WhackAMole — исходные узлы остались на своих местах', async () => {
    // Основание, по которому мы вообще разрешаем возврат: указатели графа смотрят в
    // `nodes`, сборка их дописывает, и доказательством служит совпадение ПРЕФИКСА имён.
    // Сломается это — расширение придётся снова терять, и знать об этом надо сразу.
    const src = modelPath(ГЛАВНАЯ);
    const before = glbJson(src).nodes.map((n) => n.name);
    const result = await optimizeFile(src, {
      advancedFeatures: ['safe', 'meshopt', 'webp'],
      outDir: tmpOutDir(),
    });
    const after = glbJson(result.file.dst).nodes.map((n) => n.name);

    expect(after.length, 'узлов стало меньше — номера точно сдвинулись')
      .toBeGreaterThanOrEqual(before.length);
    expect(after.slice(0, before.length), 'исходные узлы переставлены — указатели графа врут')
      .toEqual(before);
    expect(before.every((n) => typeof n === 'string' && n),
      'в исходнике появился безымянный узел — доказательство по именам перестало работать').toBe(true);
  }, 300000);
});
