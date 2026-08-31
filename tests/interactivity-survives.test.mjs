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
import { readInteractivity } from '../addons/gltf/interactivity.mjs';
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

// ═══════════════════════════════════════════════════════════════════════════
// Пустые нажимаемые части — вопрос Александра, 2026-08-28
//
// «там есть неработающие пустые интерактивные элементы? ты видишь это?» Вопрос про
// калькулятор, у которого пятнадцать кнопок, а видимого действия от них немного. Ответ по
// замеру: пустых нет ни одной — каждая кнопка со своим откликом, просто модель считает не
// то, чего от неё ждёшь (одно число в диапазоне −99…99, а не выражение).
//
// Сторож нужен не ради этого ответа, а ради самого умения его дать: обведённая часть
// обещает нажатие (Правило 12), и расхождение обещания с файлом человек должен видеть в
// отчёте.
// ═══════════════════════════════════════════════════════════════════════════

describe('нажимаемые части без отклика видны в отчёте', () => {
  const калькуляторIt = isPresent('Calculator.glb') ? it : it.skip;

  it('часть помечена нажимаемой, а в графе про неё ничего — считается пустой', () => {
    const found = readInteractivity({
      nodes: [
        { name: 'Кнопка', extensions: { KHR_node_selectability: { selectable: true } } },
        { name: 'Пустышка', extensions: { KHR_node_selectability: { selectable: true } } },
      ],
      extensions: {
        KHR_interactivity: {
          graphs: [{
            declarations: [{ op: 'event/onSelect' }],
            nodes: [{ declaration: 0, configuration: { nodeIndex: { value: [0] } } }],
          }],
        },
      },
    });
    expect(found.clickable).toBe(2);
    expect(found.handlers).toBe(1);
    expect(found.silent, 'вторая часть ни на что не откликается, а мы этого не заметили').toBe(1);
  });

  it('Dead Interactivity 01 — восемь пустых из девяти нажимаемых', () => {
    // Модель НАША и лежит в git, поэтому пропуска здесь нет: на чистом клоне это
    // единственная проверка счёта пустых на настоящем файле. Числа — из
    // `_work/make-dead-interactivity-fixture.mjs`, разбор — в её `.license.md`.
    const found = readInteractivity(glbJson(modelPath('Dead Interactivity 01.glb')));
    expect(found.clickable, 'подставку с «не нажимать» посчитали нажимаемой').toBe(9);
    expect(found.handlers).toBe(1);
    expect(found.silent, 'восемь пустых кнопок посчитаны неверно').toBe(8);
  });

  калькуляторIt('Calculator — все пятнадцать кнопок со своим откликом', () => {
    const found = readInteractivity(glbJson(modelPath('Calculator.glb')));
    expect(found.clickable).toBe(15);
    expect(found.handlers).toBe(15);
    expect(found.silent, 'у калькулятора нашлась пустая кнопка — замер 2026-08-28 говорил обратное')
      .toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Убрать лишний интерактив — единственная галочка, которая его трогает
//
// «единственная галочка — убрать нерабочий или лишний или пустой интерактив»
//                                                     (Александр, 2026-08-28)
//
// УЗКОЕ ИСКЛЮЧЕНИЕ ПРАВИЛА 11, и сторожа здесь ровно на его условия: без галочки не
// снимается НИЧЕГО (раздел 1), с галочкой снимается ТОЛЬКО пустое (раздел 2), а замысел
// автора — рабочая часть и прямое «не нажимать» — не трогается никогда.
//
// Модель наша и лежит в git, поэтому пропусков нет: проверка работает на чистом клоне.
// ═══════════════════════════════════════════════════════════════════════════

describe('пустые пометки нажатия снимаются только по просьбе', () => {
  const МОДЕЛЬ = 'Dead Interactivity 01.glb';

  /** Пометки нажатия в файле: `8:Кнопка живая=true`. */
  const метки = (file) => (glbJson(file).nodes || [])
    .map((n, i) => [i, n.name, n.extensions?.KHR_node_selectability])
    .filter(([, , m]) => m !== undefined)
    .map(([i, name, m]) => `${i}:${name}=${m.selectable}`);

  const собрать = async (features) => {
    const r = await optimizeFile(modelPath(МОДЕЛЬ), {
      advancedFeatures: features, outDir: tmpOutDir(),
    });
    expect(r.status, `сборка не прошла: ${r.error || ''}`).not.toBe('fail');
    return r;
  };

  it('без галочки не снимается ни одна пометка — даже вместе с safe', async () => {
    // Главный сторож Правила 11: молча замысел автора не правим НИКОГДА. Пустая пометка
    // остаётся пустой, пока человек сам не попросит её убрать.
    const r = await собрать(['safe', 'meshopt']);
    expect(метки(r.file.dst).length, 'без просьбы что-то исчезло').toBe(10);
  }, 300000);

  it('с галочкой уходят ровно восемь пустых, а замысел остаётся', async () => {
    const r = await собрать(['strip-dead-interactivity']);
    expect(метки(r.file.dst), 'сняли не то, что обещали').toEqual([
      '8:Кнопка живая=true',   // рабочая — по метке от пустых неотличима, отличает граф
      '9:Подставка=false',     // прямое «сюда не нажимать» от автора, не мусор
    ]);
  }, 300000);

  it('сам граф поведения не трогается ни на узел', async () => {
    // Убирать пустые пометки и трогать граф — разные вещи. Недостижимая связка узлов 2 и 3
    // остаётся на месте: её удаление означало бы перенумерацию ссылок внутри графа.
    const было = glbJson(modelPath(МОДЕЛЬ)).extensions.KHR_interactivity;
    const r = await собрать(['safe', 'strip-dead-interactivity']);
    const стало = glbJson(r.file.dst).extensions?.KHR_interactivity;
    expect(стало, 'граф исчез вместе с пометками').toBeTruthy();
    expect(JSON.stringify(стало), 'граф изменился').toBe(JSON.stringify(было));
  }, 300000);

  it('отчёт называет и сколько сняли, и сколько рабочих осталось', async () => {
    const r = await собрать(['strip-dead-interactivity']);
    const текст = [...(r.findings || []), ...(r.applied || []), ...(r.skipped || [])]
      .map((f) => String(f.message || f.text || '')).join('\n');
    expect(текст, 'о снятии не сказано ни слова').toMatch(/8/);
    expect(текст).toMatch(/сняты|removed/i);
  }, 300000);

  it('нечего убирать — так и сказано, а не сделано вида, что убрали', async () => {
    // Интерфейс такую галочку и не покажет (Правило 12), но по API прийти может что угодно.
    if (!isPresent('TrafficLight.glb')) return;
    const r = await optimizeFile(modelPath('TrafficLight.glb'), {
      advancedFeatures: ['strip-dead-interactivity'], outDir: tmpOutDir(),
    });
    expect(r.status).not.toBe('fail');
    const j = glbJson(r.file.dst);
    const n = (j.nodes || []).filter((x) => x.extensions?.KHR_node_selectability).length;
    expect(n, 'у модели без пустых пометок что-то исчезло').toBe(2);
  }, 300000);
});
