// tests/photogrammetry.test.mjs — 3D-скан переживает конвейер целиком.
//
// ПОВОД (Александр, 2026-08-22): «наше приложение не убьёт 3д скан? мне кажется мы
// рановато его подключили». Вопрос был про PLY, но касается всякой сканированной
// геометрии: у неё сотни тысяч треугольников, часто раскраска вершин вместо текстур, и
// уровни детализации, которые автор делал руками.
//
// До этой модели в корпусе не было НИ ОДНОЙ фотограмметрии, и ответить можно было только
// рассуждением: «правила упрощения сетки у нас нет, значит не убьём». Рассуждение верное,
// но проверял его никто.
//
// Модель локальная (Sketchfab, CC-BY-4.0, автор Gorgious) — в репозиторий бинарник не
// идёт по правилу из `fixtures/.gitignore`, поэтому на свежем клоне блок пропускается, а
// не падает. Происхождение и замеры — в `fixtures/models/stone_well_photogrammetry.license.md`.
//
// ЧТО ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ: сырой выход сканера. Эта модель уже обработана — развёртка,
// текстуры, уровни детализации, собрано в glTF. Сырой скан (обычно `.ply` с раскраской
// вершин и без развёртки) в корпусе по-прежнему не представлен.

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

    // Главное обещание. Правила упрощения сетки в проекте нет и, по Правилу 11, не будет:
    // сколько треугольников автор наснимал, столько и довозим.
    expect(after.triangles, 'треугольники скана изменились').toBe(before.triangles);

    // Уровни детализации — замысел автора, а не мусор экспорта. Их шесть, и предлагать
    // «оставить один» мы не будем: Александр 2026-08-15 закрыл эту тему прямо
    // («новые функции всё больше начинают напоминать блендер»).
    expect(after.meshes, 'мешей стало меньше — уровни детализации выкосили').toBe(before.meshes);

    // Картинки скана — это и есть его вид. Без выбранного пережатия их число не меняется.
    expect(after.textures, 'текстуры пропали').toBe(before.textures);

    // Габариты не поехали.
    expect(res.validation.some((v) => v.level === 'fail'), 'проверка целостности дала отказ').toBe(false);
  }, 180_000);

  it('safe убирает только то, чего не касается ни один материал', async () => {
    // У модели ДВЕ развёртки, а материалы пользуются одной. Вторую мы убираем — это не
    // замысел, а след экспорта. Проверяем, что убрали именно её, а не первую: перепутать
    // здесь значит испортить вид, и заметить это по числам будет уже нельзя.
    const res = await run(['safe']);
    expect(res.metrics.before.attributes).toContain('TEXCOORD_1');
    expect(res.metrics.after.attributes, 'убрали используемую развёртку').toContain('TEXCOORD_0');
    expect(res.metrics.after.attributes, 'неиспользуемая развёртка осталась').not.toContain('TEXCOORD_1');
    expect(res.metrics.after.attributes, 'потеряли позиции или нормали').toContain('POSITION');
  }, 180_000);

  it('draco: сжатие не трогает ни треугольники, ни уровни детализации', async () => {
    // Квантование Draco на скане заметнее, чем на модели из САПР: у скана точки стоят
    // плотно. Но топологию оно не трогает, и это проверяемо.
    const res = await run(['safe', 'draco']);
    expect(res.status).toBe('ok');
    expect(res.metrics.after.triangles).toBe(res.metrics.before.triangles);
    expect(res.metrics.after.meshes).toBe(res.metrics.before.meshes);
    expect(res.metrics.after.fileBytes, 'сжатие не уменьшило файл').toBeLessThan(res.metrics.before.fileBytes);
  }, 300_000);
});
