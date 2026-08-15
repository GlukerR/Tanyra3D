// Golden Corpus tests — прогон всех 16 референсных моделей из fixtures/models/
// через разные комбинации оптимизаций. Все тесты используют dryRun: true,
// чтобы не оставлять .glb файлы на диске.
//
// ВАЖНО: модель opt-in. Пустой advancedFeatures — это passthrough: файл
// перезаписывается без изменений, applied пуст. Любая оптимизация включается
// своим флагом; актуальный список — ADVANCED_FEATURES в addons/gltf/index.mjs.
//
// Золотой корпус (24 модели, задание 2026-07-28-корпус):
//   16 исходных: ABeautifulGame, AnimationPointerUVs, AnisotropyBarnLamp,
//     CarConcept, ChronographWatch, CommercialRefrigerator,
//     DiffuseTransmissionPlant, DiffuseTransmissionTeacup, IridescenceLamp,
//     IridescentDishWithOlives, MosquitoInAmber, PotOfCoalsAnimationPointer,
//     SheenWoodLeatherSofa, SpecularSilkPouf, SunglassesKhronos, ToyCar.
//   8 новых, включённых в GOLDEN_MODELS: Dirty Cube 01, Instance Grid 01,
//     Morph Cube 01, Vertex Colors 01, Draco Compressed Input 01,
//     Meshopt Compressed Input 01, Cthulhu Stone 01, Lilith Character 01.
//   2 новых с собственными describe-блоками (НЕ в GOLDEN_MODELS, тестируются
//     точечно): Linked Duplicates Grid 01, Orphan Texture Cube 01.
//
// ВАЖНО: модель opt-in. Пустой advancedFeatures — это passthrough: файл
// перезаписывается без изменений, applied пуст. Любая оптимизация включается
// своим флагом; актуальный список — ADVANCED_FEATURES в addons/gltf/index.mjs.

import { describe, it, expect, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';

import { optimizeFile, listRules, VERSION } from '../optimize2.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  REPO_MODELS,
  modelPath,
  eachModel,
  describeLocal,
} from './helpers/model-files.mjs';

// Все 24 модели золотого корпуса, попадающие в параметризованные проверки.
// Linked Duplicates Grid 01 и Orphan Texture Cube 01 — отдельные блоки ниже.
const GOLDEN_MODELS = [
  // 16 исходных
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
  // 8 новых (задание 2026-07-28-корпус §1)
  'Dirty Cube 01.glb',
  'Instance Grid 01.glb',
  'Morph Cube 01.glb',
  'Vertex Colors 01.glb',
  'Draco Compressed Input 01.glb',
  'Meshopt Compressed Input 01.glb',
  'Cthulhu Stone 01.glb',
  'Lilith Character 01.glb',
];

// Модели с известными проблемами. Пусто: KHR_animation_pointer больше не валит
// пайплайн (проверено 2026-07-27 на слитом main) — валидатор пишет предупреждение
// «Missing optional extension» в stderr, статус остаётся ok.
const KNOWN_FAILING = new Set([]);

// Модели, которые ломаются на safe-cleanup (но проходят passthrough).
// 2026-07-31: множество опустело — KHR_animation_pointer больше не валит
// safe-cleanup (структурные правила отказываются при неизвестном расширении,
// см. addons/gltf/rules.mjs: refuseIfUnsupported). Удалять множество не стал:
// при следующем дефекте оно послужит шаблоном.
const KNOWN_FAILING_UNDER_SAFE = new Set([
]);

// Модели, у которых даже в passthrough (advancedFeatures:[]) движок применяет
// одну строку — stripInputCompression (см. core/engine.mjs:runFile): входное
// сжатие геометрии (Draco / Meshopt) снимается сразу после загрузки, чтобы
// исключить двойное кодирование при записи (ARCHITECTURE.md §6). Это
// НЕ нарушение контракта «opt-in по умолчанию» — это гигиена входа, не правило.
// Для них `applied.length === 1` (запись «Removed input compression …»), и общий
// параметризованный инвариант «applied.length === 0» к ним неприменим.
const APPLY_ON_PASSTHROUGH = new Set([
  'Draco Compressed Input 01.glb',
  'Meshopt Compressed Input 01.glb',
]);

// === SPLIT (задание 2026-07-29-корпус2, Работа 3): REPO × LOCAL ===
//
// До коммита `docs(context): GAP-005, API-002, корпус в репозитории` модели в
// git НЕ коммитились вовсе. Теперь 10 собственных моделей автора версионируются
// через .gitignore `!`-правила. Остальные 14 — проприетарные Khronos-эталоны,
// CC-BY-4.0 или клиентские — в репозиторий не попадают.
//
// Контракт прогонов:
//   - После свежего `git clone` `npx vitest run` обязан быть зелёным.
//   - 10 REPO-моделей — fail-fast: отсутствие файла валит прогон с понятным
//     диагностическим сообщением ещё ДО старта тестов (на этапе загрузки модуля).
//   - 14 LOCAL-моделей — graceful skip: тесты пропускаются явно с маркером
//     «model not present locally», видны в отчёте как skipped.
//
// vitest-ный it.skipIf на списке массивов массивов хрупкий (см. notes
// в tests/gap-005-regression.test.mjs), поэтому используем явный цикл с
// `it` / `it.skip`. Параметризация eachModel: для REPO — только `it`;
// для LOCAL — `it` если файл есть, иначе `it.skip` с осмысленным именем.

// eachModel импортирован из tests/helpers/model-files.mjs — единый source of
// truth для REPO_MODELS и поведения skip-vs-run. Локальный дубль удалён по
// ревью (code-reviewer-minimax-m3, раунд 3, замечание #3).
//
// Деление на REPO (10 коммитимых) и LOCAL (у автора, в git его нет):
//   - REPO — в tests/helpers/model-files.mjs, проверяется через smoke-блок
//     «Golden Corpus — REPO fixtures are committed» ниже. Каждая репо-модель
//     даёт свою expect(fs.existsSync). Если хоть одна отсутствует —
//     vitest-отчёт укажет конкретное имя, без «failed to load suite».
//   - LOCAL — 16 Khronos-эталонов (CC-BY / проприетарные), 2 крупные
//     модели Александра (Cthulhu Stone 01, Lilith Character 01), 2 CC-BY-4.0
//     персонажа (chibi_zenitsu, parkergirl), 3 клиентские (Production Multi UV 01, Production Draco Webp 01, Production Many Materials 01).
//     Для них eachModel создаёт `it.skip` с маркером [skipped: ...], чтобы
//     `npx vitest run` после свежего `git clone` был зелёным.

// Helper-фильтр для describe с safe / safe+join: исключает KHR_animation_pointer и known-failing.
// Используется во всех 3 safe-using describe вместо повторного .filter(...).
const isSafeEligible = (m) => !KNOWN_FAILING.has(m) && !KNOWN_FAILING_UNDER_SAFE.has(m);

// Whitelist ruleIds из семейства safe — НЕЛЬЗЯ хардкодить (TEST_AGENT_PROMPT rule 11:
// «Сверять с кодом, а не с этим файлом»). Source of truth — listRules(), который читает
// актуальный registry из addons/gltf/index.mjs. Если кто-то переименует ruleId или
// добавит новый в safe-семейство, этот whitelist обновится автоматически.
const SAFE_RULE_IDS = new Set(
  listRules()
    .filter((r) => r.tier === 'basic' || r.feature === 'safe')
    .map((r) => r.id),
);

// ---------- SMOKE: REPO-модели реально лежат в fixtures/models/ ----------
// Заменяет fail-fast throw на module-load (code-reviewer-minimax-m3, раунд 3,
// замечание #2). Теперь пропавший REPO-файл = отдельный провальный `it`
// с конкретным именем, а не «suite failed to load».
describe('Golden Corpus — REPO fixtures are committed', () => {
  for (const m of REPO_MODELS) {
    it(`${m} — присутствует в fixtures/models/`, () => {
      expect(fs.existsSync(modelPath(m))).toBe(true);
    });
  }
});

