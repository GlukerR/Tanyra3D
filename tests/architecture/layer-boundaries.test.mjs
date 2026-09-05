import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { PROJECT_ROOT, productionFiles, parseImports, classifySpecifier, resolveRelative, layerOfFile } from './import-graph.mjs';

const ALLOWED_PACKAGES = {
  addons: new Set([
    '@gltf-transform/core', '@gltf-transform/functions', '@gltf-transform/extensions',
    'draco3dgltf', 'meshoptimizer', 'gltf-validator', 'sharp',
    'three/examples/jsm/loaders/STLLoader.js',
    'three/examples/jsm/loaders/PLYLoader.js',
    'three/examples/jsm/loaders/FBXLoader.js',
    'three/examples/jsm/loaders/OBJLoader.js',
  ]),
  ui: new Set(['three', '@needle-tools/three-animation-pointer', 'three-gltf-extensions']),
};

const ALLOWED_RELATIVE = {
  core: new Set(['core']),
  addons: new Set(['core', 'addons']),
  ui: new Set(['ui']),
  'root:optimize2.mjs': new Set(['core', 'addons']),
  'root:server.mjs': new Set(['core', 'addons', 'root:optimize2.mjs', 'root:assistant.mjs']),
  'root:assistant.mjs': new Set(['messages']),
};

const ZERO_IMPORT_LAYERS = new Set(['messages']);

const DYNAMIC_CATALOG_LOADERS = new Set(['core/i18n.mjs', 'assistant.mjs']);

const UI_SHARED_RULES = new Set(['core/lod-grouping.mjs', 'core/interactivity-rules.mjs']);

const relOf = (file) => path.relative(PROJECT_ROOT, file).split(path.sep).join('/');

function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

describe('layer-boundaries — границы слоёв (таблица §2.4)', () => {
  it('производственный код сканируется: найдены все слои', () => {
    const files = productionFiles();
    const layers = new Set(files.map(layerOfFile));
    expect(files.length).toBeGreaterThan(10);
    for (const l of ['core', 'addons', 'ui', 'root:optimize2.mjs', 'root:server.mjs', 'root:assistant.mjs']) {
      expect(layers, `слой ${l} не найден в production-коде`).toContain(l);
    }
  });

  it('исключение под каталоги языков не протухло и не разрослось', async () => {
    const files = productionFiles();
    for (const rel of DYNAMIC_CATALOG_LOADERS) {
      const file = files.find((f) => path.relative(PROJECT_ROOT, f).split(path.sep).join('/') === rel);
      expect(file, `${rel} назван в исключении, но такого файла в production-коде нет`).toBeTruthy();
      const imports = await parseImports(file);
      expect(imports.some((i) => i.specifier == null),
        `${rel} больше не грузит каталоги вычисленным import() — убери его из DYNAMIC_CATALOG_LOADERS`).toBe(true);
    }
    expect(DYNAMIC_CATALOG_LOADERS.size,
      'список исключений вырос. Каждый вычисленный import() — слепое пятно гейта; '
      + 'новый пускается только с разбором, почему статического пути нет').toBe(2);
  });

  it('общее правило, открытое слою ui, остаётся ЧИСТЫМ', async () => {
    const files = productionFiles();
    for (const rel of UI_SHARED_RULES) {
      const file = files.find((f) => relOf(f) === rel);
      expect(file, `${rel} назван в исключении, но такого файла в production-коде нет`).toBeTruthy();
      const imports = await parseImports(file);
      expect(imports.map((i) => i.specifier),
        `${rel} обзавёлся импортами — он больше не чистое правило, и слою ui его нельзя`)
        .toEqual([]);
    }
    expect(UI_SHARED_RULES.size,
      'список общих правил вырос. Каждое такое правило — шов между браузером и движком; '
      + 'новое пускается только с разбором, почему один ответ нужен обеим сторонам').toBe(2);
  });

  it('ни один импорт не нарушает allow-list своего слоя', async () => {
    const violations = [];

    for (const file of productionFiles()) {
      const sourceLayer = layerOfFile(file);
      const imports = await parseImports(file);

      for (const { specifier } of imports) {
        if (specifier == null) {
          const rel = path.relative(PROJECT_ROOT, file).split(path.sep).join('/');
          if (DYNAMIC_CATALOG_LOADERS.has(rel)) continue;
          violations.push(`${rel}: import(variable) — неразрешимый динамический импорт`);
          continue;
        }
        const kind = classifySpecifier(specifier);
        const rel = path.relative(PROJECT_ROOT, file);

        if (kind === 'builtin') continue;

        if (kind === 'package') {
          const allowed = ALLOWED_PACKAGES[sourceLayer];
          if (!allowed || !(allowed.has(specifier) || allowed.has(packageName(specifier)))) {
            violations.push(`${rel}: пакет '${specifier}' запрещён для слоя ${sourceLayer}`);
          }
          continue;
        }

        if (kind === 'relative') {
          const target = resolveRelative(file, specifier);
          if (!target) {
            violations.push(`${rel}: импорт '${specifier}' уходит за пределы проекта`);
            continue;
          }
          const targetLayer = layerOfFile(target);
          if (sourceLayer === 'ui' && UI_SHARED_RULES.has(relOf(target))) continue;
          const allowed = ALLOWED_RELATIVE[sourceLayer];
          if (!allowed || !allowed.has(targetLayer)) {
            violations.push(`${rel} → ${targetLayer}: импорт '${specifier}' запрещён для слоя ${sourceLayer}`);
          }
        }
      }
    }

    expect(violations, `Нарушения границ слоёв:\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('составные слои (messages) не импортируют ничего', async () => {
    const violations = [];
    for (const file of productionFiles()) {
      if (!ZERO_IMPORT_LAYERS.has(layerOfFile(file))) continue;
      const imports = await parseImports(file);
      if (imports.length) {
        violations.push(`${path.relative(PROJECT_ROOT, file)}: ${imports.length} импортов у слоя-данных`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('composition root: core+addons вместе имеет право тянуть только optimize2.mjs', async () => {
    const violators = [];
    for (const file of productionFiles()) {
      const sourceLayer = layerOfFile(file);
      if (sourceLayer === 'addons') continue;
      if (sourceLayer === 'root:optimize2.mjs' || sourceLayer === 'root:server.mjs') continue;
      const imports = await parseImports(file);
      const targets = new Set(
        imports
          .filter((i) => classifySpecifier(i.specifier) === 'relative')
          .map((i) => (i.specifier ? layerOfFile(resolveRelative(file, i.specifier)) : null))
          .filter(Boolean),
      );
      if (targets.has('core') && targets.has('addons')) {
        violators.push(`${path.relative(PROJECT_ROOT, file)}: тянет core И addons одновременно`);
      }
    }
    expect(violators, `Проводка core+addons вне composition root:\n  ${violators.join('\n  ')}`).toEqual([]);
  });
});
