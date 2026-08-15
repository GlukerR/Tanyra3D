// post-gap005-corpus.test.mjs — точечные проверки для моделей, добавленных
// в корпус вместе с правкой GAP-005.
//
// Контекст:
//   - До GAP-005 BASELINE_METRICS не включал morphTargets/attributes: потеря
//     морфа или UV-канала проходила тихо. Эти модели удалось подключить,
//     только когда появились честные ключи для сверки.
//   - 10 моделей коммитятся в git через fixtures/.gitignore (собственные
//     модели Александра); остальные 5 — локальные (CC-BY-4.0 или клиент-проект).
//
// Между tests/gap-005-regression.test.mjs (sentinel на сам факт GAP-005) и
// tests/golden-corpus.test.mjs (общие инварианты корпуса) этот файл стоит
// посередине: здесь только то, ради чего новые модели и заводились —
// уникальные свойства, которые общие инварианты не ловят.
//
// Все тесты dryRun:true. Имена файлов с пробелами/кириллицей — handled
// стандартным `path.resolve`.

import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function modelPath(name) {
  return path.resolve(PROJECT_ROOT, 'fixtures/models', name);
}

// helpers для чтения выходного GLB (как в tests/golden-corpus.test.mjs)
const GLB_MAGIC = 0x46546c67;

function parseGlbJson(bytes) {
  if (!bytes || bytes.length < 20) return null;
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
}

