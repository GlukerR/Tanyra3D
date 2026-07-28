// Parallel execution tests — проверка потокобезопасности optimizeFile.
//
// optimizeFile создаёт независимые ctx-объекты на каждый вызов, но делит
// один NodeIO-синглтон (getIO()) и глобальные инициализации кодеков
// (MeshoptEncoder, MeshoptDecoder, draco3d). Этот тест проверяет, что
// параллельные вызовы не пересекаются и каждый результат корректен.
//
// Проверяет:
// 1. Promise.all с 3 разными моделями — каждый возвращает свой status/metrics
// 2. Метрики после оптимизации принадлежат своей модели, не перепутаны
// 3. Одна модель (CarConcept) × 3 параллельно — все 3 результата идентичны
// 4. Разные advancedFeatures параллельно — ktx2, draco, empty — не влияют друг на друга
// 5. dryRun:false параллельно — записи не конфликтуют в output/

import { describe, it, expect, afterEach } from 'vitest';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function modelPath(name) {
  return path.resolve(PROJECT_ROOT, 'fixtures/models', name);
}

const TIMEOUT_PARALLEL = 120000; // параллельные запуски могут быть дольше

// ---- 3 разные модели параллельно ----

describe('Parallel — 3 different models', () => {
  it('Promise.all with safe+meshopt+join — all return ok with applied rules', async () => {
    const models = ['CarConcept.glb', 'ToyCar.glb', 'SpecularSilkPouf.glb'];

    const results = await Promise.all(
      models.map((name) =>
        optimizeFile(modelPath(name), {
          // Явные safe+meshopt+join — дают applied.length > 0 на любой модели
          // (даже на уже-чистых). Это «baseline», используемый для теста параллельности.
          advancedFeatures: ['safe', 'meshopt', 'join'],
          dryRun: true,
        }),
      ),
    );

    // Все три вернули ok
    for (let i = 0; i < models.length; i++) {
      expect(results[i].status).toBe('ok');
      expect(results[i].file.written).toBe(false);
      expect(results[i].metrics.before).not.toBeNull();
      expect(results[i].metrics.after).not.toBeNull();
      expect(results[i].applied.length).toBeGreaterThan(0);
    }
  }, TIMEOUT_PARALLEL);

  it('each model has distinct fileBytes before optimization', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('SpecularSilkPouf.glb'), { advancedFeatures: [], dryRun: true }),
    ]);

    // CarConcept — самая большая, SpecularSilkPouf — самая маленькая
    const carBytes = results[0].metrics.before.fileBytes;
    const toyBytes = results[1].metrics.before.fileBytes;
    const poufBytes = results[2].metrics.before.fileBytes;

    // Все три разные (у каждой модели свой размер)
    expect(carBytes).not.toBe(toyBytes);
    expect(carBytes).not.toBe(poufBytes);
    expect(toyBytes).not.toBe(poufBytes);

    // CarConcept больше SpecularSilkPouf (известные размеры)
    expect(carBytes).toBeGreaterThan(toyBytes);
    expect(toyBytes).toBeGreaterThan(poufBytes);
  }, TIMEOUT_PARALLEL);

  it('each model has distinct triangle counts — not mixed up', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('SpecularSilkPouf.glb'), { advancedFeatures: [], dryRun: true }),
    ]);

    // Каждая модель имеет своё количество треугольников (известные значения)
    const carTris = results[0].metrics.after.triangles;
    const toyTris = results[1].metrics.after.triangles;
    const poufTris = results[2].metrics.after.triangles;

    // Все разные, не перепутаны
    expect(carTris).not.toBe(toyTris);
    expect(carTris).not.toBe(poufTris);
    expect(toyTris).not.toBe(poufTris);

    // CarConcept — ~1.5M треугольников, ToyCar — ~60K, Pouf — ~700
    expect(carTris).toBeGreaterThan(100000);
    expect(toyTris).toBeGreaterThan(10000);
    expect(toyTris).toBeLessThan(carTris);
    expect(poufTris).toBeLessThan(toyTris);
    expect(poufTris).toBeGreaterThan(100);
  }, TIMEOUT_PARALLEL);

  it('each model has its own applied rules (counts differ)', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: ['safe', 'meshopt', 'join'], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { advancedFeatures: ['safe', 'meshopt', 'join'], dryRun: true }),
      optimizeFile(modelPath('SpecularSilkPouf.glb'), { advancedFeatures: ['safe', 'meshopt', 'join'], dryRun: true }),
    ]);

    // CarConcept — много мешей → больше applied правил (join, dedup, weld, meshopt)
    // ToyCar — меньше мешей → меньше правил
    // SpecularSilkPouf — совсем простая → минимум правил
    const carRules = results[0].applied.length;
    const toyRules = results[1].applied.length;
    const poufRules = results[2].applied.length;

    // CarConcept — самый сложный, больше всего правил
    expect(carRules).toBeGreaterThan(toyRules);
    expect(carRules).toBeGreaterThan(poufRules);

    // CarConcept — сложная модель: join + meshopt срабатывают (явные флаги в features)
    expect(results[0].applied.some((a) => a.ruleId === 'scene/join')).toBe(true);
    expect(results[0].applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);

    // У всех есть geometry/compress (явный флаг meshopt во всех трёх)
    for (const r of results) {
      expect(r.applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);
    }
  }, TIMEOUT_PARALLEL);

  it('metrics.before and metrics.after are distinct objects per call', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('SpecularSilkPouf.glb'), { advancedFeatures: [], dryRun: true }),
    ]);

    // Каждый result — самостоятельный объект, не ссылается на shared state
    for (const r of results) {
      expect(r.metrics.before).not.toBe(r.metrics.after); // разные объекты

      const requiredFields = [
        'fileBytes', 'drawCalls', 'triangles',
        'textureBytes', 'gpuBytes', 'meshes', 'materials',
        'textures', 'nodes', 'scenes', 'animations', 'skins',
        'bounds',
      ];
      for (const field of requiredFields) {
        expect(r.metrics.before).toHaveProperty(field);
        expect(r.metrics.after).toHaveProperty(field);
      }
    }
  }, TIMEOUT_PARALLEL);

  it('core invariant holds for all 3 models in parallel', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('SpecularSilkPouf.glb'), { advancedFeatures: [], dryRun: true }),
    ]);

    for (const r of results) {
      const delta = Math.abs(r.metrics.after.triangles - r.metrics.before.triangles);
      expect(delta).toBeLessThanOrEqual(10);
    }
  }, TIMEOUT_PARALLEL);
});

