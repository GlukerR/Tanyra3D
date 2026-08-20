// tests/architecture/layer-boundaries.test.mjs — структурный гейт границ слоёв.
//
// Правила — таблица §2.4 АРХИТЕКТУРНЫЕ_ТЕСТЫ.md (проверена по коду 2026-08-03):
//
//   core/*        → node:*, ./ (core). Запрещено: three, gltf-transform, addons, ui.
//   addons/gltf/* → node:*, @gltf-transform/*, draco3dgltf, meshoptimizer,
//                   ../../core/*, ./ (свои). Запрещено: ui/, optimize2.mjs,
//                   server.mjs, assistant.mjs. (+ пакеты gltf-validator, sharp —
//                   ленивые динамические импорты аддона, оба в dependencies;
//                   + ДВА КОНКРЕТНЫХ модуля three — разборщики STL и PLY, именно
//                   модуля, а не пакет целиком: см. ALLOWED_PACKAGES ниже).
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
    // Разборщики чужих форматов из three.js — добавлены 2026-08-20 вместе с приёмом
    // STL и PLY (addons/gltf/importers.mts). Пускаются ОСОЗНАННО и по узкому признаку.
    //
    // Что именно берётся: две функции `parse(ArrayBuffer) → геометрия`. Ни рендерера, ни
    // сцены, ни браузера — чистый разбор двоичных данных, который работает в Node
    // (проверено пробой; это же и причина делать STL/PLY на СЕРВЕРЕ, а не в браузере).
    //
    // Почему это не размывает границу. Слой аддонов отвечает на вопрос «как получить
    // документ glTF из файла», и для `.stl` разборщик — такой же инструмент, как
    // draco3dgltf для сжатой геометрии. Своего разборщика PLY мы писать не будем:
    // формат с переменной схемой свойств, и собственная его редакция была бы хуже
    // готовой, а не независимее.
    //
    // Проверка границы прежняя: убери пакет — что перестанет работать? Здесь перестанет
    // ЧИТАТЬСЯ вход, а не изменится выход. Обратного импорта (ui → addons) это не
    // касается, он по-прежнему запрещён без исключений.
    'three/examples/jsm/loaders/STLLoader.js',
    'three/examples/jsm/loaders/PLYLoader.js',
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
          // Разрешение бывает двух видов, и разница существенная:
          //   'three'                       — весь пакет, любой его модуль;
          //   'three/examples/.../STL.js'   — РОВНО этот модуль и ничего больше.
          //
          // Точечный вид заведён 2026-08-20 под разборщики STL и PLY в слое аддонов.
          // Разреши там весь `three` — и завтра туда же приедет рендерер, а сторож
          // промолчит: он сводит адрес к имени пакета и разницы не увидит. Узкая запись
          // оставляет границу проверяемой, а не оговорённой в комментарии.
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
