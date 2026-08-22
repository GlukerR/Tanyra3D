// core/messages/en.mjs — английский каталог сообщений ядра.
// Ключи baseline-checkpoint, ошибок контракта и прочие сообщения движка.
// Зарегистрирован в core/engine.mjs.
//
// Значение — функция (data → строка).

export default {
  // --- baseline-checkpoint ---
  'metric.triangles': () => 'triangles',
  'metric.vertices': () => 'vertices',
  'metric.drawCalls': () => 'draw calls',
  'metric.skins': () => 'skins',
  'metric.nodes': () => 'scene nodes',
  'metric.animations': () => 'animations',
  'metric.morphTargets': () => 'morph targets',
  'metric.attributes': () => 'vertex attributes',
  'check.baselineMatch': () => 'the model structure did not change during compression',
  'check.baselineSoftMismatch': ({ k, baseline, after }) =>
    `${k} were rebuilt by the codec: ${baseline} → ${after}. Triangles and the picture are unchanged.`,
  'check.baselineHardMismatch': ({ k, baseline, after }) =>
    `${k} changed after compression: ${baseline} → ${after}. This should not happen — look the model over before shipping it. Details are in the log.`,

  // --- engine-level messages ---
  'feature.notEnabled': ({ feature }) => `feature "${feature}" is not enabled (advancedFeatures: ['${feature}'])`,
  // The feature was on, but there was nothing to change. Staying silent is not an
  // option: the person ticked the box and must learn what became of it.
  'engine.nothingToDo': () => 'turned on, but this model had nothing to change',
  'engine.feature.exclusive': ({ selected }) => `not applied because ${selected} was selected instead`,
  // Папку под результат движок завёл сам, а к моменту записи её не стало: её убрали,
  // пока шла сборка. Причина известна — значит называем её, а не отдаём наружу путь
  // из UUID, по которому человек всё равно ничего не поймёт.
  'engine.outDirGone': () => 'the work folder was cleared while the model was being built — nothing was written. Build it again.',
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
