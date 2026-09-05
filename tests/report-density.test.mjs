import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import { modelPath, eachModel } from './helpers/model-files.mjs';
import { densityViolations, DENSITY_LIMIT } from './helpers/report-density.mjs';


const DENSITY_CORPUS = [
  'ABeautifulGame.glb',
  'AnimationPointerUVs.glb',
  'AnisotropyBarnLamp.glb',
  'CarConcept.glb',
  'ChronographWatch.glb',
  'CommercialRefrigerator.glb',
  'DiffuseTransmissionPlant.glb',
  'DiffuseTransmissionTeacup.glb',
  'IridescenceLamp.glb',
  'IridescentDishWithOlives.glb',
  'MosquitoInAmber.glb',
  'PotOfCoalsAnimationPointer.glb',
  'SheenWoodLeatherSofa.glb',
  'SpecularSilkPouf.glb',
  'SunglassesKhronos.glb',
  'ToyCar.glb',
  'Dirty Cube 01.glb',
  'Instance Grid 01.glb',
  'Morph Cube 01.glb',
  'Vertex Colors 01.glb',
  'Draco Compressed Input 01.glb',
  'Meshopt Compressed Input 01.glb',
  'Cthulhu Stone 01.glb',
  'Lilith Character 01.glb',
  'BoomBox.glb',
  'chibi_zenitsu.glb',
  'Production Many Materials 01.glb',
  'Linked Duplicates Grid 01.glb',
];

const DENSITY_FLAG_SETS = [
  ['safe'],
  ['webp'],
  ['safe', 'webp'],
  ['safe', 'join', 'instance'],
  ['safe', 'quantize'],
];



describe('Report density — сторож повторов одинаковых messageId (Правило 9)', () => {
  for (const flags of DENSITY_FLAG_SETS) {
    eachModel(`плотность отчёта ≤${DENSITY_LIMIT} (флаги: [${flags.join(', ')}])`, DENSITY_CORPUS, async (name) => {
      const result = await optimizeFile(modelPath(name), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });

      const violations = densityViolations(result);
      const detail = violations
        .map(([id, n]) => `${id} ×${n}`)
        .join(', ');
      expect(violations, `модель: ${name} · флаги: [${flags.join(', ')}] · повторы: ${detail}`).toEqual([]);
    });
  }

  it(`${DENSITY_CORPUS.length} моделей × ${DENSITY_FLAG_SETS.length} набора флагов — сторож работает`, () => {
    expect(DENSITY_CORPUS.length).toBeGreaterThan(0);
    expect(DENSITY_FLAG_SETS.length).toBeGreaterThan(0);
  });

  it('сторож видит повторы и в validation-секции', () => {
    const fake = {
      applied: [{ ruleId: 'x', i18n: { text: { messageId: 'rule.one' } } }],
      skipped: [],
      findings: [],
      validation: [
        { level: 'pass', text: '1', i18n: { text: { messageId: 'check.same' } } },
        { level: 'pass', text: '2', i18n: { text: { messageId: 'check.same' } } },
        { level: 'pass', text: '3', i18n: { text: { messageId: 'check.same' } } },
        { level: 'pass', text: '4', i18n: { text: { messageId: 'check.same' } } },
      ],
    };
    expect(densityViolations(fake)).toContainEqual(['check.same', 4]);
  });

  it('три однотипные строки validation — не нарушение (cap движка = порог)', () => {
    const fake = {
      applied: [],
      skipped: [],
      findings: [],
      validation: [1, 2, 3].map((n) => ({ level: 'info', text: `${n}`, i18n: { text: { messageId: 'check.validatorExample' } } })),
    };
    expect(densityViolations(fake)).toEqual([]);
  });
});

afterAll(cleanupTmpOutDirs);