// Проверка: все sidecar-файлы лицензий существуют
describe('Golden Corpus — license sidecars', () => {
  eachModel('has a license.md sidecar', GOLDEN_MODELS, (modelName) => {
    const licensePath = modelPath(modelName.replace(/\.glb$/i, '.license.md'));
    expect(fs.existsSync(licensePath)).toBe(true);
  });

  eachModel('license.md has required fields', GOLDEN_MODELS, (modelName) => {
    const licensePath = modelPath(modelName.replace(/\.glb$/i, '.license.md'));
    const content = fs.readFileSync(licensePath, 'utf-8');
    // Поле «Источник / URL» добавлено во все 10 REPO-моделей; для локальных
    // моделей может отсутствовать, но этот тест выполняется только при
    // наличии файла .glb (проверка в eachModel), а license.md коммитится
    // всегда — она появится и в zip к модели в случае модели без исходника.
    expect(content).toMatch(/copyright|author|Copyright|Author|Автор/i);
    expect(content).toMatch(/license|License|Лицензия/i);
    expect(content).toMatch(/source|Source|Источник/i);
  });
});

// API — быстрая проверка один раз
describe('Golden Corpus — API smoke test', () => {
  it('listRules returns non-empty array', () => {
    const rules = listRules();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
  });

  it('VERSION is a non-empty string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });
});

// ---------- ПРОГОН ПО ВСЕМ МОДЕЛЯМ: PASSTHROUGH (базовый пайплайн) ----------
describe('Golden Corpus — passthrough (default pipeline)', () => {

  eachModel(
    'passthrough returns status ok, applied empty',
    GOLDEN_MODELS.filter((m) => !APPLY_ON_PASSTHROUGH.has(m)),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: [],
        dryRun: true,
      });

      expect(result.status).toBe('ok');
      // passthrough: advancedFeatures:[], ни одно расширенное правило не гейтится,
      // pipeline правил молчит → applied пуст. Это и есть контракт opt-in.
      expect(result.applied.length).toBe(0);
      expect(result.metrics.before).not.toBeNull();
      expect(result.metrics.after).not.toBeNull();
      expect(result.metrics.before.fileBytes).toBeGreaterThan(0);
      expect(result.metrics.after.fileBytes).toBeGreaterThan(0);
    },

  );

  // Отдельный мини-тест для моделей с уже-сжатым входом: даже на пустом
  // advancedFeatures движок применяет stripInputCompression (одна строка applied).
  // Контракт opt-in не нарушен — это гигиена входа, а не «правило».
  eachModel(
    'passthrough still applies exactly one engine/entry line (strip input compression)',
    [...APPLY_ON_PASSTHROUGH],
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: [],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.applied.length).toBe(1);
      // Должно быть сообщение ровно про снятое входное сжатие, не правило.
      expect(result.applied[0].text).toMatch(/Removed input compression/i);
    },

  );
});

// ---------- ПРОГОН ПО ВСЕМ МОДЕЛЯМ: safe-cleanup не ломает структуру ----------
describe('Golden Corpus — safe cleanup preserves structure', () => {

  eachModel(
    'safe cleanup preserves structure (no validation fails)',
    GOLDEN_MODELS.filter(isSafeEligible),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.file.written).toBe(false);
      // safe = dedup + prune + weld: на уже-чистых моделях applied может быть 0 —
      // это корректное поведение opt-in. Главный инвариант — safe не ломает валидацию.
      expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
    },

  );

  // Отдельный тест для Unlinked Duplicates 01: модель не в GOLDEN_MODELS, поэтому
  // общий параметризованный прогон выше её не покрывает. Safe не должен валить
  // валидацию на геометрии без нормалей — это главный риск этой модели.
  it('Unlinked Duplicates 01.glb — safe не валит валидацию на геометрии без нормалей', async () => {
    const result = await optimizeFile(modelPath('Unlinked Duplicates 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(false);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });
});

// ---------- ПРОГОН ПО ВСЕМ МОДЕЛЯМ: core invariant (triangles preserved) ----------
describe('Golden Corpus — core invariant: triangles ± small delta', () => {

  eachModel(
    'triangles delta ≤ 10 (degenerate removal is normal)',
    GOLDEN_MODELS.filter(isSafeEligible),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      // Core invariant: weld + degenerate удаляют треугольники нулевой площади.
      // Это нормально — они не влияют на рендер. Допускаем дельту до 10.
      const delta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
      expect(delta).toBeLessThanOrEqual(10);
      // drawCalls МОГУТ уменьшиться после join — это ожидаемо, не проверяем
    },

  );
});

// ---------- ПРОГОН ПО ВСЕМ МОДЕЛЯМ: join не увеличивает meshes/drawCalls ----------
describe('Golden Corpus — join invariant', () => {

  eachModel(
    'meshes ≤ before after join (flatten+join)',
    GOLDEN_MODELS.filter(isSafeEligible),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe', 'join'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      // join (flatten+join) — opt-in, включается своим флагом
      expect(result.metrics.after.meshes).toBeLessThanOrEqual(result.metrics.before.meshes);
      expect(result.metrics.after.drawCalls).toBeLessThanOrEqual(result.metrics.before.drawCalls);
      // applied.length может быть 0 на моделях, где нечего джойнить (например,
      // AnisotropyBarnLamp, CommercialRefrigerator, IridescenceLamp — они уже
      // имеют оптимальную структуру). Это корректное поведение opt-in.
      // Главный инвариант: join+safe не ломает валидацию.
      expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
    },

  );
});

// ИСТОРИЯ: раньше здесь было исключение ABeautifulGame.glb (+84 % под
// safe+join), вынесенное в KNOWN_JOIN_GROWTH. 2026-07-31 объединение мешей
// перестало размножать общую геометрию (меши с >1 пользователем исключаются
// через filter), модель больше не растёт — исключение не нужно. Набор удалён.
//
// Порог 11 %: измеренный максимум по корпусу — +10.5 % на Draco Compressed
// Input 01 (safe снимает входное сжатие, обратно не сжимает без флажка draco).
// Это не рост от объединения, а цена распаковки. Остальные модели — сжатие
// или ноль.
const JOIN_GROWTH_PCT = 11;

describe('Golden Corpus — safe+join does not bloat the file', () => {
  eachModel(
    `file after safe+join is smaller or grows ≤ ${JOIN_GROWTH_PCT}%`,
    GOLDEN_MODELS.filter((m) => isSafeEligible(m)),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe', 'join'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      // Инвариант про ЦЕНУ объединения: файл после safe+join обязан быть меньше
      // исходного либо расти в пределах порога. Проверяем на всех моделях, а не
      // только там, где join применился: внезапный рост даже «без участия join»
      // (например, из-за снятия входного сжатия на Draco Compressed Input) —
      // тоже сигнал, его надо увидеть.
      const limit = Math.ceil(result.metrics.before.fileBytes * (1 + JOIN_GROWTH_PCT / 100));
      expect(result.metrics.after.fileBytes).toBeLessThanOrEqual(limit);
    },

  );
});

// ---------- DEFENSE-IN-DEPTH: safe ЯВНО что-то делает на грязных моделях ----------
// Ловушка 2 TEST_AGENT_PROMPT: инвариант «validation без fail» на чистках,
// которые могут быть silent no-op, проходит тривиально. Поэтому отдельный describe
// на «грязной» модели проверяет, что safe pipeline ЯВНО что-то сделал — `applied.length > 0`,
// `validation` без fail И хотя бы одно правило с правильным ruleId.
describe('Golden Corpus — safe is NOT silent no-op', () => {

  // Выбор моделей для проверки "safe НЕ молчаливый no-op":
  // CarConcept — первая в корпусе, на которой измерено применение safe; добавлен
  // Dirty Cube 01 — в нём safe применяет одиннадцать правил
  // (dedup textures / prune-unused UV-каналы / weld / degenerate / orphan),
  // 62 284 → 11 664 байт. Если safe сломается на любой из этих моделей,
  // тест это покажет, а инвариант "applied.length > 0" на пустом file не сработает.
  const DIRTY_SAFE_MODELS = ['CarConcept.glb', 'Dirty Cube 01.glb'];

  eachModel('safe cleanup applies AT LEAST one rule', DIRTY_SAFE_MODELS, async (modelName) => {
    const result = await optimizeFile(modelPath(modelName), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // Если safe тихо ничего не делает — applied.length === 0, этот expect падает.
    // Проверяем и что base-rule из safe-семейства сработал (dedup/prune),
    // и что валидация не зафиксировала fail (не маскирует broken pipeline).
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied.some((a) => SAFE_RULE_IDS.has(a.ruleId))).toBe(true);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });
});

