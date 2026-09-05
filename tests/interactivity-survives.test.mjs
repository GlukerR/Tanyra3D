import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';

import { localizeResult } from '../core/i18n.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { readInteractivity } from '../addons/gltf/interactivity.mjs';
import { modelPath, isPresent, itIfModel } from './helpers/model-files.mjs';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

afterAll(cleanupTmpOutDirs);

const MODELS = [
  ['TrafficLight.glb', 'указатели в materials'],
  ['Calculator.glb', 'указатели и в nodes, и в materials; узлы дописываются 23 → 24'],
  ['WhackAMole.glb', 'семь KHR_node_selectability без единого числа; узлы 68 → 82'],
  ['MagicBall.glb', 'двадцать два указателя в nodes'],
  ['ConstructionSite.glb', 'самая тяжёлая, 6.8 МБ'],
];

function glbJson(file) {
  const buf = fs.readFileSync(file);
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
}

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

describe('нажимаемые части без отклика видны в отчёте', () => {
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
    const found = readInteractivity(glbJson(modelPath('Dead Interactivity 01.glb')));
    expect(found.clickable, 'подставку с «не нажимать» посчитали нажимаемой').toBe(9);
    expect(found.handlers).toBe(1);
    expect(found.silent, 'восемь пустых кнопок посчитаны неверно').toBe(8);
  });

  itIfModel('Calculator.glb', 'все пятнадцать кнопок со своим откликом', () => {
    const found = readInteractivity(glbJson(modelPath('Calculator.glb')));
    expect(found.clickable).toBe(15);
    expect(found.handlers).toBe(15);
    expect(found.silent, 'у калькулятора нашлась пустая кнопка — замер 2026-08-28 говорил обратное')
      .toBe(0);
  });
});

describe('пустые пометки нажатия снимаются только по просьбе', () => {
  const МОДЕЛЬ = 'Dead Interactivity 01.glb';

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
    const r = await собрать(['safe', 'meshopt']);
    expect(метки(r.file.dst).length, 'без просьбы что-то исчезло').toBe(10);
  }, 300000);

  it('с галочкой уходят ровно восемь пустых, а замысел остаётся', async () => {
    const r = await собрать(['strip-dead-interactivity']);
    expect(метки(r.file.dst), 'сняли не то, что обещали').toEqual([
      '8:Кнопка живая=true',
      '9:Подставка=false',
    ]);
  }, 300000);

  it('сам граф поведения не трогается ни на узел', async () => {
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

  itIfModel('TrafficLight.glb', 'нечего убирать — так и сказано, а не сделано вида, что убрали', async () => {
    const r = await optimizeFile(modelPath('TrafficLight.glb'), {
      advancedFeatures: ['strip-dead-interactivity'], outDir: tmpOutDir(),
    });
    expect(r.status).not.toBe('fail');
    const j = glbJson(r.file.dst);
    const n = (j.nodes || []).filter((x) => x.extensions?.KHR_node_selectability).length;
    expect(n, 'у модели без пустых пометок что-то исчезло').toBe(2);
  }, 300000);
});

describe('правило scene/interactivity доходит до отчёта', () => {
  const МОДЕЛЬ = 'Dead Interactivity 01.glb';

  const находки = async (model, features = []) => {
    const r = await optimizeFile(modelPath(model), {
      advancedFeatures: features, outDir: tmpOutDir(), locale: 'ru',
    });
    expect(r.status, `сборка не прошла: ${r.error || ''}`).not.toBe('fail');
    return (r.findings || []).filter((f) => f.ruleId === 'scene/interactivity');
  };

  it('на модели с интерактивом правило называет числа', async () => {
    const found = await находки(МОДЕЛЬ);
    const main = found.find((f) => f.i18n?.text?.messageId === 'interactivity.found');
    expect(main, 'правило не положило в отчёт ни одной находки').toBeTruthy();
    expect(main.i18n.text.data).toEqual({ clickable: 9, handlers: 1, actions: 3 });
    expect(main.severity, 'наблюдение, а не дефект').toBe('info');
  }, 300000);

  it('отдельной строкой сказано, сколько частей без отклика', async () => {
    const found = await находки(МОДЕЛЬ);
    const silent = found.find((f) => f.i18n?.text?.messageId === 'interactivity.silentParts');
    expect(silent, 'про пустые нажимаемые части в отчёте ни слова').toBeTruthy();
    expect(silent.i18n.text.data).toEqual({ n: 8 });
  }, 300000);

  it('строки переживают перевод и не остаются ключами', async () => {
    const r = await optimizeFile(modelPath(МОДЕЛЬ), {
      advancedFeatures: [], outDir: tmpOutDir(), locale: 'ru',
    });
    for (const язык of ['ru', 'en']) {
      const текст = localizeResult(r, язык).findings
        .filter((f) => f.ruleId === 'scene/interactivity')
        .map((f) => f.text || '');
      expect(текст.length, `на языке ${язык} находок не осталось`).toBe(2);
      for (const t of текст) {
        expect(t, `на языке ${язык} в отчёт попал ключ, а не фраза`).not.toMatch(/^interactivity\./);
        expect(t.length, `на языке ${язык} пустая строка`).toBeGreaterThan(20);
      }
    }
  }, 300000);

  it('у модели без интерактива правило молчит', async () => {
    const found = await находки('Dirty Cube 01.glb');
    expect(found, 'правило заговорило о модели, где интерактива нет').toEqual([]);
  }, 300000);
});
