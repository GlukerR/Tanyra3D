// core/contract.mjs — то, о чём движок и аддон договариваются между собой.
//
// Вынесено из engine.mjs по ARCH-001: аддон импортировал константы и функцию прямо
// из движка (`addons/gltf/index.mjs` → `core/engine.mjs`), а движок вызывает методы
// аддона — получалась двусторонняя связь. Ни один из двух не «главнее», просто
// обоим нужен общий словарь: политика автофикса, идентификаторы находок уровня
// движка и правила сверки baseline-checkpoint. Теперь оба зависят от этого модуля,
// а он — ни от кого. Формат-специфичного здесь нет и быть не должно.

// Политика автофикса (ARCHITECTURE.md §2.4): применяем provable + numeric + perceptual
// (perceptual = KTX2/UASTC — пользователь выбрал сам и доволен). lossy — никогда
// автоматом; только явный force из canFix (например флаг --strip-vertex-colors).
export const TIER_RANK = { provable: 0, numeric: 1, perceptual: 2, lossy: 3 };
export const AUTOFIX_MAX_TIER = 'perceptual';

// Находки/применения уровня движка (вне правил аддона) — стабильные ruleId «engine/*».
// Аддон может ссылаться на них (напр. gltf/validate — на inputValidation).
export const ENGINE_META = {
  inputCompression: { id: 'engine/input-compression', category: 'geometry', severity: 'info', fixSafety: 'provable', reversible: true, dataLoss: 'none' },
  inputValidation: { id: 'engine/input-validation', category: 'scene', severity: 'warn', fixSafety: 'none', reversible: true, dataLoss: 'none' },
};

// BASELINE-CHECKPOINT: сверка снимка структуры (после базового прохода) с метриками
// реальных байтов будущего файла. Жёсткие ключи (треугольники/скины/узлы/анимации/
// draw-calls) не должны меняться — их расхождение блокирует запись (нарушение гарантии
// компонента). Мягкие ключи (soft, напр. vertices) — только информируют: кодек может
// переиндексировать/сваривать вершины при сериализации (Draco зовёт weld перед сжатием),
// это меняет ЧИСЛО вершин, но не треугольники и топологию — для неанимированной модели
// это легитимная полная оптимизация, для анимированной защищают строгие ключи skins/
// animations. Возвращает строки валидации в порядке отчёта; логирует посписочную сверку.
export function compareBaseline(baseline, after, keys, { advancedPlannedIds = [], log = () => {}, soft = new Set() } = {}) {
  for (const k of keys) {
    log(`      [baseline-validate] ${k}: ${baseline[k]} → ${after[k]}${after[k] === baseline[k] ? '' : '  ← MISMATCH'}`);
  }
  const broken = keys.filter((k) => after[k] !== baseline[k]);
  if (broken.length === 0) {
    return [{ level: 'pass', text: `baseline-checkpoint: structure (${keys.join(', ')}) matches the checkpoint taken after the basic optimizations` }];
  }
  const cause = advancedPlannedIds.length
    ? `second-pass extensions (${advancedPlannedIds.join(', ')}) or file writing`
    : 'file writing (no second-pass fixes were applied)';
  return broken.map((k) => (soft.has(k)
    ? {
      level: 'info',
      text: `${k} changed during encoding (was ${baseline[k]} at checkpoint, now ${after[k]}) — `
        + `the codec re-indexed/welded vertices (e.g. Draco calls weld before compression). `
        + `Triangles and mesh topology are preserved; writing is not blocked. For animated models the strict keys (skins, animations) protect the structure.`,
    }
    : {
      level: 'fail',
      text: `Component guarantee violated: ${k} changed after the extensions (was ${baseline[k]} at checkpoint, now ${after[k]}). `
        + `Per the components' official docs (ARCHITECTURE.md §0a) Draco/Meshopt/KTX2 do not change mesh structure. `
        + `Likely cause: ${cause} — a library bug or incorrect component use. File NOT written.`,
    }));
}