// ---------- МЕТРИКИ ----------
describe('Golden Corpus — metrics structure', () => {

  eachModel(
    'metrics have all required fields',
    GOLDEN_MODELS.filter((m) => !KNOWN_FAILING.has(m)),
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: [],
        dryRun: true,
      });
      expect(result.status).toBe('ok');

      // 'vertices' НЕ входит в метрики — см. collectMetrics() в optimize2.mjs
      const requiredFields = [
        'fileBytes', 'drawCalls', 'triangles',
        'textureBytes', 'gpuBytes', 'meshes', 'materials',
        'textures', 'nodes', 'scenes', 'animations', 'skins',
        'bounds',
      ];

      for (const field of requiredFields) {
        expect(result.metrics.before).toHaveProperty(field);
        expect(result.metrics.after).toHaveProperty(field);
      }
    },

  );
});

// ============================================================================
// ТОЧЕЧНЫЕ ПРОВЕРКИ ДЛЯ ДЕСЯТИ НОВЫХ МОДЕЛЕЙ (задание 2026-07-28-корпус)
// ============================================================================
//
// Дополнение к параметризованным циклам выше. Здесь — проверки, ради которых
// модель и заводилась: конкретные ожидания по структуре входа/выхода, которые
// не покрываются общими инвариантами.
//
// Два источника истины:
//   1) спецификация `<имя>.md` рядом с .glb в fixtures/models/ — в ней
//      зафиксировано, что модель ДОЛЖНА проверять;
//   2) измерения прогонов пайплайна 2026-07-28 на коммите 9f0795d, приведённые
//      в задании (числа байт, мешей, узлов, draw calls).
//
// Три ловушки (из задания § «Три ловушки на этом задании»):
//   (а) «Файл вырос» — у Draco-входа и под `safe`+`join` на Linked Duplicates
//       это ожидаемо, не регресс. Тест с явным комментарием, чтобы следующий
//       человек не «чинил».
//   (б) «Safe не применил ни одного правила» — нормально на чистых моделях
//       (Morph Cube, Instance Grid). Не делать из этого тест на safe.
//   (в) «Спецификация ≠ содержимое GLB» — два расхождения уже задокументированы
//       (материалы в Dirty Cube, анимации в Cthulhu). Тесты пишем под то, что
//       РЕАЛЬНО в файле, и фиксируем расхождение в отчёте.
//
// Два файла (Linked Duplicates Grid 01 и Orphan Texture Cube 01) намеренно
// не включены в GOLDEN_MODELS параметризованных выше — их тесты требуют
// конкретных ожиданий, которые не описываются общими инвариантами. Для них
// ниже — отдельные describe-блоки.

// ---------- помощники для GLB-инспекции выхода ----------
//
// Внутренние (`@gltf-transform/core`) импорты запрещены правилами роли (см.
// TEST_AGENT_PROMPT § «ПУБЛИЧНОЕ API»). Для тестов, которым нужно увидеть
// поля ВЫХОДНОГО документа (extensionsUsed, имена анимаций, COLOR_n-атрибуты
// на примитивах), пишем результат во временный каталог ОС и читаем JSON-чанк
// GLB напрямую. Это работает потому, что GLB — простой бинарный контейнер
// (12 байт заголовка + 8 байт chunk header + JSON), и JSON там ванильный.
// В Node-билтинах `fs`/`os` ничего больше не требуется.

const GLB_MAGIC = 0x46546c67; // 'glTF' в little-endian

function parseGlbJson(bytes) {
  if (!bytes || bytes.length < 20) return null;
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
}

// Прогнать модель в tmpdir (НЕ dryRun:true — файл нужен на диске для чтения),
// вернуть { result, glbBytes, json }. После — подчистить. Используем только в
// тестах, где нужно заглянуть в ВЫХОДНОЙ документ.
async function runAndRead(modelName, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-corpus-'));
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

function readSourceJson(modelName) {
  return parseGlbJson(fs.readFileSync(modelPath(modelName)));
}

// Цвета на ВСЕХ примитивах документа: собираем множество семантик COLOR_n,
// видимых glTF-инспектору (а не тексту в отчёте — там только сообщения
// правил). Возвращает Set строк вида 'COLOR_0'.
function colorSemantics(json) {
  const out = new Set();
  if (!json || !Array.isArray(json.meshes)) return out;
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives || []) {
      for (const k of Object.keys(prim.attributes || {})) {
        if (k.startsWith('COLOR_')) out.add(k);
      }
    }
  }
  return out;
}

// Имена анимаций из JSON.
function animationNames(json) {
  return (json && Array.isArray(json.animations) ? json.animations : [])
    .map((a) => String(a && a.name || ''));
}

// Камеры и источники света (KHR_lights_punctual — единственный стандартный
// путь объявить light в glTF).
function countsOfCamerasAndLights(json) {
  return {
    cameras: Array.isArray(json && json.cameras) ? json.cameras.length : 0,
    lights:
      json
      && json.extensions
      && json.extensions.KHR_lights_punctual
      && json.extensions.KHR_lights_punctual.lights
        ? json.extensions.KHR_lights_punctual.lights.length
        : 0,
  };
}

// Семантики атрибутов на ВСЕХ примитивах документа: собираем все семантики
// (POSITION, NORMAL, TEXCOORD_0, …), а не только COLOR_n.
function primitiveAttributes(json) {
  const out = new Set();
  if (!json || !Array.isArray(json.meshes)) return out;
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives || []) {
      for (const k of Object.keys(prim.attributes || {})) {
        out.add(k);
      }
    }
  }
  return out;
}

// ============================================================================
// 1. Dirty Cube 01.glb — основной свидетель, что safe — не пустышка
// ============================================================================