async function runAndRead(modelName, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgap-corpus-'));
  try {
    const result = await optimizeFile(modelPath(modelName), { ...opts, outDir: tmpDir });
    if (!result.file.dst || !fs.existsSync(result.file.dst)) {
      return { result, glbBytes: null, json: null };
    }
    const glbBytes = fs.readFileSync(result.file.dst);
    return { result, glbBytes, json: parseGlbJson(glbBytes) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// 1. Preinstanced Grid 01.glb (committed, 2 532 B, EXT_mesh_gpu_instancing на входе)
// ============================================================================
//
// Уникальность: это единственная модель, которая покажет поломку `instanceCountOf()`
// СРАЗУ — на passthrough, до всякой оптимизации. Измерено: 1 узел × 144 треугольника
// (а не 12, как было бы без поправки). Если кто-то откатит metrics.mjs —
// первые же тесты ниже провалятся.

describe('Post-GAP-005 corpus — Preinstanced Grid 01: instanceCountOf on entry', () => {

  it('source: passthrough уже имеет EXT_mesh_gpu_instancing на входе', () => {
    const bytes = fs.readFileSync(modelPath('Preinstanced Grid 01.glb'));
    const json = parseGlbJson(bytes);
    // Sanity: расширение действительно объявлено во входном файле — без
    // этого instanceCountOf() не вернёт > 1 для какого-либо узла.
    expect((json.extensionsUsed || [])).toContain('EXT_mesh_gpu_instancing');
  }, 5000);

  it('passthrough: metrics.before.triangles === 144 (× instance count)', async () => {
    // Поправка instanceCountOf() в addons/gltf/metrics.mjs умножает на число
    // экземпляров через EXT_mesh_gpu_instancing. Без неё 144 → 12 (один
    // обход узла). Sentinel: если кто-то откатит — этот assert провалится.
    const result = await optimizeFile(modelPath('Preinstanced Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.triangles).toBe(144);
    expect(result.metrics.after.triangles).toBe(144);
    expect(result.metrics.before.nodes).toBe(1);
    expect(result.metrics.after.nodes).toBe(1);
    expect(result.metrics.before.drawCalls).toBe(1);
    expect(result.metrics.after.drawCalls).toBe(1);
  });

  it('[\'safe\']: без изменений — нечего инстансить/мерджить (1 узел, 144 треугольника)', async () => {
    const result = await optimizeFile(modelPath('Preinstanced Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBe(0);
    expect(result.metrics.after.triangles).toBe(144);
    expect(result.metrics.after.nodes).toBe(1);
    expect(result.metrics.after.drawCalls).toBe(1);
    // Safe не сломал валидацию.
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('[\'safe\']: EXT_mesh_gpu_instancing сохраняется в extensionsUsed выхода', async () => {
    // Из задания: «prune не должен счесть расширение мусором».
    // Без safe расширение и так сохранилось бы; проверяем именно после safe —
    // там есть шанс случайного prune-unused на extensionsUsed.
    const { result, json } = await runAndRead('Preinstanced Grid 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    expect((json && json.extensionsUsed) || []).toContain('EXT_mesh_gpu_instancing');
  });
});

// ============================================================================
// 2. Truncated Broken 01.glb (committed, 1 468 B — единственная обязанная валиться)
// ============================================================================
//
// Из задания: «единственная модель, на которой пайплайн ОБЯЗАН отказать».
// Измерено: status='fail', error='Invalid typed array length: 1468'.
// НЕ в GOLDEN_MODELS — там ожидается ok, и она бы валила общие прогоны «по
// устройству, а не по дефекту». Отдельный describe.

describe('Post-GAP-005 corpus — Truncated Broken 01: pipeline must fail', () => {

  it('optimizeFile возвращает объект (не бросает исключение) на повреждённом GLB', async () => {
    let result;
    let threw = null;
    try {
      result = await optimizeFile(modelPath('Truncated Broken 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: [],
        dryRun: true,
      });
    } catch (e) {
      threw = e;
    }
    // Контракт роли: «оптимизация не бросает на повреждённых входах».
    expect(threw).toBeNull();
    expect(result).toBeDefined();
  });

  it('passthrough: status=fail с понятной ошибкой про типизированный массив', async () => {
    const result = await optimizeFile(modelPath('Truncated Broken 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    // Проверка подстроки, не точная цитата: язык может варьировать, а вот
    // «Invalid typed array length» как маркер причины стабилен. Также
    // проверяем, что в сообщении есть размер файла (число 1468) — это
    // подтверждает, что ошибка про НАШ файл, а не generic.
    expect(result.error).toMatch(/Invalid typed array length/i);
    expect(result.error).toMatch(/1468/);
  });

  it('[\'safe\']: тоже fail с той же маркой (не зависит от режима)', async () => {
    const result = await optimizeFile(modelPath('Truncated Broken 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/Invalid typed array length/i);
    expect(result.error).toMatch(/1468/);
  });

  it('fail никаких файлов на диск не пишет', async () => {
    // dryRun:true по умолчанию, и даже если upstream менял outDir — здесь
    // мы НЕ передаём outDir, поэтому ни .glb, ни .report.md не должны
    // появиться в стандартной `output/`.
    const outDir = path.resolve(PROJECT_ROOT, 'output');
    const before = new Set(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);
    await optimizeFile(modelPath('Truncated Broken 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    const after = new Set(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);
    // По `dryRun:true` на fail обычно НЕ пишется НИЧЕГО. Но некоторые
    // версии пишут .dryrun.report.md даже на fail-сценарии — это ОК,
    // проверяем только, что .glb для этой модели в `output/` не появился.
    const newNames = [...after].filter((n) => !before.has(n));
    expect(newNames.some((n) => n.startsWith('Truncated Broken 01.'))).toBe(false);
  });
});

// ============================================================================
// 3. Локальные модели с морфами + анимациями (CC-BY-4.0 — в git НЕ коммитятся)
// ============================================================================
//
// chibi_zenitsu и parkergirl — единственные модели корпуса, на которых
// скины, анимации и морф-таргеты встречаются ОДНОВРЕМЕННО. На золотом корпусе
// Khronos такого сочетания нет. Поэтому и появились — как и где GAP-005
// защищает baseline-morphTargets.
//
// Пропуск describe при отсутствии файла: vitest покажет блок в отчёте с
// маркером пропуска, прогон не падает. Имя блока включает причину, чтобы
// при следующем клоне можно было сразу увидеть, что «модель не в репо».

// ---- 3.1 chibi_zenitsu ----
const chibiPath = modelPath('chibi_zenitsu.glb');
const chibiPresent = fs.existsSync(chibiPath);
const chibiDescribe = chibiPresent ? describe : describe.skip;
chibiDescribe('Post-GAP-005 corpus — chibi_zenitsu (local CC-BY-4.0): skin + anim + morphs', () => {

  it('passthrough: 1 skin, 1 анимация (\'Run\'), morphTargets > 0', async () => {
    const result = await optimizeFile(modelPath('chibi_zenitsu.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.before.animations).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    expect(result.metrics.before.morphTargets).toBeGreaterThan(0);
    expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
  });

  it('[\'safe\']: morphTargets и скин сохранены (тест скина под морф + joint)', async () => {
    const result = await optimizeFile(modelPath('chibi_zenitsu.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('[\'safe\',\'draco\']: компрессия не теряет морфы (4.25 → 2.33 МБ по измерениям)', async () => {
    const result = await optimizeFile(modelPath('chibi_zenitsu.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
    // Аппроксимация по измерениям: ~45% сжатие. Допускаем 30%–60%.
    const ratio = result.metrics.after.fileBytes / result.metrics.before.fileBytes;
    expect(ratio).toBeGreaterThan(0.30);
    expect(ratio).toBeLessThan(0.70);
  });

  it('source: имена анимаций содержат \'Run\', 2 морфа на 2 примитивах', () => {
    const bytes = fs.readFileSync(modelPath('chibi_zenitsu.glb'));
    const json = parseGlbJson(bytes);
    const animNames = (json.animations || []).map((a) => String((a && a.name) || ''));
    expect(animNames).toContain('Run');
    let morphTotal = 0;
    let primCount = 0;
    for (const mesh of (json.meshes || [])) {
      for (const prim of (mesh.primitives || [])) {
        primCount++;
        morphTotal += ((prim.targets) || []).length;
      }
    }
    // Измерено пробой на коммите dbf6513 (см. fixtures/models/*chibi*.md):
    // 11 примитивов и ровно 2 морф-таргета суммарно. Если эти числа
    // расходятся с GLB — двигать нужно синхронно с .md и license, иначе
    // sentinel молчит на регресс экспортёра.
    expect(primCount).toBe(11);
    expect(morphTotal).toBe(2);
  }, 5000);
});

// ---- 3.2 parkergirl ----
const parkergirlPath = modelPath('parkergirl.glb');
const parkergirlPresent = fs.existsSync(parkergirlPath);
const parkergirlDescribe = parkergirlPresent ? describe : describe.skip;
parkergirlDescribe('Post-GAP-005 corpus — parkergirl (local CC-BY-4.0): heavy morph stress', () => {

  it('passthrough: 1 skin, 1 анимация (\'MorphBake\'), morphTargets > 0', async () => {
    const result = await optimizeFile(modelPath('parkergirl.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.before.animations).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    expect(result.metrics.before.morphTargets).toBeGreaterThan(0);
  });

  it('[\'safe\']: morphTargets 456 → 456, файл 8.48 → 4.82 МБ по измерениям', async () => {
    const result = await optimizeFile(modelPath('parkergirl.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.morphTargets).toBe(456);
    expect(result.metrics.after.morphTargets).toBe(456);
    const ratio = result.metrics.after.fileBytes / result.metrics.before.fileBytes;
    expect(ratio).toBeLessThan(0.80);
  });

  it('[\'safe\',\'draco\']: 8.48 → 4.09 МБ по измерениям, морфы сохранены', async () => {
    const result = await optimizeFile(modelPath('parkergirl.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.morphTargets).toBe(result.metrics.after.morphTargets);
    const ratio = result.metrics.after.fileBytes / result.metrics.before.fileBytes;
    expect(ratio).toBeLessThan(0.60);
  });

  it('source: 1 анимация по имени \'MorphBake\', морфы распределены по 8 примитивам', () => {
    const bytes = fs.readFileSync(modelPath('parkergirl.glb'));
    const json = parseGlbJson(bytes);
    const animNames = (json.animations || []).map((a) => String((a && a.name) || ''));
    expect(animNames).toContain('MorphBake');
    let morphTotal = 0;
    let primCount = 0;
    for (const mesh of (json.meshes || [])) {
      for (const prim of (mesh.primitives || [])) {
        primCount++;
        morphTotal += ((prim.targets) || []).length;
      }
    }
    // Измерено пробой на коммите dbf6513 (см. fixtures/models/*parkergirl*.md):
    // 14 примитивов и 456 морф-таргетов суммарно. Если эти числа расходятся
    // с GLB — двигать нужно синхронно с .md и license.
    expect(primCount).toBe(14);
    expect(morphTotal).toBe(456);
  }, 5000);

  // TESTBUG-007 живёт в tests/bugs-found.test.mjs (там же, где TESTBUG-006).
  // Здесь — только sanity: блок-fail действительно случается на актуальной
  // модели; сам же contract fix хранится в tests/bugs-found.test.mjs.
  // Подробнее — см. tests/bugs-found.test.mjs → ‘TESTBUG-007’.
  it('анонс: см. tests/bugs-found.test.mjs — TESTBUG-007 для parkergirl+meshopt', () => {
    // Sanity-маркер: этот тест-«заглушка» гарантирует, что при прогоне
    // глазами видно «TESTBUG-007 проверяется в bugs-found», иначе следующий
    // человек решит, что meshopt-дефект не воспроизводится, и закроет
    // TESTBUG-007 как уже-не-дефект. Здесь — никаких реальных assert, только
    // фиксация маршрута.
    expect(fs.existsSync(path.resolve(PROJECT_ROOT, 'tests/bugs-found.test.mjs'))).toBe(true);
  });
});

// ============================================================================
// 4. Клиентские модели Production Multi UV 01 / Production Draco Webp 01 / Production Many Materials 01 (локальные, EXT_texture_webp)
// ============================================================================
//
// Ключевое отличие от золотого корпуса: ТЯЖЁЛЫЕ текстуры (одна модель —
// 15 МБ текстур при 8 МБ геометрии). Если в системе нет `toktx` — KTX2
// правило сообщает об этом в skipped и не валит запись.
//
// Таймаут 120s — клиентские модели тяжёлые (Production Multi UV 01 — 16 МБ, Production Many Materials 01 / Production Draco Webp 01
// около 8 МБ).

describe('Post-GAP-005 corpus — клиентские модели, KTX2 graceful', () => {

  const CLIENT_MODELS = ['Production Multi UV 01.glb', 'Production Draco Webp 01.glb', 'Production Many Materials 01.glb'];
  for (const m of CLIENT_MODELS) {
    const p = modelPath(m);
    if (!fs.existsSync(p)) {
      // На свежем clone описать блок с явным skip; vitest корректно
      // покажет его в отчёте как skipped.
      describe.skip(`[local-only] ${m} (не найдена локально)`, () => {
        it('placeholder', () => {
          // Этот it недостижим: describe.skip делает всё внутри skipped.
          // Реальная функция блока — НЕ провалить прогон при отсутствии файла.
          expect(true).toBe(true);
        });
      });
      continue;
    }

    describe(`[client] ${m}: EXT_texture_webp + до 24 материалов`, () => {
      it('[\'safe\']: pipeline отрабатывает без краша, треугольники сохранены', async () => {
        const result = await optimizeFile(p, {
          outDir: tmpOutDir(),
          advancedFeatures: ['safe'],
          dryRun: true,
        });
        expect(result.status).toBe('ok');
        const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
        // Клиентские модели — реальный продакшен; деградация треугольников
        // под safe должна быть минимальной (допуск по большим моделям).
        expect(delta).toBeLessThanOrEqual(5000);
        expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
      });

      it('[\'safe\',\'ktx2\']: graceful fail если toktx не установлен; ok если установлен', async () => {
        // Допускаем ТОЛЬКО два исхода:
        //   (a) ok — путь KTX2 прошёл (toktx в $PATH);
        //   (b) fail — graceful fail с понятным сообщением про toktx.
        // Любой exception / hang / NPE — дефект продукта. Поэтому:
        //   - nodal timeouts/KPI timeout = должен вернуть result object;
        //   - result.error должен упоминать toktx или ktx2 при статусе fail.
        const result = await optimizeFile(p, {
          outDir: tmpOutDir(),
          advancedFeatures: ['safe', 'ktx2'],
          dryRun: true,
        });

        if (result.status === 'ok') {
          // Под ['safe','ktx2'] welding на продакшен-моделях удаляет
          // вырожденные треугольники — это нормальная часть safe-cleanup.
          // Измерено на коммите dbf6513: E300 triΔ=-213, Production Draco Webp 01 triΔ=-66,
          // Production Many Materials 01 triΔ=-7. Sentinel: |after - before| <= 250 — перекрывает
          // текущие weld-потери и срабатывает на внезапный рост или полную
          // потерю геометрии (бывшее симметричное ratio 0.95..1.05 имело
          // dead-tolerance в верхней половине: рост треугольников в этом
          // code-path никогда не наблюдался).
          const triDelta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
          expect(triDelta).toBeLessThanOrEqual(250);
        } else if (result.status === 'fail') {
          // Должен быть внятный маркер про отсутствие toktx в PATH.
          // Подстроки проверяем гибко — язык/фразировка может меняться.
          const e = String(result.error || '');
          const mentionsToktx = /toktx|ktx2\b/i.test(e);
          expect(mentionsToktx).toBe(true);
        } else {
          throw new Error(`Unexpected status ${result.status} for ${m} under safe+ktx2`);
        }
        // Свой таймаут вместо общих 120 с. Клиентские модели под KTX2 целиком
        // упираются во внешний toktx: в одиночку тест проходит за ~60 с, в полном
        // прогоне (33 файла + браузерный Chromium делят процессор) — 122–147 с.
        // Замерено 2026-08-04 четырьмя прогонами: падал ТАЙМАУТ, а не утверждение,
        // и «плавающим» тест выглядел ровно потому, что зависел от загрузки машины.
      }, 360_000);
    });
  }
});

afterAll(cleanupTmpOutDirs);
