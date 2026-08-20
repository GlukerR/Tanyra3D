// tests/architecture/addon-contract.test.mjs — КОРОННЫЙ архитектурный гейт.
//
// Доказывает главное обещание проекта (АРХИТЕКТУРНЫЕ_ТЕСТЫ.md §5, гейт №1):
// движок формат-агностичен, а контракт аддона живёт в коде, а не в документации.
//
// Три шага:
//   1. Метод-сет аддона выводится из ИСХОДНИКА движка (сканируем core/engine.mjs
//      на вызовы addon.*), а не из описания в ARCHITECTURE.md — иначе мок может
//      недописать метод и тест упадёт по неверной причине.
//   2. Из этого набора строится мок-аддон на ВЫДУМАННОМ формате (никакого glTF,
//      three, gltf-transform — только node и собственные данные). Прогон
//      runOptimize() на нём обязан пройти все пять фаз и вернуть status:'ok'.
//      Это проверка архитектурного обещания, а не реализации.
//   3. Реальный addons/gltf/index.mjs обязан реализовать каждый вызванный
//      движком метод — контракт сверяется с исходником движка, а не с текстом.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { runOptimize } from '../../core/engine.mjs';
import gltfAddon from '../../addons/gltf/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.resolve(__dirname, '../../core/engine.mjs');

// ----------------------------------------------------------------------------
// Шаг 1: метод-сет из исходника движка (оракул — код, не документ).
// ----------------------------------------------------------------------------

/** Имена addon.*, которые движок реально вызывает (или читает как свойства). */
function engineAddonApi() {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8')
    // Комментарии убираем ДО поиска: иначе фраза вроде «мы зовём addon.validate»
    // в комментарии сломала бы снимок контракта по неверной причине.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return [...new Set([...src.matchAll(/\baddon\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))].sort();
}

/**
 * Из вызванных движком — те, без которых аддон может обойтись.
 *
 * Узнаём по тому, КАК движок их зовёт: `addon.x ? addon.x(…) : запасной путь` либо
 * `addon.x?.(…)`. Такая запись сама объявляет, что метода может не быть и запасной путь
 * рядом. Требовать их наравне с остальными значило бы соврать про контракт — и, что
 * важнее, лишить проверки сам запасной путь: мок реализовал бы хук, и ветка «хука нет»
 * не выполнилась бы ни разу.
 */