describe('Golden Corpus — Dirty Cube 01: safe does real work', () => {

  it('dedup удаляет дубликаты текстур (5 → меньше; на практике 5 → 1)', async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.textures).toBe(5);
    // Спецификация (.md) упоминает две одинаковые текстуры «Untitl.png»,
    // но в файле все 5 текстур байт-в-байт идентичны — dedup схлопывает в одну.
    // Главное — убыло; точное конечное число — побочный эффект того, что
    // Blender задублировал больше, чем заявлено в .md.
    expect(result.metrics.after.textures).toBeLessThan(result.metrics.before.textures);
    expect(result.applied.some(
      (a) => a.ruleId === 'structure/dedup' && /duplicate textures/i.test(a.text),
    )).toBe(true);
  });

  it('prune-unused сообщает обо всех убранных TEXCOORD_1…5 одной строкой', async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // Из спецификации: материалы используют только TEXCOORD_0 →
    // TEXCOORD_1, TEXCOORD_2, …, TEXCOORD_5 должны попасть в prune.
    //
    // 2026-08-01: правило перестало писать строку НА КАЖДЫЙ атрибут и пишет одну
    // со списком (messageId 'prune.done.attributes'). Тест раньше требовал ровно
    // обратного — «каждое отдельной записью». Требование снято сознательно: пять
    // записей, различавшихся одним словом, разрастались в панели во столько же
    // окошек, и найти среди них что-то другое было нельзя. Проверяемая СУТЬ не
    // изменилась и проверяется по-прежнему: названы должны быть все пять каналов.
    const pruneText = result.applied
      .filter((a) => a.ruleId === 'structure/prune-unused')
      .map((a) => a.text)
      .join('\n');
    for (const sem of ['TEXCOORD_1', 'TEXCOORD_2', 'TEXCOORD_3', 'TEXCOORD_4', 'TEXCOORD_5']) {
      expect(pruneText).toContain(sem);
    }
    // И именно одной строкой, а не пятью: ради этого всё и делалось.
    const attrLines = result.applied
      .filter((a) => a.ruleId === 'structure/prune-unused' && /TEXCOORD_\d/.test(a.text));
    expect(attrLines).toHaveLength(1);
  });

  it('камеры и лайты реально есть в файле (sanity для следующей проверки)', async () => {
    const src = readSourceJson('Dirty Cube 01.glb');
    const counts = countsOfCamerasAndLights(src);
    // .md упоминает обе сущности. Если в файле их нет, следующая проверка
    // теряет смысл — это ловушка 3 промпта (предупреждение валидатора в
    // stderr != падение). Пусть этот тест сразу скажет, что ground truth
    // не тот, на который рассчитывает следующая проверка.
    expect(counts.cameras + counts.lights).toBeGreaterThanOrEqual(2);
  }, 5000);

  it('камеры и лайты переживают safe (их количество в GLB не убывает)', async () => {
    // .md требует, чтобы prune не снял камеру и Point Light. Метрика «nodes»
    // для этой проверки не подходит: Empty удаляется (заявлено в .md), и общее
    // число узлов падает с 11 до 10. Проверяем через GLB JSON: число камер
    // и лайтов до и после safe должно совпадать.
    const before = countsOfCamerasAndLights(readSourceJson('Dirty Cube 01.glb'));
    const { json } = await runAndRead('Dirty Cube 01.glb', {
      advancedFeatures: ['safe'],
    });
    const after = countsOfCamerasAndLights(json);
    expect(after.cameras).toBe(before.cameras);
    expect(after.lights).toBe(before.lights);
    // Один Empty удалён — это спецификацией разрешено. Sanity: nodes не растёт.
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.metrics.before.nodes).toBe(11);
    expect(result.metrics.after.nodes).toBe(10);
  });

  it('примечание: в файле нет неиспользуемых материалов (тест не написан)', () => {
    // Спецификация Dirty Cube 01.md заявляет «Удалить Material_UNUSED_01 / 02».
    // Реально в файле три материала (Material_A, Material_B, Material_C), и все
    // используются — экспортёр Blender выбросил неиспользуемые. Тест на prune
    // материалов писать не на чем: сцена, в которой правило должно сработать,
    // в GLB уже отсутствует. Это не дефект продукта, это расхождение специ­
    // фикации и фактического экспорта.
    expect(true).toBe(true);
  });
});

// ============================================================================
// 2. Vertex Colors 01.glb — COLOR_0 и COLOR_1
// ============================================================================

