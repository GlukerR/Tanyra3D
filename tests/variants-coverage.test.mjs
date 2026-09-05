import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';

import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { localizeResult } from '../core/i18n.mjs';
import { RULES } from '../addons/gltf/rules.mjs';
import { TOKTX, HAS_GLTF_CLI } from '../addons/gltf/tools.mjs';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

const MODELS = ['CarConcept.glb', 'ChronographWatch.glb'];
const NO_VARIANT_MODEL = 'Dirty Cube 01.glb';

const RULES_FEATURES = [...new Set(RULES.map((r) => r.meta.feature).filter(Boolean))];
const SINGLE_FEATURES = [...new Set([...RULES_FEATURES.filter((f) => f !== 'join'), 'draco', 'resize-1024'])];
const FLAG_SETS = [
  ...SINGLE_FEATURES.map((f) => ['safe', f]),
  ['safe', 'instance', 'join'],
];

const TOKTX_OK = Boolean(TOKTX && HAS_GLTF_CLI);

afterAll(cleanupTmpOutDirs);

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

describeIfModels(MODELS, 'варианты материала переживают остальные галочки', () => {
  for (const model of MODELS) {
    describe(model, () => {
      let cached = null;
      const source = () => (cached ||= variantState(glbJson(modelPath(model))));

      it('в исходнике есть и имена вариантов, и привязки на примитивах', () => {
        expect(source().names.length, 'модель выбрана за варианты — их нет').toBeGreaterThan(0);
        expect(source().mappings, 'привязок на примитивах нет — проверять нечего').toBeGreaterThan(0);
      });

      for (const flags of FLAG_SETS) {
        const needsToktx = flags.includes('ktx2') && !TOKTX_OK;
        const label = `[${flags.join('+')}] привязки целы`;
        const body = async () => {
          const r = await optimizeFile(modelPath(model), {
            advancedFeatures: flags,
            outDir: tmpOutDir(),
          });
          expect(r.status).toBe('ok');
          const dst = r.file?.dst;
          expect(dst && fs.existsSync(dst), 'файл не записан').toBe(true);

          const after = variantState(glbJson(dst));
          expect(after.names, 'имена вариантов изменились').toEqual(source().names);
          expect(after.prims, 'примитивы с переключением исчезли — выбор мёртв').toBe(source().prims);
          expect(after.mappings, 'привязки вариантов исчезли — выбор мёртв').toBe(source().mappings);
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

describeIfModels(MODELS, 'варианты переживают двойной прогон — итог сверяется с первоначальным файлом', () => {
  for (const model of MODELS) {
    it(`${model} — [safe+join] дважды, привязки равны ВХОДУ`, async () => {
      const before = variantState(glbJson(modelPath(model)));

      const r1 = await optimizeFile(modelPath(model), {
        advancedFeatures: ['safe', 'join'],
        outDir: tmpOutDir(),
      });
      expect(r1.status).toBe('ok');
      expect(r1.file?.dst && fs.existsSync(r1.file.dst), 'первый прогон не записал файл').toBe(true);

      const r2 = await optimizeFile(r1.file.dst, {
        advancedFeatures: ['safe', 'join'],
        outDir: tmpOutDir(),
      });
      expect(r2.status).toBe('ok');
      expect(r2.file?.dst && fs.existsSync(r2.file.dst), 'второй прогон не записал файл').toBe(true);

      const after = variantState(glbJson(r2.file.dst));
      expect(after.names, 'имена вариантов изменились после двух прогонов').toEqual(before.names);
      expect(after.prims).toBe(before.prims);
      expect(after.mappings).toBe(before.mappings);
    }, 180_000);
  }
});

describeIfModels(MODELS, 'отчёт человеку: ровно одна строка join.keptVariants', () => {
  for (const model of MODELS) {
    it(`${model} — [safe+join]: одна строка, переживает смену языка без пересборки`, async () => {
      const r = await optimizeFile(modelPath(model), {
        advancedFeatures: ['safe', 'join'],
        outDir: tmpOutDir(),
      });
      const ru = localizeResult(r, 'ru');
      const en = localizeResult(r, 'en');
      const ruLines = ru.skipped.filter((e) => e.i18n?.text?.messageId === 'join.keptVariants');
      const enLines = en.skipped.filter((e) => e.i18n?.text?.messageId === 'join.keptVariants');
      expect(ruLines.length, 'в русском отчёте строка размножилась по мешам или пропала').toBe(1);
      expect(enLines.length, 'в английском отчёте строка размножилась по мешам или пропала').toBe(1);
    }, 180_000);
  }

  it('модель без вариантов — строки join.keptVariants нет вовсе', async () => {
    const r = await optimizeFile(modelPath(NO_VARIANT_MODEL), {
      advancedFeatures: ['safe', 'join'],
      outDir: tmpOutDir(),
    });
    const ru = localizeResult(r, 'ru');
    const en = localizeResult(r, 'en');
    expect(ru.skipped.some((e) => e.i18n?.text?.messageId === 'join.keptVariants'),
      'строка про варианты появилась на модели без вариантов').toBe(false);
    expect(en.skipped.some((e) => e.i18n?.text?.messageId === 'join.keptVariants'),
      'строка про варианты появилась на модели без вариантов').toBe(false);
  }, 180_000);
});
