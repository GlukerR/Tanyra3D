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
  // Подставляется в {cause} строкой ниже — отдельным сообщением, чтобы переводилась.
  'check.cause.secondPass': ({ ids }) => `second-pass extensions (${ids}) or file writing`,
  'check.cause.writeOnly': () => 'file writing (no second-pass fixes were applied)',
  'check.baselineHardMismatch': ({ k, baseline, after, cause }) =>
    `Component guarantee violated: ${k} changed after the extensions (was ${baseline} at checkpoint, now ${after}). `
    + "Per the components' official docs (ARCHITECTURE.md §0a) Draco/Meshopt/KTX2 do not change mesh structure. "
    + `Likely cause: ${cause} — a library bug or incorrect component use. `
    + 'The file was written, but do not trust it as an exact copy of the source geometry — check the result visually before shipping it.',

  // --- engine-level messages ---
  'feature.notEnabled': ({ feature }) => `feature "${feature}" is not enabled (advancedFeatures: ['${feature}'])`,
  // The feature was on, but there was nothing to change. Staying silent is not an
  // option: the person ticked the box and must learn what became of it.
  'engine.nothingToDo': () => 'turned on, but this model had nothing to change',
  'engine.feature.exclusive': ({ selected }) => `not applied because ${selected} was selected instead`,
  // Строка «что пропущено — почему». Собрана сообщением, а не склейкой в коде: разделитель
  // между частями — часть языка, и другому он может понадобиться другой.
  'engine.skipped.line': ({ title, reason }) => `${title} — ${reason}`,

  // --- input compression ---
  'engine.inputCompression.found': ({ codecs }) => `input geometry is already compressed (${codecs}) — decompressed on load`,
  'engine.inputCompression.reencode': ({ codec }) => `re-encoded from scratch (${codec}), no double compression or hidden re-packing`,
  'engine.inputCompression.noCompress': () => 'geometry exported uncompressed (no geometry compression option selected)',
  'engine.inputCompression.applied': ({ codecs, note }) => `Removed input compression ${codecs} — ${note}`,

  // --- input validation ---
  'engine.inputValidation.found': ({ n }) => `the input file already has ${n} gltf-validator error${n === 1 ? '' : 's'} (an export defect, not the optimization)`,

  // --- policy ---
  'engine.policy.safetyLevel': ({ tier }) => `safety level "${tier}" is not applied automatically`,
  'engine.policy.unknownSafetyLevel': ({ tier }) => `the engine does not know the safety level "${tier}" — the rule was skipped`,
};