// ---- Одна модель × 3 параллельно — все результаты идентичны ----

describe('Parallel — same model x3', () => {
  it('3 parallel calls to CarConcept return identical metrics', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: true }),
    ]);

    // Все три ok
    for (const r of results) expect(r.status).toBe('ok');

    // fileBytes после оптимизации одинаковы (детерминированный пайплайн)
    const sizes = results.map((r) => r.metrics.after.fileBytes);
    expect(sizes[0]).toBe(sizes[1]);
    expect(sizes[1]).toBe(sizes[2]);

    // Треугольники одинаковы
    const tris = results.map((r) => r.metrics.after.triangles);
    expect(tris[0]).toBe(tris[1]);
    expect(tris[1]).toBe(tris[2]);

    // Количество applied правил одинаково
    const appliedCounts = results.map((r) => r.applied.length);
    expect(appliedCounts[0]).toBe(appliedCounts[1]);
    expect(appliedCounts[1]).toBe(appliedCounts[2]);

    // validation array length одинаков
    const valCounts = results.map((r) => r.validation.length);
    expect(valCounts[0]).toBe(valCounts[1]);
    expect(valCounts[1]).toBe(valCounts[2]);
  }, TIMEOUT_PARALLEL);

  it('3 parallel calls to ToyCar return identical applied ruleIds', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('ToyCar.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('ToyCar.glb'), { advancedFeatures: [], dryRun: true }),
    ]);

    // Все ruleId из applied совпадают между тремя вызовами
    const ruleIdSets = results.map((r) => r.applied.map((a) => a.ruleId).sort());
    expect(ruleIdSets[0]).toEqual(ruleIdSets[1]);
    expect(ruleIdSets[1]).toEqual(ruleIdSets[2]);
  }, TIMEOUT_PARALLEL);
});

// ---- Разные advancedFeatures параллельно ----

