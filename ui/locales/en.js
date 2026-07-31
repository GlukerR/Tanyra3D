// ui/locales/en.js — English catalog of interface strings.
// Ключи те же, что в ru.js. Значение — строка с подстановками {name} или функция.
// Тексты отчёта (итог, бюджеты, предупреждения) приходят с сервера и живут отдельно.

window.I18N_CATALOGS = window.I18N_CATALOGS || {};
window.I18N_CATALOGS.en = {
  'lang.name': 'English',

  // Единицы и формат чисел. 'unit.locale' — тег для Number.toLocaleString:
  // разделитель разрядов у языков разный (500,000 против 500 000).
  'unit.kb': 'KB',
  'unit.mb': 'MB',
  'unit.locale': 'en-US',
  'pct.noChange': 'no change',

  // --- левая панель ---
  'outliner.models': 'Models',
  'outliner.sub': 'GLB optimizer',
  'outliner.add': 'Add a model',
  'outliner.metadata': '⊞ Metadata',
  'outliner.metadata.title': 'Asset metadata (scenes, meshes, materials…)',
  'outliner.validation': '✓ Validation',
  'outliner.validation.title': 'Khronos glTF validation report',
  'dropzone.title': 'Drop a 3D model here',
  'dropzone.sub': 'or click + · .glb for now',
  'dropzone.rejected': 'Only .glb is supported for now',

  // --- журнал ---
  'logs.label': 'Logs',
  'logs.open': 'Open logs',
  'logs.none': 'no messages',
  'logs.empty': 'No log messages yet.',
  'logs.clear': 'Clear',

  // --- вьюпорты ---
  'vp.original': 'ORIGINAL MESH',
  'vp.optimized': 'OPTIMIZED MESH',
  'vp.splitter': 'Drag to resize',
  'vp.reset': 'Reset view',
  'vp.link': 'Link cameras',
  'vp.exposure': 'Exposure',
  'vp.play': 'Play animation',
  'vp.pause': 'Pause animation',
  'vp.clip': 'Animation clip',
  'vp.time': 'Animation time',
  'stage.hint': 'Load a .glb from the left panel to preview it here',

  // --- окна ---
  'win.close': 'Close',
  'win.metadata': 'Metadata',
  'win.validation': 'Validation',
  'win.logs': 'Logs',
  'win.export': 'Export result',
  'win.error': 'Error',
  'export.name': 'File name',
  'export.format': 'Format',
  'export.glb': '<b>GLB</b> — single binary, ready for the web',
  'export.json': '<b>glTF JSON</b> — self-contained .gltf with embedded data',
  'export.hint': "Saves to your browser's downloads folder.",
  'export.save': 'Save',

  'fail.notWritten': 'File not written',
  'fail.text': 'The model failed the integrity check — the source file is untouched.',
  'fail.generic': 'Could not process the file',

  // --- инспектор ---
  'insp.platform': 'Platform',
  'insp.advanced': 'Advanced options',
  // Отказы панели опций. Показываются НА МЕСТЕ опций: пустая панель неотличима от
  // поломки интерфейса, строка с причиной — отличима.
  'opts.noServer': ({ error }) => `Optimization options could not be loaded: ${error}. The server may not be running — restart it and reload the page.`,
  'opts.noPlatforms': 'The server returned no target platforms, so there are no options to choose from. Check the profiles/ folder.',
  'opts.empty': ({ platform }) => `Platform "${platform}" offers no advanced options.`,
  'insp.summary': 'Summary',
  'insp.integrity': 'Integrity check',
  'insp.analysis': 'Analysis',
  'insp.budget': 'Budget check',
  'insp.warnings': 'Warnings',
  'insp.done': 'What was done',
  'insp.skipped': 'What was skipped',
  'insp.integrityFailed.title': 'Integrity check failed',
  'insp.integrityFailed.text': 'The file was written and can be downloaded, but the result differs from the source in ways the components promise not to change. Compare both viewports before shipping it.',
  'insp.irreversible.title': 'Irreversible changes applied',
  'insp.irreversible.text': 'Keep the source file — this data cannot be restored from the result. See Analysis for the list.',

  'btn.build': 'Build Optimized Model',
  'btn.rebuild': 'Rebuild with New Settings',
  'btn.download': 'DOWNLOAD RESULT',
  'btn.pickOption': 'Select an optimization to build',
  'btn.changeSetting': 'Change a setting to rebuild',

  // --- статус ---
  // Подписи индикатора ожидания во вьюпортах.
  'busy.loading': 'Loading',
  'busy.uploading': 'Uploading',
  'busy.optimizing': 'Building',

  // --- живой замер отрисовки в HUD вьюпортов ---
  // Показывается время кадра каждого вьюпорта, а не FPS: оба рисуются в одном
  // кадре, и раздельный счётчик кадров дал бы одинаковые числа. См. app.js renderPerf.
  // --- полноэкранная подсветка при перетаскивании ---
  'dropOverlay.title': 'Drop the model anywhere',
  'dropOverlay.sub': '.glb',

  'perf.draw': 'DRAW',
  'perf.ms': 'ms',
  'perf.fps': 'fps',
  'perf.faster': 'lighter',
  'perf.slower': 'heavier',
  'perf.title': 'Time this viewport spends preparing one frame, median over 60 frames. '
    + 'Measured on this machine, not on a visitor device — read it as a relative figure: '
    + 'how much lighter the model became, not what people will get.',
  'status.ready': 'Ready',
  'status.error': 'Error',
  'status.uploading': 'Uploading file…',
  'status.optimizing': 'Optimizing…',
  'status.failed': 'File failed validation',
  'status.phase': 'Phase {n}: {name}',
  'status.rule': 'Rule: {title}',

  // --- группы опций ---
  'group.cleanup': 'Cleanup',
  'group.structural': 'Structural',
  'group.geometry': 'Geometry',
  'group.textures': 'Textures',
  'group.animation': 'Animation',

  // --- значки у опций ---
  'ext.details': 'Details: {name}',
  'ext.impact': 'Impact: {text}',
  'ext.source': 'Source',
  'ext.source.title': 'This technology was already used in the imported model',
  // «Советуем» — противоположное утверждение: в модели этого НЕТ, но содержимое просит.
  'ext.advised': 'Advised',
  'ext.advised.shared': ({ meshes, nodes }) =>
    `This model shares geometry: ${nodes} nodes reuse ${meshes} mesh(es). GPU instancing draws them in one call — `
    + `and, just as importantly, protects that geometry from Join meshes, which would otherwise have to bake it into separate copies.`,
  'ktx2.mode': 'Mode:',
  'decoder.legend': 'Marks options that need extra decoder/engine support to display correctly',
  'decoder.meshopt': 'Install the Meshopt decoder on the target site/engine.',
  'decoder.draco': 'Install the Draco decoder on the target site/engine.',
  'decoder.ktx2': 'Install a KTX2 (Basis Universal) transcoder on the target site/engine.',
  'decoder.instance': 'Target site/engine must support EXT_mesh_gpu_instancing.',

  // --- категории находок ---
  'cat.geometry': 'Geometry',
  'cat.textures': 'Textures',
  'cat.materials': 'Materials',
  'cat.uv': 'UV layout',
  'cat.attributes': 'Attributes',
  'cat.scene': 'Scene',
  'cat.performance': 'Performance',
  'cat.other': 'Finding',
  'issues.irreversible': 'Irreversible changes ({n})',
  'issues.irreversible.hint': 'This data cannot be restored from the result — keep the source file.',

  // --- окна инспекции ---
  'inspect.original': 'Original',
  'inspect.optimized': 'Optimized',
  'inspect.noModel': 'No model loaded yet.',
  'inspect.noResult': 'No optimized model yet — run a build to compare.',
  'inspect.noScene': 'No scene contents reported.',
  'inspect.clean': 'No validation issues — the file is clean.',
  'budget.source': 'source',
  'budget.ourChoice': 'our own threshold, not platform documentation',
  'col.id': 'ID',
  'col.code': 'CODE',
  'col.count': 'PLACES',
  'col.message': 'MESSAGE',
  'col.severity': 'SEVERITY',
  'col.pointer': 'POINTER',
  'log.blindSpots': ({ n, names }) =>
    `Validator notes hidden: ${n} — caused by extensions it cannot read (${names}), not by the model`,
  'sev.0': 'Error',
  'sev.1': 'Warning',
  'sev.2': 'Info',
  'sev.3': 'Hint',

  // --- сообщения журнала ---
  'log.options': ({ list }) => `Options: ${list}`,
  'log.none': 'none',
  'log.platform': ({ id }) => `Target platform: ${id}`,
  'log.rejected': ({ name }) => `Rejected "${name}" — only .glb is supported for now`,
  'log.loaded': ({ name, size }) => `Model loaded: ${name} (${size})`,
  'log.foundCompression': ({ list }) => `Compression found in source: ${list}`,
  'log.inspectFailed': ({ status }) => `Inspection failed (${status}) — Metadata and Validation are unavailable`,
  'log.inspectUnavailable': ({ error }) => `Inspection unavailable: ${error}`,
  'log.sourceInspected': ({ n }) => (n
    ? `Source inspected — ${n} validation issue${n === 1 ? '' : 's'}`
    : 'Source inspected — no validation issues'),
  'log.resultInspectFailed': ({ status }) => `Could not inspect the optimized model (${status})`,
  'log.resultInspectError': ({ error }) => `Could not inspect the optimized model: ${error}`,
  'log.resultInspected': ({ n }) => (n
    ? `Optimized model inspected — ${n} validation issue${n === 1 ? '' : 's'}`
    : 'Optimized model inspected — no validation issues'),
  'log.buildStarted': ({ platform, options }) => `Build started — platform ${platform}, options: ${options}`,
  'log.buildFinished': 'Build finished',
  'log.buildFinishedSize': ({ before, after, pct }) => `Build finished — ${before} → ${after} (${pct})`,
  'log.applied': ({ text }) => `Applied: ${text}`,
  'log.exported': ({ name, format }) => `Exported ${name} (${format})`,
  'log.integrityFailed': 'Integrity check failed — the file was written anyway, check the result before using it.',
  'log.notWritten': 'File not written — the model failed the integrity check.',
  'log.serverError': ({ status }) => `The server responded with an error (${status}).`,
  'log.noServer': ({ error }) => `Could not reach the server: ${error}`,
  'log.ktx2mode': ({ mode }) => `KTX2 mode: ${mode}`,
  'log.langChanged': ({ name }) => `Interface language: ${name}`,

};
