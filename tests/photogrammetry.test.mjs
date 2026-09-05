import { it, expect, afterAll } from 'vitest';

import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { modelPath, describeIfModels } from './helpers/model-files.mjs';

const MODEL = 'stone_well_photogrammetry.glb';

afterAll(cleanupTmpOutDirs);

const run = (features) => optimizeFile(modelPath(MODEL), {
  outDir: tmpOutDir(),
  advancedFeatures: features,
  dryRun: true,
  locale: 'ru',
});

describeIfModels([MODEL], 'фотограмметрия переживает конвейер', () => {
  it('safe: треугольники, уровни детализации и текстуры на месте', async () => {
    const res = await run(['safe']);
    expect(res.status).toBe('ok');

    const { before, after } = res.metrics;

    expect(after.triangles, 'треугольники скана изменились').toBe(before.triangles);

    expect(after.meshes, 'мешей стало меньше — уровни детализации выкосили').toBe(before.meshes);

    expect(after.textures, 'текстуры пропали').toBe(before.textures);

    expect(res.validation.some((v) => v.level === 'fail'), 'проверка целостности дала отказ').toBe(false);
  }, 180_000);

  it('safe убирает только то, чего не касается ни один материал', async () => {
    const res = await run(['safe']);
    expect(res.metrics.before.attributes).toContain('TEXCOORD_1');
    expect(res.metrics.after.attributes, 'убрали используемую развёртку').toContain('TEXCOORD_0');
    expect(res.metrics.after.attributes, 'неиспользуемая развёртка осталась').not.toContain('TEXCOORD_1');
    expect(res.metrics.after.attributes, 'потеряли позиции или нормали').toContain('POSITION');
  }, 180_000);

  it('draco: сжатие не трогает ни треугольники, ни уровни детализации', async () => {
    const res = await run(['safe', 'draco']);
    expect(res.status).toBe('ok');
    expect(res.metrics.after.triangles).toBe(res.metrics.before.triangles);
    expect(res.metrics.after.meshes).toBe(res.metrics.before.meshes);
    expect(res.metrics.after.fileBytes, 'сжатие не уменьшило файл').toBeLessThan(res.metrics.before.fileBytes);
  }, 300_000);
});