describe('Parallel — different features', () => {
  it('meshopt, draco, and strip-colors in parallel — all ok', async () => {
    const results = await Promise.all([
      // 'baseline' = явный meshopt (opt-in: никаких скрытых default-правил)
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: ['meshopt'], dryRun: true }),
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: ['draco'], dryRun: true }),
      // strip-colors alone: geometry/compress НЕ включается (opt-in!)
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: ['strip-colors'], dryRun: true }),
    ]);

    // Все три вернули ok
    for (const r of results) expect(r.status).toBe('ok');

    // Разные кодеки → разный fileBytes
    const sizes = results.map((r) => r.metrics.after.fileBytes);
    // Draco != meshopt
    expect(sizes[1]).not.toBe(sizes[0]);
    // strip-colors не меняет размер на CarConcept (нет COLOR_n) — просто regression-чек.

    // geometry/compress присутствует на meshopt и draco, но НЕ на strip-colors alone
    // (opt-in инвариант промпта: каждый кодек включается своим флагом).
    expect(results[0].applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);
    expect(results[1].applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);
    expect(results[2].applied.some((a) => a.ruleId === 'geometry/compress')).toBe(false);
  }, TIMEOUT_PARALLEL);

  it('default and ktx2 in parallel — ktx2 may fail gracefully, default always ok', async () => {
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: true }),
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: ['ktx2'], dryRun: true }),
    ]);

    // Default всегда ok
    expect(results[0].status).toBe('ok');

    // KTX2 может быть ok или fail (зависит от toktx и размера текстур)
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBeOneOf(['ok', 'fail']);

    // Треугольники сохранены в обоих случаях
    for (const r of results) {
      const delta = Math.abs(r.metrics.after.triangles - r.metrics.before.triangles);
      expect(delta).toBeLessThanOrEqual(10);
    }
  }, TIMEOUT_PARALLEL);
});

// ---- dryRun:false параллельно (запись в output/) ----

describe('Parallel — dryRun:false (write to output/)', () => {
  const OUT_DIR = path.resolve(PROJECT_ROOT, 'output');

  // Очищаем output/ после тестов
  afterEach(() => {
    if (fs.existsSync(OUT_DIR)) {
      for (const f of fs.readdirSync(OUT_DIR)) {
        if (f.endsWith('.glb') || f.endsWith('.report.md')) {
          try { fs.rmSync(path.join(OUT_DIR, f)); } catch { /* занят — не критично */ }
        }
      }
    }
  });

  it('3 models write to output/ in parallel without file conflicts', async () => {
    const models = ['CarConcept.glb', 'ToyCar.glb', 'SpecularSilkPouf.glb'];

    const results = await Promise.all(
      models.map((name) =>
        optimizeFile(modelPath(name), {
          advancedFeatures: [],
          dryRun: false,
          force: true,
        }),
      ),
    );

    // Все записались
    for (let i = 0; i < models.length; i++) {
      expect(results[i].status).toBe('ok');
      expect(results[i].file.written).toBe(true);
      expect(results[i].file.dst).toContain('output');
    }

    // Файлы реально существуют на диске
    for (const name of ['CarConcept.glb', 'ToyCar.glb', 'SpecularSilkPouf.glb']) {
      const dst = path.join(OUT_DIR, name);
      expect(fs.existsSync(dst)).toBe(true);
      expect(fs.statSync(dst).size).toBeGreaterThan(0);
    }

    // report.md созданы
    for (const name of ['CarConcept.report.md', 'ToyCar.report.md', 'SpecularSilkPouf.report.md']) {
      const reportPath = path.join(OUT_DIR, name);
      expect(fs.existsSync(reportPath)).toBe(true);
      expect(fs.statSync(reportPath).size).toBeGreaterThan(0);
    }
  }, TIMEOUT_PARALLEL);

  it('same model written twice in parallel — force:true avoids skip conflict', async () => {
    // Два параллельных вызова одной модели — оба с force:true
    const results = await Promise.all([
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: false, force: true }),
      optimizeFile(modelPath('CarConcept.glb'), { advancedFeatures: [], dryRun: false, force: true }),
    ]);

    // Оба должны быть ok (force перезаписывает)
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('ok');
    expect(results[0].file.written).toBe(true);
    expect(results[1].file.written).toBe(true);
  }, TIMEOUT_PARALLEL);
});
