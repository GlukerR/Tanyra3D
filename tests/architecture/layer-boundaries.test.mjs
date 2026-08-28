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
//   ui/*          → three, three/addons/*, ./ (свои). Запрещено: core, addons —
//                   кроме поимённого списка ОБЩИХ ПРАВИЛ без единого импорта
//                   (UI_SHARED_RULES ниже; сегодня там один файл).
//
// Плюс правило composition root: импортировать И core, И addons имеет право
// только optimize2.mjs (server.mjs — через optimize2). И ни один слой не имеет
// права импортировать ui/.
//
// Инструмент — es-module-lexer@2.3.1 (см. ./import-graph.mjs): тот же
// лексер, что у Vite. Оговорка из §4.1: import(variable) статически неразрешим —
// такие импорты гейт считает нарушением (specifier === null), потому что они слепое
// пятно: из вычисленного адреса не видно, какой слой импортируется.
//
// ИСКЛЮЧЕНИЕ РОВНО ОДНО И ОНО ПЕРЕЧИСЛЕНО ПОИМЁННО — DYNAMIC_CATALOG_LOADERS ниже.
// Перечислено, а не разрешено вообще: слепое пятно остаётся слепым, поэтому список
// закрытый, а отдельная проверка требует, чтобы каждый файл в нём такой импорт
// действительно содержал. Список, из которого можно молча выпасть, — не гейт.

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
    // FBX добавлен 2026-08-22 по тому же узкому признаку и с той же проверкой: это ОДИН
    // модуль, а не пакет three. Пакет целиком по-прежнему запрещён, и это стоило работы —
    // менеджер загрузки и заглушку текстуры пришлось написать своей формы (см. шапку
    // nameOnlyManager в addons/gltf/import-fbx.mts). Соблазн вписать сюда 'three' ради
    // двух конструкторов был, и поддаться ему значило бы впустить в слой аддонов рендерер.
    'three/examples/jsm/loaders/FBXLoader.js',
    // OBJ добавлен 2026-08-23 — третий из тройки, которую называл Александр («фбикс стл
    // обджи на загрузке»). Признак тот же: ОДИН модуль разбора, работающий в Node без
    // единого браузерного вызова (проверено пробой). Соседний `.mtl` мы читаем СВОИМ
    // кодом, а не MTLLoader: тот создаёт материалы three и зовёт TextureLoader, то есть
    // потянул бы за собой ровно то, чего эта граница не пускает.
    'three/examples/jsm/loaders/OBJLoader.js',
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

/**
 * Файлы, которым разрешён ОДИН вычисленный `import()` — загрузка каталогов языков.
 *
 * Появилось 2026-08-26 по находке Ф4-3 аудита. До неё список языков лежал статическими
 * импортами в трёх файлах кода, и добавление языка означало правку `core/`. Замер это
 * показал: положив два файла по инструкции `ui/locales/README.md`, контрибутор получал
 * переведённую обвязку интерфейса и английские описания площадок, подписи опций и отчёт.
 *
 * Статического способа здесь нет и быть не может: каталог — это МОДУЛЬ (в значениях
 * живут функции, поэтому JSON не годится), а модуль по вычисленному пути грузится только
 * через `import()`. Единственная альтернатива — рукописный перечень файлов, то есть тот
 * же дубль факта, который и чинили.
 *
 * Почему это не дыра в гейте. Импортируется папка `messages/` рядом с самим файлом —
 * слой `messages`, объявленный выше как данные без единого импорта. Ни один другой слой
 * так достаться не может: вычисленное имя проверяется регуляркой `<код>.mjs`.
 */
const DYNAMIC_CATALOG_LOADERS = new Set(['core/i18n.mjs', 'assistant.mjs']);

/**
 * Модули ядра, которые вправе читать и слой ui. Список закрытый и ПРОВЕРЯЕМЫЙ.
 *
 * Появилось 2026-08-28 вместе с `core/lod-grouping.mjs` — тем, что решает, считать ли
 * соседние узлы уровнями детализации. Спрашивают об этом двое: отчёт (движок, документ
 * gltf-transform) и переключатель над моделью (браузер, сцена three.js). Данные разные,
 * а правило обязано быть одно: разойдись они — человек увидит уровни в окне и ни строчки
 * про них в правой панели. Ровно этот класс расхождений и запрещают Правила интерфейса §1
 * («один вопрос — один ответ в одном месте»), и повод для исключения именно он, а не
 * экономия строк.
 *
 * ПРИЗНАК, ПО КОТОРОМУ ПУСКАЕТСЯ, И ОН ПРОВЕРЯЕТСЯ ОТДЕЛЬНЫМ ТЕСТОМ: у модуля НОЛЬ
 * импортов. Чистое решение, числа на входе, числа на выходе. Поэтому впустить через него
 * в браузер движок нельзя физически — не за что зацепиться. Разреши мы вместо этого
 * «слой ui → слой core», и завтра во вьюпорт приехал бы `core/engine.mjs`, а сторож
 * промолчал бы: он сводит импорт к слою и разницы не увидел бы.
 *
 * Обратное направление (любой слой → ui) остаётся запрещённым без исключений.
 */
const UI_SHARED_RULES = new Set(['core/lod-grouping.mjs']);

/** Путь файла относительно корня, всегда через прямые слэши. */
const relOf = (file) => path.relative(PROJECT_ROOT, file).split(path.sep).join('/');

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

  it('исключение под каталоги языков не протухло и не разрослось', async () => {
    // Две половины, и обе обязательны.
    //
    // Первая: каждый файл списка ДЕЙСТВИТЕЛЬНО содержит вычисленный import(). Иначе
    // исключение переживёт код, ради которого выдано, и станет тихой дырой — гейт
    // перестанет замечать слепое пятно, которого уже нет повода прощать.
    //
    // Вторая: файлов ровно столько, сколько названо. Список закрытый; чтобы добавить в
    // него третий, придётся править этот тест — то есть объяснить причину человеку,
    // а не дописать строку между делом.
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
    // Признак, по которому выдано исключение, проверяется, а не описан в комментарии.
    // Ноль импортов — значит через этот модуль в браузер не приедет ни ядро, ни
    // gltf-transform, ни что-либо ещё. Появится у него первый импорт — тест покраснеет,
    // и решать придётся человеку, а не сторожу.
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
      + 'новое пускается только с разбором, почему один ответ нужен обеим сторонам').toBe(1);
  });

  it('ни один импорт не нарушает allow-list своего слоя', async () => {
    const violations = [];

    for (const file of productionFiles()) {
      const sourceLayer = layerOfFile(file);
      const imports = await parseImports(file);

      for (const { specifier } of imports) {
        if (specifier == null) {
          const rel = path.relative(PROJECT_ROOT, file).split(path.sep).join('/');
          if (DYNAMIC_CATALOG_LOADERS.has(rel)) continue;   // загрузка каталогов языков
          violations.push(`${rel}: import(variable) — неразрешимый динамический импорт`);
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
          // Поимённое исключение: общее правило, у которого нет собственных импортов.
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
