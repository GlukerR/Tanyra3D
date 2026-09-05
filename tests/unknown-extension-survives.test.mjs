import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optimizeFile } from '../optimize2.mjs';
import { arraysAddressedBy } from '../addons/gltf/carry.mjs';
import { modelPath, eachModel } from './helpers/model-files.mjs';

const МОДЕЛИ = [
  'Unknown Ext Interactivity 01.glb',
  'Unknown Ext LOD 01.glb',
  'Unknown Ext Pointer 01.glb',
];

const мусор = [];
afterAll(() => { for (const d of мусор) fs.rmSync(d, { recursive: true, force: true }); });

function jsonOf(file) {
  const b = fs.readFileSync(file);
  return JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString('utf8'));
}

function extensionBodies(json) {
  const found = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (k === 'extensions' && val && typeof val === 'object') {
        for (const [имя, тело] of Object.entries(val)) {
          if (!found.has(имя)) found.set(имя, []);
          found.get(имя).push(JSON.stringify(тело));
        }
      }
      walk(val);
    }
  };
  walk(json);
  for (const [имя, список] of found) found.set(имя, список.sort());
  return found;
}

async function собрать(model, advancedFeatures) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'unk-ext-'));
  мусор.push(out);
  const r = await optimizeFile(modelPath(model), { outDir: out, advancedFeatures, dryRun: false, force: true });
  return { r, json: jsonOf(r.file.dst) };
}

describe('1. тело незнакомого расширения доезжает целым', () => {
  eachModel('объявление и тело доезжают', МОДЕЛИ, async (model) => {
    const исходник = jsonOf(modelPath(model));
    const объявлено = исходник.extensionsUsed || [];
    expect(объявлено.length, `${model}: в исходнике нет ни одного расширения — заготовка не та`)
      .toBeGreaterThan(0);
    const было = extensionBodies(исходник);

    const { json } = await собрать(model, ['safe']);
    for (const имя of объявлено) {
      expect(json.extensionsUsed || [], `${model}: объявление ${имя} потеряно`).toContain(имя);
    }

    const стало = extensionBodies(json);
    for (const [имя, тела] of было) {
      expect(стало.has(имя), `${model}: расширение ${имя} исчезло целиком`).toBe(true);
      expect(стало.get(имя).length,
        `${model}: тел ${имя} было ${тела.length}, стало ${стало.get(имя).length} — часть потеряна`)
        .toBe(тела.length);
      expect(стало.get(имя).join('\n'), `${model}: тело ${имя} изменилось`).toBe(тела.join('\n'));
    }
  }, 120000);
});

describe('2. манифест не расходится с содержимым', () => {
  eachModel('имя есть тогда и только тогда, когда есть тело', МОДЕЛИ, async (model) => {
    const { json } = await собрать(model, ['safe']);
    const тела = new Set(extensionBodies(json).keys());
    for (const имя of json.extensionsUsed || []) {
      if (!тела.has(имя)) continue;
      expect(тела.has(имя), `${model}: ${имя} назван в extensionsUsed, а тела нет`).toBe(true);
    }
    for (const имя of тела) {
      expect(json.extensionsUsed || [], `${model}: тело ${имя} есть, а в extensionsUsed его нет`)
        .toContain(имя);
    }
  }, 120000);
});

describe('3. человек узнаёт, что сварка пропущена и почему', () => {
  const НЕПРОЗРАЧНЫЕ = ['Unknown Ext Interactivity 01.glb', 'Unknown Ext LOD 01.glb'];

  eachModel('в отчёте есть запись про сварку с именем расширения', НЕПРОЗРАЧНЫЕ, async (model) => {
    const { r } = await собрать(model, ['safe']);
    const про = (r.skipped || []).filter((x) => x.ruleId === 'geometry/weld');
    expect(про.length, `${model}: сварка пропущена молча — в отчёте о ней ни слова`).toBe(1);
    const текст = JSON.stringify(про[0]);
    expect(текст, `${model}: запись про сварку не называет расширение`)
      .toMatch(/KHR_|MSFT_|EXT_/);
  }, 120000);
});

describe('4. прозрачное расширение сварке не мешает', () => {
  eachModel('AnimationPointerUVs варится и не теряет расширение', ['AnimationPointerUVs.glb'],
    async (model) => {
      const было = extensionBodies(jsonOf(modelPath(model)));
      const { r, json } = await собрать(model, ['safe']);
      expect(r.applied.some((a) => a.ruleId === 'geometry/weld'),
        'сварка отказалась там, где расширение видно насквозь — отказ стал слишком широким')
        .toBe(true);
      const стало = extensionBodies(json);
      for (const [имя, тела] of было) {
        expect(стало.get(имя) || [], `${имя}: тела потеряны при сварке`).toHaveLength(тела.length);
      }
    }, 180000);
});


describe('5. обе формы указателя видны, гадать не начинаем', () => {
  it('постоянный указатель сужает проверку до своего массива', () => {
    const at = arraysAddressedBy({ pointer: '/materials/0/pbrMetallicRoughness/baseColorFactor' });
    expect(at && [...at]).toEqual(['materials']);
  });

  it('шаблонный указатель KHR_interactivity — тоже', () => {
    const at = arraysAddressedBy({
      nodes: [{ type: 'pointer/set', configuration: { pointer: { value: ['/nodes/{myId}/scale'] } } }],
    });
    expect(at && [...at]).toEqual(['nodes']);
  });

  it('обе формы вместе дают оба массива', () => {
    const at = arraysAddressedBy({ a: '/animations/2/channels', b: '/nodes/{id}/translation' });
    expect(at && [...at].sort()).toEqual(['animations', 'nodes']);
  });

  it('тело без указателей остаётся НЕПРОЗРАЧНЫМ', () => {
    expect(arraysAddressedBy({ graphs: [{ nodes: [{ type: 'event/onStart' }] }], graph: 0 })).toBeNull();
  });

  it('ссылки числами (MSFT_lod) остаются НЕПРОЗРАЧНЫМИ', () => {
    expect(arraysAddressedBy({ ids: [3, 4] })).toBeNull();
  });
});
