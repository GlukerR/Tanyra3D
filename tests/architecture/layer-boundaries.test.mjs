// tests/architecture/layer-boundaries.test.mjs — структурный гейт границ слоёв.
//
// Правила — таблица §2.4 АРХИТЕКТУРНЫЕ_ТЕСТЫ.md (проверена по коду 2026-08-03):
//
//   core/*        → node:*, ./ (core). Запрещено: three, gltf-transform, addons, ui.
//   addons/gltf/* → node:*, @gltf-transform/*, draco3dgltf, meshoptimizer,
//                   ../../core/*, ./ (свои). Запрещено: ui/, optimize2.mjs,
//                   server.mjs, assistant.mjs. (+ пакеты gltf-validator, sharp —
//                   ленивые динамические импорты аддона, оба в dependencies).
//   optimize2.mjs → core + addons (composition root).
//   server.mjs    → верхний шов: node:*, ./optimize2.mjs, ./core/i18n.mjs,
//                   ./assistant.mjs (динамически).
//   assistant.mjs → node:*, ./messages/*. Запрещено: optimize2.mjs (контракт §4c).
//   ui/*          → three, three/addons/*, ./ (свои). Запрещено: core, addons.
//
// Плюс правило composition root: импортировать И core, И addons имеет право
// только optimize2.mjs (server.mjs — через optimize2). И ни один слой не имеет
// права импортировать ui/.
//
// Инструмент — es-module-lexer@2.3.1 (см. ./import-graph.mjs): тот же
// лексер, что у Vite. Оговорка из §4.1: import(variable) статически неразрешим —
// в коде таких импортов нет, гейт это проверяет (specifier === null).

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { PROJECT_ROOT, productionFiles, parseImports, classifySpecifier, resolveRelative, layerOfFile } from './import-graph.mjs';

// Пакеты, которые вправе импортировать слой. Ключ — layerKey файла-источника.
const ALLOWED_PACKAGES = {
  addons: new Set([
    '@gltf-transform/core', '@gltf-transform/functions', '@gltf-transform/extensions',
    'draco3dgltf', 'meshoptimizer', 'gltf-validator', 'sharp',
  ]),
  // three и three/addons/*, плюс плагины к загрузчику three.js.
  //
  // Плагин просмотра пускается в слой ui ОСОЗНАННО и по одному признаку: он не меняет
  // в выходном файле ни байта. KHR_animation_pointer — расширение, которое загрузчик
  // three.js не читает сам, и без плагина модель с такой анимацией показывается как
  // неподвижная. Это свойство ПОКАЗА, а не оптимизации.
  //
  // Граница остаётся прежней и проверяется тем же вопросом: попробуй убрать пакет —
  // если выходной GLB изменился хоть на байт, пакету не место в ui. Ядро и аддоны
  // про него по-прежнему не знают, и обратный импорт (ui → core/addons) запрещён
  // ниже без исключений.
  // three-gltf-extensions добавлен 2026-08-15 по тому же признаку. Нужен один плагин из
  // него — KHR_materials_variants: запасные цвета и отделки, между которыми модель умеет
  // переключаться. Загрузчик three.js их не читает, и без плагина художник видит один
  // вид из трёх, ничего об остальных не зная. Показ, а не оптимизация: выходной GLB не
  // меняется ни на байт — за сохранность самих вариантов отвечает движок
  // (tests/variants-survive.test.mjs), и от этого пакета она никак не зависит.
  ui: new Set(['three', '@needle-tools/three-animation-pointer', 'three-gltf-extensions']),
};

// Слои-цели относительных импортов, разрешённые для каждого слоя-источника.
const ALLOWED_RELATIVE = {
  core: new Set(['core']),
  addons: new Set(['core', 'addons']),
  ui: new Set(['ui']),
  'root:optimize2.mjs': new Set(['core', 'addons']),
  'root:server.mjs': new Set(['core', 'addons', 'root:optimize2.mjs', 'root:assistant.mjs']),
  'root:assistant.mjs': new Set(['messages']),
};

// Каталоги сообщений — чистые данные: импортировать их разрешено ассистенту,
// сами они не импортируют ничего.
const ZERO_IMPORT_LAYERS = new Set(['messages']);

// Нормализованное имя пакета: scoped-пакеты (@scope/name) — два сегмента.
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

  it('ни один импорт не нарушает allow-list своего слоя', async () => {
    const violations = [];

    for (const file of productionFiles()) {
      const sourceLayer = layerOfFile(file);
      const imports = await parseImports(file);

      for (const { specifier } of imports) {
        if (specifier == null) {
          violations.push(`${path.relative(PROJECT_ROOT, file)}: import(variable) — неразрешимый динамический импорт`);
          continue;
        }
        const kind = classifySpecifier(specifier);
        const rel = path.relative(PROJECT_ROOT, file);

        if (kind === 'builtin') continue; // node:* — разрешён всем слоям

        if (kind === 'package') {
          const allowed = ALLOWED_PACKAGES[sourceLayer];
          if (!allowed || !allowed.has(packageName(specifier))) {
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
      // Файлы ВНУТРИ addons/ исключены по определению: импорт core из аддона —
      // санкционированное направление зависимости (аддон → core, §2.1), а не
      // «проводка» core+addons. Проводка — это когда НЕ-аддон тянет и то, и другое.
      if (sourceLayer === 'addons') continue;
      if (sourceLayer === 'root:optimize2.mjs' || sourceLayer === 'root:server.mjs') continue; // легитимные
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

  // ui → core/addons отдельного теста не требует: главный allow-list уже запрещает
  // это (ALLOWED_RELATIVE['ui'] = {'ui'} — относительный импорт из ui в core/addons
  // не пройдёт). Дублировать проверку — значит плодить второй источник правды.
});
