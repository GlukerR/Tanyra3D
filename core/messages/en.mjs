export default {
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

  'feature.notEnabled': ({ feature }) => `feature "${feature}" is not enabled (advancedFeatures: ['${feature}'])`,
  'engine.nothingToDo': () => 'turned on, but this model had nothing to change',
  'engine.feature.exclusive': ({ selected }) => `not applied because ${selected} was selected instead`,
  'engine.outDirGone': () => 'the work folder was cleared while the model was being built — nothing was written. Build it again.',
  'engine.skipped.line': ({ title, reason }) => `${title} — ${reason}`,

  'engine.inputCompression.found': ({ codecs }) => `input geometry is already compressed (${codecs}) — decompressed on load`,
  'engine.inputCompression.reencode': ({ codec }) => `re-encoded from scratch (${codec}), no double compression or hidden re-packing`,
  'engine.inputCompression.noCompress': () => 'geometry exported uncompressed (no geometry compression option selected)',
  'engine.inputCompression.applied': ({ codecs, note }) => `Removed input compression ${codecs} — ${note}`,

  'engine.inputValidation.found': ({ n }) => `the input file already has ${n} gltf-validator error${n === 1 ? '' : 's'} (an export defect, not the optimization)`,

  'engine.policy.safetyLevel': ({ tier }) => `safety level "${tier}" is not applied automatically`,
  'engine.policy.unknownSafetyLevel': ({ tier }) => `the engine does not know the safety level "${tier}" — the rule was skipped`,
};
