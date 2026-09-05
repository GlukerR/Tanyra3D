import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';

import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

const MODELS = ['CarConcept.glb', 'ChronographWatch.glb'];

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

afterAll(cleanupTmpOutDirs);

describeIfModels(MODELS, 'варианты материала переживают оптимизации', () => {
  for (const model of MODELS) {
    describe(model, () => {
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
          expect(after.prims, 'примитивы с переключением исчезли — выбор цвета мёртв').toBe(source().prims);
          expect(after.mappings, 'привязки вариантов исчезли — выбор цвета мёртв').toBe(source().mappings);
        }, 180_000);
      }

      it('[safe+join] человеку сказано, что меши оставлены ради вариантов', async () => {
        const r = await optimizeFile(modelPath(model), {
          advancedFeatures: ['safe', 'join'],
          outDir: tmpOutDir(),
        });
        const ru = localizeResult(r, 'ru');
        const en = localizeResult(r, 'en');
        expect(ru.skipped.some((e) => /вариант/i.test(e.text || '')),
          'в русском отчёте нет строки про варианты').toBe(true);
        expect(en.skipped.some((e) => /variant/i.test(e.text || '')),
          'в английском отчёте нет строки про варианты').toBe(true);
        expect(ru.skipped.filter((e) => /вариант/i.test(e.text || '')).length).toBe(1);
      }, 180_000);
    });
  }
});
