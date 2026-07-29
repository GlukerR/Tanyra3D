// messages/en.mjs — English catalog of AI Assistant texts (assistant.mjs).
//
// Тексты ОТЧЁТА: итог сборки, главные улучшения, план платформы, предупреждения.
// Отдельно от addons/*/messages — там строки правил обработки, они принадлежат аддону
// и остаются английскими (см. ui/locales/README.md). Здесь — наш слой, который читает
// человек без опыта 3D-оптимизации, и его переводим.
//
// Значение — функция (data) => string. Английский каталог обязателен: на него откатывается
// любой другой при нехватке ключа.

export default {
  // --- план платформы (planFor) ---
  'plan.geometry.draco': () => 'Geometry will be compressed with a proven method (Draco) — the file gets noticeably lighter and the model unpacks in the browser.',
  'plan.geometry.meshopt': () => 'Geometry will be compressed with a modern method (meshopt) — a smaller file that unpacks quickly right on the GPU.',
  'plan.cleanup': () => 'We remove junk without changing the picture: duplicate materials and textures, unused data, invisible triangles and orphan vertices.',
  'plan.textures.keep': () => 'Textures stay in a universal form (PNG/WebP) — they open in any browser without extra loaders. GPU KTX2 compression is available as an advanced option.',
  'plan.textures.uastc': () => 'Textures are converted to a high-quality GPU format — the picture stays sharp while needing less video memory.',
  'plan.textures.mixed': () => 'Color textures are compressed into a light format for fast loading, and detail maps into a more precise one. This saves both traffic and video memory.',
  'plan.parts.join': () => 'Small parts are joined into a single model — the GPU needs fewer separate draw calls.',
  'plan.parts.keep': () => 'Individual model parts are kept as they are — not joined.',
  'plan.stripColors': () => 'Unused vertex colors are removed — they only make the file heavier.',
  'plan.goal': ({ title, bits }) => `Goal — fit the "${title}" platform budget: ${bits}.`,
  'plan.goal.triangles': ({ n }) => `up to ${n} triangles`,
  'plan.goal.textureSize': ({ px }) => `textures up to ${px}px`,
  'plan.goal.vram': ({ mb }) => `up to ${mb} MB video memory`,

  // --- нештатные статусы ---
  'status.error': ({ error }) => `Could not process the model: ${error}`,
  'status.skip': () => 'Model skipped: a result for it already exists. To rebuild it, enable overwrite.',
  'status.noMetrics': () => 'Processing did not reach the result stage — model data is unavailable.',

  // --- итог ---
  'summary.done': ({ fileBefore, fileAfter, filePct, vramBefore, vramAfter, vramPct }) =>
    `Done. File: ${fileBefore} → ${fileAfter} (${filePct}); texture video memory: ${vramBefore} → ${vramAfter} (${vramPct}).`,
  'summary.failPrefix': () => 'Result check did not pass — the optimized file was not written. ',
  'summary.fileGrewVramDropped': () => ' The file got slightly heavier but video memory dropped: the GPU texture format weighs more in the file yet takes far less on the GPU.',

  // --- главные улучшения ---
  'hi.fileLighter': ({ pct }) => `File is ${pct}% lighter — faster to load.`,
  'hi.vramTimesLess': ({ times }) => `Texture video memory is ${times} smaller — the model won't eat memory on weak devices.`,
  'hi.vramDropped': () => 'Texture video memory dropped — the model is gentler on weak devices.',
  'hi.vramPct': ({ pct }) => `Texture video memory is ${pct}% lower — smoother on weak GPUs.`,
  'hi.drawCalls': ({ before, after }) => `Rendering is simpler: draw calls ${before} → ${after} — less GPU load.`,
  'hi.shapeKept': ({ n }) => `Model shape fully preserved (${n} triangles) — geometry untouched.`,
  'hi.trianglesRemoved': ({ before, after }) => `Extra triangles removed: ${before} → ${after}.`,
  'hi.applied': ({ n }) => `Safe improvements applied: ${n} — each verified, shape and materials not distorted.`,

  // --- бюджет платформы ---
  'unit.mb': () => 'MB',
  'budget.triangles': () => 'Triangles',
  'budget.materials': () => 'Materials',
  'budget.drawCalls': () => 'Draw calls',
  'budget.vram': () => 'Texture video memory',
  'budget.file': () => 'File size',
  'budget.recommended': ({ v }) => `recommended up to ${v}`,
  'budget.limit': ({ v }) => `platform limit ${v}`,
  'advice.overLimit': ({ name, actual, limit }) =>
    `${name}: ${actual} against the platform limit of ${limit}. Files above the limit are rejected or re-compressed by the platform without asking.`,
  'advice.triangles': ({ actual, warn }) =>
    `${actual} triangles against a recommended ${warn}. Not an error — heavy scenes just load and render slower. Simplify the model on export if that matters here.`,
  'advice.materials': ({ actual, warn }) =>
    `${actual} materials against a recommended ${warn}. Each material is a separate draw call; merging them on export lowers GPU load.`,
  'advice.drawCalls': ({ actual, warn }) =>
    `${actual} draw calls against a recommended ${warn}. Join parts and reduce the number of materials on export.`,
  'advice.vram': ({ actual, warn }) =>
    `Textures take ${actual} of video memory against a recommended ${warn}. Lower the texture resolution or use fewer maps.`,
  'advice.file': ({ actual, warn }) =>
    `The file is ${actual} against a recommended ${warn}. Not a limit — just slower to load on a weak connection.`,

  // --- предупреждения ---
  'warn.notApplied': ({ text, reason }) => `Not applied: ${text}${reason}`,
};
