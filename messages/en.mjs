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
  'summary.doneWithIssue': ({ fileBefore, fileAfter, filePct, vramBefore, vramAfter, vramPct }) =>
    'Done, but the result differs from the source — see the integrity check for details. '
    + `File: ${fileBefore} → ${fileAfter} (${filePct}); texture video memory: ${vramBefore} → ${vramAfter} (${vramPct}).`,
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
  // "px" rather than "2048×2048": the platform threshold is stated as ONE side, and the
  // other side of a non-square texture has nothing to do with it.
  'unit.pxValue': ({ v }) => `${v} px`,
  // The same unit without a number: the caption next to an input field in the
  // "your own platform" form, where the number is typed by the person.
  'unit.px': () => 'px',
  'budget.textureSize': () => 'Largest texture',
  'budget.recommended': ({ v }) => `recommended up to ${v}`,
  'budget.limit': ({ v }) => `platform limit ${v}`,
  'advice.overLimit': ({ name, actual, limit }) =>
    `${name}: ${actual} against the platform limit of ${limit}. The platform rejects it.`,
  'advice.triangles': ({ actual, warn }) =>
    `${actual} triangles against a recommended ${warn}. Heavy scenes load and render slower. Simplify the model on export if that matters here.`,
  'advice.materials': ({ actual, warn }) =>
    `${actual} materials against a recommended ${warn}. Each material is a separate draw call; merging them on export lowers GPU load.`,
  'advice.drawCalls': ({ actual, warn }) =>
    `${actual} draw calls against a recommended ${warn}. Join parts and reduce the number of materials on export.`,
  'advice.vram': ({ actual, warn }) =>
    `Textures take ${actual} of video memory against a recommended ${warn}. Lower the texture resolution or use fewer maps.`,
  'advice.textureSize': ({ actual, warn }) =>
    `The largest texture is ${actual} on its longer side, against ${warn} recommended. Every doubling of the side takes four times the video memory, and on a phone screen the difference is usually invisible.`,
  'advice.file': ({ actual, warn }) =>
    `The file is ${actual} against a recommended ${warn}. The heavier the file, the longer it takes to open on a weak connection.`,

  // --- предупреждения ---
  'warn.notApplied': ({ text, reason }) => `Not applied: ${text}${reason}`,

  // ------------------------------------------------------------------
  // Option texts — ONCE per language, not copied into every profile.
  // See the Russian catalogue for the full rationale (2026-08-04).
  // ------------------------------------------------------------------
'option.safe.title': () => 'Safe optimizations',
  'option.safe.description': () => 'Lossless cleanup: dedup materials/textures, remove unused data, weld identical vertices, drop degenerate and orphan geometry. Shape and materials are not changed.',
  'option.safe.impact': () => 'Smaller file with no visible change.',
  'option.meshopt.title': () => 'Meshopt compression',
  'option.meshopt.description': () => 'Compresses geometry with Meshopt — smaller file that unpacks quickly on the GPU. A good default for the web.',
  'option.meshopt.impact': () => 'Noticeably smaller geometry; fast decode in the browser.',
  'option.join.title': () => 'Join meshes',
  'option.join.description': () => 'Merges separate parts into one mesh — fewer draw calls. Structural: individual parts cannot be restored from the result.',
  'option.join.impact': () => 'Fewer draw calls; parts are merged (irreversible).',
  'option.instance.title': () => 'GPU instancing',
  'option.instance.description': () => 'Turns repeated meshes into copies drawn by the graphics card — fewer separate draws per frame. The target site has to support this.',
  'option.instance.impact': () => 'Fewer draw calls when the scene repeats meshes.',
  'option.keep-unused-uv.title': () => 'Drop the unused UV',
  'option.keep-unused-uv.description': () => 'Cleanup drops a UV layout no image uses — it only takes up space. Untick this when the finish is chosen on the site itself: a configurator for furniture, clothing or surfaces. The UV then survives the build, and so does other vertex data no material reads right now.',
  'option.keep-unused-uv.impact': () => 'The file gets heavier: 14% to 65% in our measurements — other vertex data is kept along with the UV.',
  'option.strip-dead-interactivity.title': () => 'Remove empty clicks',
  'option.strip-dead-interactivity.description': () => 'A model can carry parts marked as clickable with no response written for them: on a site the cursor turns into a hand, the visitor clicks — and nothing happens. This removes those marks. Working parts and the behaviour itself are left alone.',
  'option.strip-dead-interactivity.impact': () => 'The mark cannot be put back — only rebuilt from the original.',
  'option.resample.title': () => 'Resample',
  'option.resample.description': () => 'Removes redundant animation keyframes without changing the motion — smaller animation data.',
  'option.resample.impact': () => 'Smaller animations; no visible change.',
  'option.ktx2.title': () => 'KTX2 compression',
  'option.ktx2.description': () => 'Converts textures to a format the graphics card keeps compressed: up to ~80% less video memory. The site has to be able to open such textures — without that the model will not show.',
  'option.ktx2.impact': () => 'The file may grow 5–10%, but texture video memory drops several-fold.',
  'option.webp.title': () => 'WebP compression',
  // Rewritten 2026-08-17. The old text promised that textures already prepared for the
  // graphics card are left alone — no longer true (Rule 12) — and said nothing about
  // quality, which is the option's main lever.
  'option.webp.description': () => 'Converts the model\'s textures to a leaner format — the file gets smaller, video memory stays the same. Quality is measured against the model itself: we will not squeeze harder than the source, and we cannot make it better than the source. Textures already in this format are left untouched. The site needs nothing extra to open this.',
  'option.webp.impact': () => 'A markedly smaller download — the page opens faster. The slider decides what you pay with: the lower it goes, the lighter the file and the coarser the picture. An uncompressed texture is left untouched at the top of the scale; an already-compressed one loses a little regardless — that is how any second round of compression works. Getting lost quality back takes a fresh build from the original model.',
  'option.draco.title': () => 'Draco compression',
  'option.draco.description': () => 'Minimal file weight (often −50% on geometry). Decodes slower than Meshopt in the browser but is supported everywhere.',
  'option.draco.impact': () => 'The file is noticeably lighter; decoding on open is slower.',
  'option.quantize.title': () => 'Quantization',
  'option.quantize.description': () => 'Quantization means writing vertex coordinates with fewer digits: instead of a long precise number, a shorter approximate one. The geometry gets lighter and the site needs nothing extra to open it — unlike Draco and Meshopt. Coordinates become slightly coarser: on a small detailed model that can show up as tiny gaps.',
  'option.quantize.impact': () => 'Geometry drops by a third to a half. The gain shows up in the file only when the weight is in the geometry, not in the textures.',
  // Texture sizes: the label only — no description, no "what it costs".
  // Alexander, 2026-08-12: the book is not needed here at all, the number says it. When
  // there is text worth reading, the icon comes back on its own — the interface draws it
  // from the presence of a description.
  'option.resize-4096.title': () => '4096 × 4096',
  'option.resize-2048.title': () => '2048 × 2048',
  'option.resize-1024.title': () => '1024 × 1024',
  'option.resize-512.title': () => '512 × 512',
  'option.strip-colors.title': () => 'Remove vertex colors',
  'option.strip-colors.description': () => 'Removes painted vertex colors. Enable only if vertex colors are not visible in the model (white channels are removed without this option too).',
  'option.strip-colors.impact': () => 'Saves 5–20% of size if colors exist; may change the look if they were used.',
};