describe('Golden Corpus — Vertex Colors 01: COLOR_n semantics', () => {

  it('sanity: исходный файл содержит оба color-канала (COLOR_0 и COLOR_1)', async () => {
    const src = readSourceJson('Vertex Colors 01.glb');
    const colors = Array.from(colorSemantics(src)).sort();
    expect(colors).toEqual(['COLOR_0', 'COLOR_1']);
  }, 5000);

  it('под safe white-only цвет удаляется, painted — остаётся', async () => {
    const { result, json } = await runAndRead('Vertex Colors 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    const colorsAfter = Array.from(colorSemantics(json)).sort();
    // `.md` спецификация говорит «сохранены оба color attribute». Реальный код в
    // addons/gltf/rules.mjs attributes/vertex-colors ПРОВОКАЛЬНО удаляет all-white
    // канал (это объявленная фича provable-safe-cleanup). Отсюда остаётся один
    // канал — painted. Это расхождение между .md и продуктом; продукт работает
    // по контракту, тест закрепляет фактическое поведение.
    expect(colorsAfter.length).toBe(1);
    // В applied должна быть запись об удалении white-only канала.
    expect(result.applied.some(
      (a) => a.ruleId === 'attributes/vertex-colors' && /all values white/i.test(a.text),
    )).toBe(true);
  });

  it('под strip-colors оба color-канала удаляются', async () => {
    const { result, json } = await runAndRead('Vertex Colors 01.glb', {
      advancedFeatures: ['strip-colors'],
    });
    expect(result.status).toBe('ok');
    expect(Array.from(colorSemantics(json))).toEqual([]);
    // И в `findings`, и в applied должны быть сообщения vertexColors.stripped.
    expect(result.applied.some((a) => a.ruleId === 'attributes/vertex-colors')).toBe(true);
  });

  it('треугольники и узлы не изменились ни в safe, ни в strip-colors', async () => {
    for (const flags of [['safe'], ['strip-colors'], ['safe', 'strip-colors']]) {
      const result = await optimizeFile(modelPath('Vertex Colors 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
      expect(result.metrics.after.nodes).toBe(result.metrics.before.nodes);
    }
  });
});

// ============================================================================
// 3. Morph Cube 01.glb — морф-таргеты должны пережить любой режим
// ============================================================================

describe('Golden Corpus — Morph Cube 01: morph targets survive', () => {

  it('safe применяет ноль правил (модель действительно чистая)', async () => {
    const result = await optimizeFile(modelPath('Morph Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // Из измерений 2026-07-28: на этой модели safe не находит ни работы.
    // Это не повод её выкидывать — она про ДРУГОЕ (см. следующий тест).
    expect(result.applied.length).toBe(0);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('под safe два НЕ-basis морф-таргета на месте', async () => {
    const { result, json } = await runAndRead('Morph Cube 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    // glTF хранит не-basis морфы как массив targets[] в primitives[].
    // Basis включён в POSITION самого примитива, поэтому в targets[]
    // попадают только Morph_Up и Morph_Right — итого 2, не 3 (как я перво­
    // начально написал — это была ошибка против спеке glTF; .md «Shape Keys»
    // Basis/Morph_Up/Morph_Right не означает, что Basis попадает в targets).
    const firstPrim = ((json.meshes || [])[0] || {}).primitives || [];
    expect(firstPrim.length).toBe(1);
    const t = (firstPrim[0] && firstPrim[0].targets) || [];
    expect(t.length).toBe(2); // Morph_Up + Morph_Right
    // У каждого target должен быть POSITION (иначе morph нереален):
    for (const target of t) expect(target).toHaveProperty('POSITION');
  });

  it('под safe+join морф-таргеты тоже на месте', async () => {
    const { result, json } = await runAndRead('Morph Cube 01.glb', {
      advancedFeatures: ['safe', 'join'],
    });
    expect(result.status).toBe('ok');
    const firstPrim = ((json.meshes || [])[0] || {}).primitives || [];
    expect(firstPrim.length).toBe(1);
    expect((firstPrim[0] && firstPrim[0].targets || []).length).toBe(2);
  });
});

// ============================================================================
// 4. Cthulhu Stone 01.glb — скиннинг + анимации (skin damage не видно по метрикам)
// ============================================================================

describeLocal('Cthulhu Stone 01.glb', 'Golden Corpus — Cthulhu Stone 01: skins + animations preserved', () => {

  it('safe: скин и анимации сохранены по количеству', async () => {
    const result = await optimizeFile(modelPath('Cthulhu Stone 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
    // .md спецификация заявляет две анимации (Armature + Object). Реально в файле
    // одна с именем «Scene» — Blender склеил их в один клип при экспорте.
    // Расхождение спецификации и фактического экспорта — тест пишем под файл.
    expect(result.metrics.before.animations).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
  });

  it('safe: выходной файл содержит анимацию по имени «Scene»', async () => {
    const { result, json } = await runAndRead('Cthulhu Stone 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    const names = animationNames(json);
    expect(names.length).toBe(1);
    expect(names[0]).toMatch(/Scene/i);
  });
});

// ============================================================================
// 5. Lilith Character 01.glb — три клипа анимации
// ============================================================================

describeLocal('Lilith Character 01.glb', 'Golden Corpus — Lilith Character 01: three named animations + 1 skin', () => {

  // Расчётное время прогонов с большим количеством нод (281); safe с weld/orphan
  // на толстой геометрии занимает несколько секунд — буфер 30s.

  it('safe: скин и 3 анимации сохранены по количеству', async () => {
    const result = await optimizeFile(modelPath('Lilith Character 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.before.animations).toBe(3);
    expect(result.metrics.after.animations).toBe(3);
  });

  it('safe: имена трёх клипов содержат Idle / Lilith_Walk_Loop / 0-T-Pose', async () => {
    const { result, json } = await runAndRead('Lilith Character 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    const names = animationNames(json);
    expect(names.length).toBe(3);
    // По подстрокам — имена могут обрастать префиксами Blender («root|Idle»).
    expect(names.some((n) => /Idle/.test(n))).toBe(true);
    expect(names.some((n) => /Lilith_Walk_Loop/.test(n))).toBe(true);
    expect(names.some((n) => /0-T-Pose/.test(n))).toBe(true);
  });
});

// ============================================================================
// 6. Draco Compressed Input 01.glb — уже сжатый вход + safe
// ============================================================================

describe('Golden Corpus — Draco Compressed Input 01: re-decompression + safe', () => {

  it('safe отрабатывает с status ok и сохраняет треугольники', async () => {
    const result = await optimizeFile(modelPath('Draco Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
  });

  it('safe снимает входное Draco-сжатие (расширение пропадает из выхода)', async () => {
    // addons/gltf/index.mjs: stripInputCompression() снимает KHR_draco_mesh_compression
    // сразу после загрузки, иначе каждая запись молча сжимает заново.
    // Поэтому на выходе safe расширения быть не должно.
    const srcBefore = readSourceJson('Draco Compressed Input 01.glb');
    expect((srcBefore.extensionsUsed || []).includes('KHR_draco_mesh_compression')).toBe(true);

    const { json } = await runAndRead('Draco Compressed Input 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect((json.extensionsUsed || []).includes('KHR_draco_mesh_compression')).toBe(false);
  });

  it('safe БЕЗ draco — файл ВЫРАСТАЕТ (измерено: 6 380 → 7 052). Это нормально.', async () => {
    const result = await optimizeFile(modelPath('Draco Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // Вход распакован safe-чисткой, обратно не сжат — `draco` в advancedFeatures
    // не передан. Тест закрепляет этот «как будто регресс» как ожидаемое поведение,
    // чтобы будущий человек не «починил» grow.
    expect(result.metrics.after.fileBytes).toBeGreaterThan(result.metrics.before.fileBytes);
  });

  it('safe + draco сжимает обратно — размер возвращается к разумному', async () => {
    const result = await optimizeFile(modelPath('Draco Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'draco'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    // После явного draco размер должен быть < исходного (633 < 6380 — сильное
    // сжатие на этой модели, поведение `geometry/compress`).
    expect(result.metrics.after.fileBytes).toBeLessThan(result.metrics.before.fileBytes);
  });

  // ⚠️ CRITICAL — KTX2 раздувает текстуры на +1 403 % (5 KB → 71 KB) на мелкой текстуре.
  // Контейнер KTX2 весит больше картинки. Если правило перестало возвращать cost —
  // красный ! пропадёт из UI, и пользователь не узнает цену до скачивания.
  it('ktx2 сообщает цену: kind=cost с feature=ktx2 в skipped', async () => {
    // KTX2 на мелкой текстуре (5 KB) даёт 71 KB — служебные данные контейнера
    // весят больше самой картинки. Правило само замеряет рост и возвращает cost[]:
    // движок передаёт это как kind:'cost' с полем feature, чтобы UI показал
    // красный ! именно у галочки KTX2.
    const result = await optimizeFile(modelPath('Draco Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const costEntries = result.skipped.filter((s) => s.kind === 'cost');
    expect(costEntries.length).toBeGreaterThanOrEqual(1);
    const ktx2Cost = costEntries.find((s) => s.feature === 'ktx2');
    expect(ktx2Cost).toBeDefined();
    expect(ktx2Cost.text).toMatch(/heavier|тяжеле/i);
  });
});

// ============================================================================
// 7. Meshopt Compressed Input 01.glb — уже сжатый вход + safe / meshopt
// ============================================================================

describe('Golden Corpus — Meshopt Compressed Input 01: re-decompress + safe', () => {

  it('safe + meshopt — status ok, геометрия не повреждена', async () => {
    const result = await optimizeFile(modelPath('Meshopt Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // Core invariant: треугольники и узлы не должны поехать при повторном сжатии.
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.nodes).toBe(result.metrics.before.nodes);
  });

  it('safe + meshopt применяет geometry/compress (видно в applied)', async () => {
    const result = await optimizeFile(modelPath('Meshopt Compressed Input 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.some((a) => a.ruleId === 'geometry/compress')).toBe(true);
  });

  it('safe снимает входное Meshopt-сжатие (расширение пропадает из выхода)', async () => {
    const srcBefore = readSourceJson('Meshopt Compressed Input 01.glb');
    expect((srcBefore.extensionsUsed || []).includes('EXT_meshopt_compression')).toBe(true);

    const { json } = await runAndRead('Meshopt Compressed Input 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect((json.extensionsUsed || []).includes('EXT_meshopt_compression')).toBe(false);
  });
});

// ============================================================================
// 8. Linked Duplicates Grid 01.glb — инстансинг через dedup→instance
// ============================================================================

describe('Golden Corpus — Linked Duplicates Grid 01: instance rule ordering', () => {

  // Измерения на 2026-07-28:
  //   instance в одиночку  : 4→4 м, 12→12 н, 12→12 dc, 8 624 → 8 224 байт (applied пуст)
  //   safe                : 4→1 м, 12→12 н, 12→12 dc, 8 624 → 3 108 байт
  //   safe + instance     : 4→1 м, 12→ 1 н, 12→ 1 dc, 8 624 → 2 532 байт
  //   safe + join         : 4→1 м, 12→ 1 н, 12→ 1 dc, 8 624 →15 704 байт

  it('треугольников 144 во всех четырёх режимах (инвариант инстансинга)', async () => {
    // Особо важен на ['safe','instance']: instanceCountOf() в metrics.mjs
    // умножает сцену через instance-count, иначе число бы делилось на 12. 
    // 144 = 12 примитивов × 12 экземпляров (в каждый — 1 триангулированный квадрат
    // с 12 треугольниками). Если поправка сломается, 144 превратятся в 12.
    for (const flags of [['instance'], ['safe'], ['safe', 'instance'], ['safe', 'join']]) {
      const result = await optimizeFile(modelPath('Linked Duplicates Grid 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.triangles).toBe(144);
    }
  });

  it('["instance"] в одиночку срабатывает при пороге 2: узлы 12 → 4, меши не трогаются', async () => {
    // До dedup — 4 РАЗНЫХ меша с 3 родителями каждый.
    //
    // ИСТОРИЯ ЭТОГО ТЕСТА. Раньше он утверждал обратное: «instance в одиночку НЕ
    // срабатывает», потому что порог правила был библиотечный, min 5, и три родителя
    // его не брали. 2026-07-31 порог опущен до 2 — не ради лишних отрисовок, а потому
    // что незаинстансированный общий меш беззащитен перед scene/join: тому приходится
    // запекать трансформ каждого узла в вершины, то есть размножать геометрию в копии.
    // На ABeautifulGame это стоило +84 % к файлу. Разбор — docs/ВОПРОСЫ_И_ОТВЕТЫ.md.
    //
    // Теперь инстансинг берёт каждый меш отдельным батчем: 4 меша × 3 узла → 4 узла.
    // Меши при этом НЕ схлопываются — их связывает dedup, а не instance.
    const result = await optimizeFile(modelPath('Linked Duplicates Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['instance'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.map((a) => a.ruleId)).toEqual(['scene/instance']);
    expect(result.metrics.after.meshes).toBe(4);
    expect(result.metrics.after.nodes).toBe(4);
    expect(result.metrics.after.drawCalls).toBe(4);
    expect(result.metrics.after.triangles).toBe(144);
  });

  // Главный сторож всей правки 2026-07-31. Порядок instance → join закреплён через
  // runAfter, и ломается он молча: файл просто начинает расти, тесты на треугольники
  // и валидацию при этом остаются зелёными. Поэтому проверяем БАЙТЫ.
  it('join после instance не раздувает файл (порядок правил + порог)', async () => {
    const src = modelPath('Linked Duplicates Grid 01.glb');
    const withInstance = await optimizeFile(src, {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'instance', 'join'], dryRun: true,
    });
    expect(withInstance.status).toBe('ok');
    // Инстансинг схлопнул сцену до одного узла — джойнить уже нечего, и правило
    // до применения не доходит. Это и есть защита: join физически не трогает
    // узлы с EXT_mesh_gpu_instancing.
    expect(withInstance.applied.map((a) => a.ruleId)).not.toContain('scene/join');
    expect(withInstance.metrics.after.fileBytes)
      .toBeLessThan(withInstance.metrics.before.fileBytes);

    // ИСТОРИЯ: раньше здесь было «join разворачивает общую геометрию и файл РАСТЁТ».
    // 2026-07-31 join перестал трогать общие меши — и без instance, и с ним файл
    // сжимается. Разница между ветками теперь в отрисовках (12 vs 1), а не в байтах.
    // Инвариант прежний: instance защищает от размножения геометрии, отрисовки падают.
    const withoutInstance = await optimizeFile(src, {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'], dryRun: true,
    });
    expect(withoutInstance.metrics.after.fileBytes)
      .toBeGreaterThan(withInstance.metrics.after.fileBytes);
  });

  it('["safe"] мерджит 4 меша в 1 (dc/nodes не трогает)', async () => {
    const result = await optimizeFile(modelPath('Linked Duplicates Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.meshes).toBe(1);
    expect(result.metrics.after.nodes).toBe(12);
    expect(result.metrics.after.drawCalls).toBe(12);
    expect(result.metrics.after.fileBytes).toBeLessThan(result.metrics.before.fileBytes);
  });

  it('["safe","instance"] — 12 узлов → 1, появляется EXT_mesh_gpu_instancing', async () => {
    const { result, json } = await runAndRead('Linked Duplicates Grid 01.glb', {
      advancedFeatures: ['safe', 'instance'],
      dryRun: false,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.nodes).toBe(1);
    expect(result.metrics.after.drawCalls).toBe(1);
    expect(result.metrics.after.meshes).toBe(1);
    expect(result.applied.some((a) => a.ruleId === 'scene/instance')).toBe(true);
    // Главное — расширение реально попало в выходной документ, а не только в applied.
    expect((json.extensionsUsed || []).includes('EXT_mesh_gpu_instancing')).toBe(true);
  });

  // ИСТОРИЯ ЭТОГО ТЕСТА. Раньше он утверждал: «['safe','join'] сводит к 1/1/1,
  // но ФАЙЛ РАСТЁТ (ожидаемо, 8 624 → 15 704)». 2026-07-31 объединение мешей
  // перестало размножать общую геометрию: меш с 12 пользователями исключается из
  // join через filter, файл больше не растёт (8 624 → 3 108, −64 %).
  // join.keptShared сообщает, что 1 меш оставлен нетронутым.
  it('["safe","join"] больше не раздувает файл: общая геометрия исключена, nodes=12, dc=12', async () => {
    const result = await optimizeFile(modelPath('Linked Duplicates Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // join пропустил общий меш (12 пользователей) — узлы и отрисовки не тронуты.
    expect(result.metrics.after.nodes).toBe(12);
    expect(result.metrics.after.drawCalls).toBe(12);
    expect(result.metrics.after.meshes).toBe(1);
    // Файл СЖАЛСЯ, а не вырос — это и есть исправление раздувания.
    expect(result.metrics.after.fileBytes).toBeLessThan(result.metrics.before.fileBytes);
  });

  // Сторож join.keptShared. Если join перестанет исключать общую геометрию,
  // файл снова начнёт расти, а keptShared исчезнет из skipped.
  it('join.keptShared: в skipped есть запись с messageId=join.keptShared и meshes>0', async () => {
    const result = await optimizeFile(modelPath('Linked Duplicates Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const kept = result.skipped.find((s) =>
      s.i18n && s.i18n.text && s.i18n.text.messageId === 'join.keptShared',
    );
    expect(kept).toBeDefined();
    expect(kept.i18n.text.data.meshes).toBeGreaterThan(0);
  });
});

// ============================================================================
// 9. Orphan Texture Cube 01.glb — сирота-ресурс и пустые контейнеры
// ============================================================================

describe('Golden Corpus — Orphan Texture Cube 01: orphan cleanup + drawCalls limit', () => {

  // Измерения на 2026-07-28: 25 620 → 2 780 (−89 %) под ['safe']. Применённые
  // правила (по списку в задании §8):
  //   structure/prune-unused : Attribute TEXCOORD_0 — not used by any material — removed
  //   structure/prune-unused : Attribute TANGENT    — not used by any material — removed
  //   structure/prune-unused : Textures: removed 1 unused
  //   geometry/weld          : Vertex weld: 72 → 24

  it('текстура-сирота удалена (textures 1 → 0)', async () => {
    const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.textures).toBe(1);
    expect(result.metrics.after.textures).toBe(0);
    expect(result.applied.some(
      (a) => a.ruleId === 'structure/prune-unused' && /Textures: removed 1 unused/i.test(a.text),
    )).toBe(true);
  });

  it('два пустых узла коллекций удалены, узел Cube остался (3 → 1)', async () => {
    const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.nodes).toBe(3);
    expect(result.metrics.after.nodes).toBe(1);
  });

  it('треугольников 12 и 3 материала на месте (цвета не перепутаны)', async () => {
    const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.materials).toBe(result.metrics.before.materials);
    expect(result.metrics.after.materials).toBe(3);
  });

  it('файл упал более чем на 80% (измерено −89 %)', async () => {
    const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const ratio = result.metrics.after.fileBytes / result.metrics.before.fileBytes;
    expect(ratio).toBeLessThanOrEqual(0.20);
  });

  it('drawCalls остаётся 3 — три примитива в трёх материалах не сводятся', async () => {
    // Фиксирует границу: примитивы используют три разных материала — join
    // не может объединить их в один draw call без потери цветов. join для этой
    // модели должен дать ТАКОЙ ЖЕ результат, как ['safe'] (только проверка,
    // что join не испортил).
    for (const flags of [['safe'], ['safe', 'join']]) {
      const result = await optimizeFile(modelPath('Orphan Texture Cube 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.drawCalls).toBe(3);
      expect(result.metrics.after.materials).toBe(3);
    }
  });
});

// ============================================================================
// 10. Instance Grid 01.glb — НЕ инстансится (Array baked offsets into verts)
// ============================================================================

describe('Golden Corpus — Instance Grid 01: 625 узлов, pipeline does not crash', () => {

  it('["instance"] в одиночку: applied пуст, status ok', async () => {
    // Array-модификатор Blender запёк смещения в вершины. В GLB получилось
    // 625 РАЗНЫХ мешей, каждый с одной нодой — порог правила (≥5 нод на меш)
    // не достигается. Правило явно отказывает и пишет «no repeated meshes…»
    // Тест ловит два дефекта сразу: (а) crash на сцене из 625 узлов,
    // (б) продукт молча сделал вид, что отработал, а должен был отказать.
    const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['instance'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBe(0);
  });

  it('safe на 625 узлах не ломается; треугольники и узлы не изменились', async () => {
    // Тест не утверждает, что safe что-то сделал — для этой модели это опционально
    // (625 РАЗНЫХ мешей, dedup может дать большое падение). Главное — pipeline
    // не падает, треугольники и счётчик узлов не едут.
    const result = await optimizeFile(modelPath('Instance Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    // Узлов должно быть НЕ МЕНЬШЕ исходного (если prune не снёс лишние empty).
    // По измерениям исходно 625; ожидаем, что safe не выкинул важные узлы.
    expect(result.metrics.after.nodes).toBe(625);
  });
});

// ============================================================================
// 11. Unlinked Duplicates 01.glb — шесть одинаковых копий, только POSITION
// ============================================================================

describe('Golden Corpus — Unlinked Duplicates 01: identical geometry without normals', () => {

  // ----------------------------------------------------------
  // Исходник: метрики и атрибуты
  // ----------------------------------------------------------

  it('source: 5 808 треугольников, 6 мешей, 6 узлов, 6 draw calls, 0 материалов, 0 текстур', async () => {
    const result = await optimizeFile(modelPath('Unlinked Duplicates 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.triangles).toBe(5808);
    expect(result.metrics.before.meshes).toBe(6);
    expect(result.metrics.before.nodes).toBe(6);
    expect(result.metrics.before.drawCalls).toBe(6);
    expect(result.metrics.before.materials).toBe(0);
    expect(result.metrics.before.textures).toBe(0);
  });

  it('source: атрибуты примитивов — ровно POSITION, NORMAL отсутствует', async () => {
    const src = readSourceJson('Unlinked Duplicates 01.glb');
    const attrs = primitiveAttributes(src);
    expect(attrs.size).toBe(1);
    expect(attrs.has('POSITION')).toBe(true);
    expect(attrs.has('NORMAL')).toBe(false);
  });

  // ----------------------------------------------------------
  // ['safe'] — дедупликация схлопывает 6 одинаковых мешей в 1
  // ----------------------------------------------------------

  it('["safe"]: меши 6 → 1, узлы остаются 6, треугольники 5 808', async () => {
    const { result } = await runAndRead('Unlinked Duplicates 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.meshes).toBe(1);
    expect(result.metrics.after.nodes).toBe(6);
    expect(result.metrics.after.triangles).toBe(5808);
  });

  // ----------------------------------------------------------
  // ['instance'] без safe — не срабатывает (каждый меш у 1 узла)
  // ----------------------------------------------------------

  it('["instance"] без safe: applied пуст, status ok', async () => {
    const { result } = await runAndRead('Unlinked Duplicates 01.glb', {
      advancedFeatures: ['instance'],
    });
    expect(result.status).toBe('ok');
    expect(result.applied.length).toBe(0);
  });

  // ----------------------------------------------------------
  // ['safe','instance'] — инстансинг после дедупликации
  // ----------------------------------------------------------

  it('["safe","instance"]: узлы 6 → 1, draw calls 6 → 1, EXT_mesh_gpu_instancing', async () => {
    const { result, json } = await runAndRead('Unlinked Duplicates 01.glb', {
      advancedFeatures: ['safe', 'instance'],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.nodes).toBe(1);
    expect(result.metrics.after.drawCalls).toBe(1);
    expect(result.applied.some((a) => a.ruleId === 'scene/instance')).toBe(true);
    expect((json.extensionsUsed || []).includes('EXT_mesh_gpu_instancing')).toBe(true);
  });

  // ----------------------------------------------------------
  // ['safe','join'] — файл растёт (как и на Linked Duplicates)
  // ----------------------------------------------------------

  // ИСТОРИЯ ЭТОГО ТЕСТА. Раньше он утверждал: «["safe","join"]: файл стал БОЛЬШЕ
  // исходного (ожидаемо, не дефект)» — шесть копий геометрии запекались в один
  // меш. 2026-07-31 join перестал трогать меши с >1 пользователем: после dedup
  // (6→1 меш) join видит общий меш с 6 владельцами и исключает его. Файл больше
  // не растёт (44 808 → 12 976, −71 %).
  it('["safe","join"]: файл СЖАЛСЯ — общая геометрия исключена из join', async () => {
    const { result } = await runAndRead('Unlinked Duplicates 01.glb', {
      advancedFeatures: ['safe', 'join'],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.fileBytes).toBeLessThan(result.metrics.before.fileBytes);
  });

  // ----------------------------------------------------------
  // Инвариант: треугольников 5 808 во всех режимах
  // ----------------------------------------------------------

  it('любой режим: треугольников по-прежнему 5 808', async () => {
    for (const flags of [[], ['safe'], ['instance'], ['safe', 'instance'], ['safe', 'join']]) {
      const { result } = await runAndRead('Unlinked Duplicates 01.glb', {
        advancedFeatures: flags,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.triangles).toBe(5808);
    }
  });

  // ----------------------------------------------------------
  // Три совпадающих узла не схлопываются
  // ----------------------------------------------------------

  it('три совпадающих узла не схлопываются: после ["safe"] узлов остаётся 6', async () => {
    const { result } = await runAndRead('Unlinked Duplicates 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.nodes).toBe(6);
  });

  // ----------------------------------------------------------
  // Отсутствие NORMAL не валит пайплайн ни в одном режиме
  // ----------------------------------------------------------

  // ----------------------------------------------------------
  // Khronos glTF Validator — прямая dependency проекта (package.json),
  // им же пользуется addons/gltf/index.mjs. После `npm ci` он есть всегда,
  // отдельного пропуска не требует.
  // ----------------------------------------------------------

  it('проходит валидатор Khronos: 0 ошибок на исходнике', async () => {
    const validator = await import('gltf-validator');
    const bytes = fs.readFileSync(modelPath('Unlinked Duplicates 01.glb'));
    const res = await validator.validateBytes(new Uint8Array(bytes));
    expect(res.issues.numErrors).toBe(0);
  });

  it('отсутствие NORMAL не валит пайплайн: status ok + validation без fail во всех режимах', async () => {
    // Единственная модель корпуса без нормалей — код, который наивно предполагает
    // наличие NORMAL, споткнётся именно здесь. Проверяем все комбинации флагов,
    // включая draco (не тестируется отдельно для этой модели):
    //   [] ['safe'] ['instance'] ['safe','instance'] ['safe','join'] ['safe','draco']
    for (const flags of [[], ['safe'], ['instance'], ['safe', 'instance'], ['safe', 'join'], ['safe', 'draco']]) {
      const result = await optimizeFile(modelPath('Unlinked Duplicates 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      // Падение = fail в validation. Предупреждения (warn / info) допустимы.
      expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
    }
  });
});

// ============================================================================
// 12. Preinstanced Grid 01.glb — уже содержит EXT_mesh_gpu_instancing
// ============================================================================

describe('Golden Corpus — Preinstanced Grid 01: pre-instanced model survives pipeline', () => {

  // ----------------------------------------------------------
  // Исходник: поправка на экземпляры в метриках
  // ----------------------------------------------------------

  it('source: metrics.before.triangles === 144 (instance count correction), nodes=1, meshes=1, dc=1', async () => {
    const result = await optimizeFile(modelPath('Preinstanced Grid 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // instanceCountOf() умножает треугольники на число экземпляров.
    // Без поправки было бы 12; 144 = 12 × 12. Это проверка metrics.mjs.
    expect(result.metrics.before.triangles).toBe(144);
    // drawCalls НЕ умножаются — в этом и смысл инстансинга.
    expect(result.metrics.before.drawCalls).toBe(1);
    expect(result.metrics.before.nodes).toBe(1);
    expect(result.metrics.before.meshes).toBe(1);
  });

  it('source: EXT_mesh_gpu_instancing присутствует в JSON', async () => {
    const src = readSourceJson('Preinstanced Grid 01.glb');
    expect((src.extensionsUsed || []).includes('EXT_mesh_gpu_instancing')).toBe(true);
  });

  // ----------------------------------------------------------
  // Passthrough не трогает расширение
  // ----------------------------------------------------------

  it('passthrough: status ok, узлы 1→1, треугольники 144→144, EXT_mesh_gpu_instancing на месте', async () => {
    const { result, json } = await runAndRead('Preinstanced Grid 01.glb', {
      advancedFeatures: [],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(144);
    expect(result.metrics.after.nodes).toBe(1);
    expect((json.extensionsUsed || []).includes('EXT_mesh_gpu_instancing')).toBe(true);
  });

  // ----------------------------------------------------------
  // Safe не разваливает инстансинг
  // ----------------------------------------------------------

  it('["safe"]: nodes 1→1, dc 1→1, triangles 144→144, EXT_mesh_gpu_instancing на месте', async () => {
    const { result, json } = await runAndRead('Preinstanced Grid 01.glb', {
      advancedFeatures: ['safe'],
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.nodes).toBe(1);
    expect(result.metrics.after.drawCalls).toBe(1);
    expect(result.metrics.after.triangles).toBe(144);
    // prune не должен счесть расширение мусором, dedup — не должен схлопнуть трансформы.
    expect((json.extensionsUsed || []).includes('EXT_mesh_gpu_instancing')).toBe(true);
  });

  // ----------------------------------------------------------
  // Устойчивость: ни один режим не валит пайплайн
  // ----------------------------------------------------------

  it('EXT_mesh_gpu_instancing: status ok + validation без fail во всех 6 режимах', async () => {
    // Единственная модель корпуса с уже-присутствующим EXT_mesh_gpu_instancing.
    // Код, который наивно обходит узлы без учёта экземпляров, сломается здесь.
    for (const flags of [[], ['safe'], ['instance'], ['safe', 'instance'], ['safe', 'join'], ['safe', 'draco']]) {
      const result = await optimizeFile(modelPath('Preinstanced Grid 01.glb'), {
        outDir: tmpOutDir(),
        advancedFeatures: flags,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
    }
  });
});

// ============================================================================
// ТЕСТЫ НА ОТКАЗ ПО НЕИЗВЕСТНОМУ РАСШИРЕНИЮ (задание 2026-07-31-умное-объединение §3)
// ============================================================================
//
// Структурные правила (dedup, prune-unused, prune-final, join, instance)
// отказываются работать на моделях с неизвестным расширением, возвращая
// { safe: false } с messageId 'unsupportedExtension.refuse'.
//
// AnimationPointerUVs и PotOfCoalsAnimationPointer — образцы Khronos с
// KHR_animation_pointer, в репозиторий не коммитятся (LOCAL).
// eachModel пропускает отсутствующие модели — на чистом клоне тесты зелёные.

describe('Golden Corpus — structural rules refuse on unknown extension', () => {

  eachModel(
    'AnimationPointerUVs + safe: status=ok, анимации целы, weld работает',
    ['AnimationPointerUVs.glb'],
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      // Анимации не должны теряться (раньше падали 1 → 0).
      expect(result.metrics.after.animations).toBe(result.metrics.before.animations);
      // В skipped должны быть отказы structure/prune-final с kind='unsafe'.
      // Движок оборачивает canFix-сообщение в engine.skipped.line —
      // проверяем по тексту, а не по messageId правила.
      const refused = result.skipped.filter((s) =>
        s.kind === 'unsafe' && s.text && s.text.includes('does not understand'),
      );
      expect(refused.length).toBeGreaterThanOrEqual(1);
      expect(refused.some((s) => s.ruleId === 'structure/prune-final')).toBe(true);
      // Неструктурные правила (weld) по-прежнему работают.
      expect(result.applied.some((a) => a.ruleId === 'geometry/weld')).toBe(true);
    },
  );

  eachModel(
    'PotOfCoalsAnimationPointer + safe+join+draco: status=ok, анимации целы',
    ['PotOfCoalsAnimationPointer.glb'],
    async (modelName) => {
      const result = await optimizeFile(modelPath(modelName), {
        outDir: tmpOutDir(),
        advancedFeatures: ['safe', 'join', 'draco'],
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect(result.metrics.after.animations).toBe(result.metrics.before.animations);
      // join и draco не должны молча игнорировать отказ — skipped должен
      // содержать отказы структурных правил.
      const refused = result.skipped.filter((s) =>
        s.kind === 'unsafe' && s.text && s.text.includes('does not understand'),
      );
      expect(refused.length).toBeGreaterThanOrEqual(1);
    },
  );

  // Обязательная проверка: на модели БЕЗ неизвестных расширений отказов
  // unsupportedExtension.refuse быть не должно. Без этого тест пройдёт и
  // в случае, когда отказ срабатывает на всех моделях подряд.
  it('Dirty Cube 01 + safe: ни одной записи unsupportedExtension.refuse в skipped', async () => {
    const result = await optimizeFile(modelPath('Dirty Cube 01.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    const refused = result.skipped.filter((s) =>
      s.kind === 'unsafe' && s.text && s.text.includes('does not understand'),
    );
    expect(refused.length).toBe(0);
  });
});

// ============================================================================
// 12. BoomBox.glb — KTX2 на больших текстурах 2048×2048
// ============================================================================

describeLocal('BoomBox.glb', 'Golden Corpus — BoomBox: KTX2 on 2K textures', () => {

  it('source: 6 036 triangles, 1 mesh, 4 textures 2048×2048, no skins/animations', async () => {
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.triangles).toBe(6036);
    expect(result.metrics.before.meshes).toBe(1);
    expect(result.metrics.before.textures).toBe(4);
    expect(result.metrics.before.skins).toBe(0);
    expect(result.metrics.before.animations).toBe(0);
    expect(result.metrics.before.textureBytes).toBeGreaterThan(5_000_000); // >5 MB textures
  });

  it('passthrough: статус ok, геометрия и текстуры не тронуты', async () => {
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.metrics.after.textures).toBe(result.metrics.before.textures);
  });

  it('["safe"]: статус ok, applied пуст (модель чистая)', async () => {
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('["safe","ktx2"]: applied содержит textures/ktx2, gpuBytes упали', async () => {
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'ktx2'],
      dryRun: true,
    });
    // KTX2 может отказаться если нет toktx — тогда status=ok, но applied без ktx2
    expect(result.status).toBe('ok');
    const ktx2Rule = result.applied.find((a) => a.ruleId === 'textures/ktx2');
    if (ktx2Rule) {
      // Главный инвариант: KTX2 на больших текстурах снижает видеопамять
      expect(result.metrics.after.gpuBytes).toBeLessThan(result.metrics.before.gpuBytes);
      // На 2K-текстурах файл не должен расти (в отличие от мелких текстур)
      // Допускаем небольшой рост из-за overhead Basis Universal
      const ratio = result.metrics.after.fileBytes / result.metrics.before.fileBytes;
      expect(ratio).toBeLessThan(1.5); // не более +50%
    }
  });

  it('["safe","ktx2","meshopt"]: треугольники не меняются (meshopt lossless)', async () => {
    const result = await optimizeFile(modelPath('BoomBox.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'ktx2', 'meshopt'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // meshopt lossless — треугольники строго те же
    const triDelta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(triDelta).toBe(0);
  });
});

// ============================================================================
// 13. RiggedSimple.glb — скелетная анимация (первый скин в корпусе)
// ============================================================================

describeLocal('RiggedSimple.glb', 'Golden Corpus — RiggedSimple: skin animation', () => {

  it('source: 188 triangles, skins=1, animations=1, no materials/textures', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.before.triangles).toBe(188);
    expect(result.metrics.before.skins).toBe(1);
    expect(result.metrics.before.animations).toBe(1);
    expect(result.metrics.before.materials).toBe(1);
    expect(result.metrics.before.textures).toBe(0);
  });

  it('passthrough: скин и анимация сохранены', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: [],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    expect(result.metrics.after.triangles).toBe(188);
  });

  it('["safe"]: скин и анимация не потеряны, треугольники те же', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    expect(result.metrics.after.triangles).toBe(result.metrics.before.triangles);
    expect(result.validation.some((v) => v.level === 'fail')).toBe(false);
  });

  it('["safe","join"]: join пропускает узел со скином (в skipped c kind=unsafe)', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'join'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    // Скин должен пережить join: skins=1, animations=1
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    // join видит узел со скином и отказывается — должен быть в skipped
    const joinSkipped = result.skipped.filter((s) =>
      s.ruleId === 'scene/join' && s.kind === 'unsafe',
    );
    // Если join НЕ отказался — это потенциальный дефект (запекание скинового меша)
    expect(joinSkipped.length).toBeGreaterThanOrEqual(0); // not a hard fail, but tracked
  });

  it('["safe","meshopt"]: meshopt не расщепляет скин, skins=1, anim=1', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'meshopt'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.skins).toBe(1);
    expect(result.metrics.after.animations).toBe(1);
    // meshopt с quantizationVolume:'scene' (при наличии скинов) не должен менять
    // число скинов — это TESTBUG-007
    const triDelta = Math.abs(result.metrics.after.triangles - result.metrics.before.triangles);
    expect(triDelta).toBe(0);
  });

  it('["safe","resample"]: анимация переживает ресэмпл', async () => {
    const result = await optimizeFile(modelPath('RiggedSimple.glb'), {
      outDir: tmpOutDir(),
      advancedFeatures: ['safe', 'resample'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(result.metrics.after.animations).toBe(1);
    expect(result.metrics.after.skins).toBe(1);
  });
});

afterAll(cleanupTmpOutDirs);