function optionalAddonApi() {
  const clean = fs.readFileSync(ENGINE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const names = new Set();
  for (const m of clean.matchAll(/\baddon\.([A-Za-z_][A-Za-z0-9_]*)\s*(\?\.|\?[^.])/g)) names.add(m[1]);
  return [...names].sort();
}

// Список из §5.1 — что движок обязан звать. Если движок начнёт звать больше —
// тест упадёт с просьбой дописать мок И проверить реальный аддон.
const DOCUMENTED_API = [
  'BASELINE_METRICS', 'baselineMetrics', 'collectMetrics', 'createIO',
  'load', 'normalizeOpts', 'outputName', 'readBytes', 'rules',
  'stripInputCompression', 'validate', 'writeBytes', 'writeReport',
  // Необязательный: движок зовёт его с запасным путём — см. optionalAddonApi ниже.
  'sourceBytes',
].sort();

/**
 * Что из набора объявлено НЕОБЯЗАТЕЛЬНЫМ — движок обходится без этого метода.
 *
 * Появилось 2026-08-20 вместе с первым таким хуком. `sourceBytes` отвечает, сколько
 * весит исходная модель целиком: у `.glb` это размер файла, а у `.gltf` — он сам плюс
 * соседние файлы, на которые он ссылается. Формату, где модель это один файл, хук не
 * нужен вовсе, и требовать его от всех значило бы навязать знание про glTF любому
 * будущему аддону.
 */
const DOCUMENTED_OPTIONAL = ['sourceBytes'];

// ----------------------------------------------------------------------------
// Мок-аддон на выдуманном формате. Метод-сет ДОЛЖЕН совпасть с движковым:
// класс-мок строится из извлечённого набора, и тест ниже сверяет покрытие.
// ----------------------------------------------------------------------------

// Мок-ПРАВИЛО на выдуманном формате. Добавлено 2026-08-04 (основной агент):
// с пустым набором правил гейт доказывал формат-агностичность только КАРКАСА фаз,
// а конвейер правил — самое существенное, что должен пережить второй формат
// (Babylon в 0.3.0, FBX/USD через core/registry.mjs). Правило ничего не знает про
// геометрию: «документ» — обычный объект, работа правила — поменять в нём число.
function makeMockRule() {
  return {
    meta: {
      id: 'mock/bump', category: 'scene', title: 'Mock rule',
      severity: 'info', fixSafety: 'provable', tier: 'basic',
      reversible: true, dataLoss: 'none',
      feature: 'mockFeature',
      enabled: (o) => !!o.mockFeature,
    },
    analyze: () => [{ messageId: 'pipeline', data: {} }],
    canFix: () => ({ safe: true }),
    fix: (finding, ctx) => {
      ctx.document.bumped = (ctx.document.bumped || 0) + 1;
      // Рецепт, а не готовая строка — «язык отдельно от кода» действует и на выдуманный формат
      return { details: [{ messageId: 'engine.nothingToDo', data: {} }] };
    },
  };
}

function makeMockAddon({ rules = [] } = {}) {
  return {
    formats: ['mock'], // расширение выдуманного формата
    rules, // по умолчанию пусто: контракт обязан работать и при пустом наборе
    BASELINE_METRICS: [],
    outputName: (src) => path.basename(src).replace(/\.[^.]+$/, '.mock'),
    normalizeOpts: (opts = {}) => ({
      outDir: String(opts.outDir || '.'),
      force: !!opts.force,
      dryRun: !!opts.dryRun,
      onProgress: null,
      log: () => {},
      locale: 'en',
      codec: 'mock',
      advancedFeatures: opts.advancedFeatures || [],
      // фича мок-правила: включается тем же способом, что и настоящие
      mockFeature: (opts.advancedFeatures || []).includes('mockFeature'),
    }),
    createIO: async () => ({}),
    load: async () => ({ kind: 'mock-doc' }),
    writeBytes: async () => new Uint8Array([1, 2, 3]),
    readBytes: async () => ({ kind: 'mock-doc' }),
    collectMetrics: () => ({
      fileBytes: 0, drawCalls: 0, triangles: 0, vertices: 0,
      meshes: 0, materials: 0, textures: 0, nodes: 0, scenes: 0,
      animations: 0, skins: 0, gpuBytes: 0, textureBytes: 0,
    }),
    baselineMetrics: () => ({}),
    stripInputCompression: () => [],
    validate: ({ result }) => {
      // минимальная «проверка целостности»: без fail-записей движок пишет файл
      result.validation.push({ level: 'pass', text: 'mock-validate: ok' });
    },
    writeReport: ({ name, opts }) => {
      // отчёт тоже обязан писаться (фаза 5); имя возвращается движку
      const reportName = name.replace(/\.mock$/, '.report.md');
      fs.writeFileSync(path.join(opts.outDir, reportName), `# mock report\n`, 'utf8');
      return reportName;
    },
  };
}

// ----------------------------------------------------------------------------
// Шаг 3: реальный аддон обязан реализовать каждый вызванный движком метод.
// ----------------------------------------------------------------------------

describe('addon-contract — контракт аддона живёт в исходнике движка', () => {
  it('движок вызывает ровно документированный набор addon.*', () => {
    const api = engineAddonApi();
    expect(api).toEqual(DOCUMENTED_API);
  });

  it('необязательные хуки названы поимённо и зовутся с запасным путём', () => {
    // Без этого «необязательный» — просто слово в комментарии: движок однажды позовёт
    // хук напрямую, аддон без него упадёт, и выяснится это на чужом формате.
    expect(optionalAddonApi()).toEqual([...DOCUMENTED_OPTIONAL].sort());
  });

  it('реальный addons/gltf/index.mjs реализует каждый вызванный движком метод', () => {
    for (const name of engineAddonApi()) {
      expect(gltfAddon, `gltfAddon.${name} отсутствует`).toHaveProperty(name);
      // свойства-массивы отдельно: rules и BASELINE_METRICS — данные, не функции
      if (name === 'rules' || name === 'BASELINE_METRICS') {
        expect(Array.isArray(gltfAddon[name]), `gltfAddon.${name} должен быть массивом`).toBe(true);
      } else {
        expect(typeof gltfAddon[name], `gltfAddon.${name} должен быть функцией`).toBe('function');
      }
    }
  });
});

// ----------------------------------------------------------------------------
// Шаг 2: прогон движка на ВЫДУМАННОМ формате — главное обещание.
// ----------------------------------------------------------------------------

describe('addon-contract — движок работает на выдуманном формате (формат-агностичность)', () => {
  it('runOptimize(мок-аддон, файл .mock) проходит все пять фаз и пишет результат', async () => {
    const mockAddon = makeMockAddon();
    // мок обязан покрыть весь извлечённый набор — если движок позовёт метод,
    // которого в моке нет, runOptimize упадёт сам; проверяем это и явно
    const optional = new Set(optionalAddonApi());
    for (const name of engineAddonApi()) {
      if (optional.has(name)) continue;   // без него движок обязан обойтись — см. ниже
      expect(mockAddon, `мок-аддон не реализует ${name}`).toHaveProperty(name);
    }
    // Необязательных хуков мок не реализует НАМЕРЕННО, и это половина смысла прогона:
    // так проверяется запасной путь. Реализуй он их — ветка «хука нет» не выполнялась бы
    // ни разу, и её поломку никто бы не заметил.
    for (const name of optional) {
      expect(mockAddon, `мок реализует ${name} — запасной путь больше не проверяется`)
        .not.toHaveProperty(name);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-contract-'));
    const src = path.join(tmp, 'scene.mock');
    const outDir = path.join(tmp, 'out');
    fs.writeFileSync(src, 'mock-format-bytes', 'utf8');

    const result = await runOptimize(mockAddon, src, { outDir, force: true });

    expect(result.status).toBe('ok');
    expect(result.file.written).toBe(true);
    expect(fs.existsSync(result.file.dst)).toBe(true);
    expect(result.metrics.before).not.toBeNull();
    expect(result.metrics.after).not.toBeNull();
    // фаза 4 отработала: валидация содержит запись мока
    expect(result.validation.some((v) => v.level === 'pass')).toBe(true);
    // фаза 5 отработала: отчёт записан, путь отдан в контракте
    expect(result.file.reportPath).toBeTruthy();
    expect(fs.existsSync(result.file.reportPath)).toBe(true);
  });

  // Пустой набор правил доказывает только каркас фаз. Конвейер правил — то, что
  // второму формату (Babylon, FBX/USD) придётся пережить в первую очередь, и он
  // обязан работать, ничего не зная про glTF.
  it('конвейер правил работает на выдуманном формате: правило планируется, применяется и отчитывается', async () => {
    const mockAddon = makeMockAddon({ rules: [makeMockRule()] });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-contract-rules-'));
    const src = path.join(tmp, 'scene.mock');
    fs.writeFileSync(src, 'mock-format-bytes', 'utf8');

    const on = await runOptimize(mockAddon, src, {
      outDir: path.join(tmp, 'out-on'), force: true, advancedFeatures: ['mockFeature'],
    });
    expect(on.status).toBe('ok');
    // правило реально отработало на «документе» выдуманного формата
    expect(on.applied.some((a) => a.ruleId === 'mock/bump')).toBe(true);
    // и запись несёт рецепт, а не готовую строку (правило действует и вне glTF)
    expect(on.applied.find((a) => a.ruleId === 'mock/bump').i18n.text.messageId).toBeTruthy();

    // Выключенная фича — то же обещание «сделал или объяснил», без единой строки glTF
    const off = await runOptimize(mockAddon, src, {
      outDir: path.join(tmp, 'out-off'), force: true, advancedFeatures: [],
    });
    expect(off.status).toBe('ok');
    expect(off.applied.some((a) => a.ruleId === 'mock/bump')).toBe(false);
    expect(off.skipped.some((s) => s.ruleId === 'mock/bump')).toBe(true);
  });

  it('незнакомый методу аддон не валит процесс — движок превращает это в status:fail', async () => {
    const mockAddon = makeMockAddon();
    delete mockAddon.collectMetrics; // сломали контракт — движок должен пережить

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-contract-'));
    const src = path.join(tmp, 'broken.mock');
    fs.writeFileSync(src, 'x', 'utf8');

    const result = await runOptimize(mockAddon, src, { outDir: path.join(tmp, 'out'), force: true });
    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/collectMetrics/);
  });
});
