// core/messages/en.mjs — английский каталог сообщений ядра.
// Ключи baseline-checkpoint, ошибок контракта и прочие сообщения движка.
// Зарегистрирован в core/engine.mjs.
//
// Значение — функция (data → строка).

export default {
  // --- baseline-checkpoint ---
  'check.baselineMatch': ({ keys }) => `baseline-checkpoint: structure (${keys}) matches the checkpoint taken after the basic optimizations`,
  'check.baselineSoftMismatch': ({ k, baseline, after }) =>
    `${k} changed during encoding (was ${baseline} at checkpoint, now ${after}) — `
    + 'the codec re-indexed/welded vertices (e.g. Draco calls weld before compression). '
    + 'Triangles and mesh topology are preserved; writing is not blocked. For animated models the strict keys (skins, animations) protect the structure.',
  'check.baselineHardMismatch': ({ k, baseline, after, cause }) =>
    `Component guarantee violated: ${k} changed after the extensions (was ${baseline} at checkpoint, now ${after}). `
    + "Per the components' official docs (ARCHITECTURE.md §0a) Draco/Meshopt/KTX2 do not change mesh structure. "
    + `Likely cause: ${cause} — a library bug or incorrect component use. File NOT written.`,

  // --- engine-level messages ---
  'feature.notEnabled': ({ feature }) => `feature "${feature}" is not enabled (advancedFeatures: ['${feature}'])`,
};
