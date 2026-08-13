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

  // --- левая панель ---
  'outliner.models': 'Models',
  'outliner.sub': 'GLB optimizer',
  'outliner.add': 'Add a model',
  'outliner.metadata': '⊞ Metadata',
  'outliner.metadata.title': 'Asset metadata (scenes, meshes, materials…)',
  'outliner.validation': '✓ Validation',
  'outliner.validation.title': 'Khronos glTF validation report',
  // Счётчик замечаний на самой кнопке: до сборки — сколько в исходнике, после — было → стало.
  'outliner.validation.count': '✓ Validation ({n})',
  'outliner.validation.range': '✓ Validation ({from} → {to})',
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

  // Подписи посреди панелей просмотра (ui/viewer/index.js). Ставятся из кода через
  // I18n.setText, поэтому переживают смену языка без перезагрузки модели.
  'viewer.status.loading': 'Loading…',
  // Одно сообщение с подстановкой, а не «Loading…» + число: место процента и пробел
  // перед знаком — часть языка (Правило 8 §3).
  'viewer.status.loadingPct': ({ pct }) => `Loading… ${pct}%`,
  'viewer.status.unavailable': 'Preview unavailable',
  'viewer.hint.compare': 'Run optimization to compare',
  'viewer.hint.noOutput': 'No output file to preview',
  // Клип без имени в файле. Номер — часть сообщения, а не приставка к слову.
  'viewer.clip.unnamed': ({ n }) => `Clip ${n}`,

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
  // Предупреждение в самом окне выгрузки. Выгрузка при этом не блокируется — см.
  // комментарий в index.html: файл есть, забрать его человек вправе, наше дело — сказать.
  'export.integrity.title': 'Result differs from the source',
  'export.integrity.note': 'The file is complete and will be saved as is — decide for yourself whether the difference is acceptable.',
  // Почему бюджет горит красным — говорится ровно здесь, перед сохранением, и больше
  // нигде: в подсказках у полей про цвета интерфейса не пишут (Правило 10а).
  'export.budget.title': 'Over the platform limit',
  'export.budget.note': 'The file will be saved as is: the limit belongs to the platform, not to this program.',

  'fail.notWritten': 'File not written',
  'fail.text': 'The model failed the integrity check — the source file is untouched.',
  'fail.generic': 'Could not process the file',

  // --- инспектор ---
  'insp.platform': 'Platform',
  'insp.platform.none': '— no platform —',
  // Движок — вторая ось выбора (ARCHITECTURE.md §4g). Пока движок один, поле заперто,
  // и подсказка объясняет почему: серое поле без объяснения человек читает как поломку.
  'insp.engine': 'Engine',
  'insp.engine.only': 'The only engine in the app so far. A second one will make this field a choice.',
  // Площадка, живущая на другом движке, из списка НЕ убирается — она показывается с
  // причиной на месте (§4g). Одно сообщение с подстановками, не склейка кусков.
  'insp.platform.otherEngine': ({ title, engine }) => `${title} — needs ${engine}`,
  'insp.advanced': 'Advanced options',
  // Отказы панели опций. Показываются НА МЕСТЕ опций: пустая панель неотличима от
  // поломки интерфейса, строка с причиной — отличима.
  'opts.noServer': ({ error }) => `Optimization options could not be loaded: ${error}. The server may not be running — restart it and reload the page.`,
  'opts.noPlatforms': 'The server returned no target platforms, so there are no options to choose from. Check the profiles/ folder.',
  'opts.empty': ({ platform }) => `Platform "${platform}" offers no advanced options.`,
  // What the incoming model already carries. The second line covers the fact that
  // incoming compression is always stripped on load: pick nothing and the result
  // comes out uncompressed.
  'opts.inputHas': ({ names }) => `Already in the model: ${names}`,
  'opts.inputHasAndDropped': ({ names }) => `Already in the model: ${names}. Pick nothing and it will be removed — the result stays uncompressed and the file grows.`,
  'insp.summary': 'Summary',
  'insp.integrity': 'Integrity check',
  'insp.analysis': 'Analysis',
  'insp.budget': 'Budget check',
  'insp.warnings': 'Warnings',
  'insp.done': 'What was done',
  'insp.skipped': 'What was skipped',
  // Закреплённые плашки: заголовок + одна строка. Подробности — в сворачиваемых
  // разделах правой панели, см. комментарий в index.html.
  'insp.integrityFailed.title': 'Integrity check failed',
  'insp.integrityFailed.text': 'the result differs from the source',
  // Вердикт в заголовке свёрнутого раздела проверки. Раньше собирался в коде по-английски
  // и от смены языка не менялся.
  'insp.validation.failed': ({ n }) => `— ${n} failed`,
  'insp.validation.allPassed': ({ n }) => `— all ${n} passed`,
  'insp.irreversible.title': 'Irreversible changes applied',
  'insp.irreversible.text': 'the list is in Analysis',

  'btn.build': 'Build Optimized Model',
  'btn.rebuild': 'Rebuild with New Settings',
  'btn.download': 'DOWNLOAD RESULT',
  // Без «файл всё равно можно сохранить»: кнопка активна и подсвечена — это и так видно,
  // а лишняя оговорка делает подсказку длиннее самой новости.
  'btn.download.alert': 'The result differs from the source — open to see what exactly.',
  'btn.pickOption': 'Select an optimization to build',
  'btn.changeSetting': 'Change a setting to rebuild',
  'btn.building': 'Building — wait for it to finish',

  // --- статус ---
  // Подписи индикатора ожидания во вьюпортах.
  'busy.loading': 'Loading',
  'busy.uploading': 'Uploading',
  'busy.optimizing': 'Building',

  // --- живой замер отрисовки в HUD вьюпортов ---
  // Показывается время кадра каждого вьюпорта, а не FPS: оба рисуются в одном
  // кадре, и раздельный счётчик кадров дал бы одинаковые числа. См. app.js renderPerf.
  // --- строка меню ---
  'menu.file': 'File',
  'menu.file.open': 'Open model…',
  'menu.file.download': 'Download result',
  'menu.settings': 'Settings',
  'menu.settings.priority': 'Optimization checkboxes',
  'menu.settings.advise': 'Follow suggestions',
  'menu.settings.advise.hint': 'Each model resets the checkboxes to what it already uses and what it needs',
  'menu.settings.manual': 'Keep my choice',
  'menu.settings.manual.hint': 'Your checkboxes stay as you left them; suggestions are only marked with a badge',
  'menu.help': 'Help',
  'menu.help.local': 'Everything runs on this machine. Models are never uploaded anywhere.',
  'log.adviceMode.advise': 'Checkboxes now follow per-model suggestions',
  'log.adviceMode.manual': 'Checkboxes now keep your own choice',

  // --- список моделей ---
  'models.remove': 'Remove from list',
  // Беда с самой моделью, а не с нашей работой (красный круг с «!»).
  'issue.unreadable': ({ detail }) => `This file cannot be read as a GLB${detail ? ` — ${detail}` : ''}. It looks truncated or corrupted: re-export it or download it again.`,
  'issue.validation': ({ n }) => `The model breaks the glTF standard: ${n} error(s). It opened and renders here, but another engine may refuse to show it. This came with the file — see "Validation".`,
  'models.built': 'Already built',

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
  // status.failed — файла НЕТ: обработка сорвалась (см. renderFail).
  // status.doneWithIssue — файл есть, но результат не сошёлся с исходником. Это не
  // ошибка: ошибка — когда сделать не удалось, а здесь удалось, и вопрос лишь в том,
  // устраивает ли человека расхождение. Разные состояния — разные слова.
  'status.failed': 'File failed validation',
  'status.doneWithIssue': 'Done — the result needs a look',
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
  // Что даёт и чем платишь — без имён библиотек (Правило 10). Имена самих форматов
  // остаются: по ним человек ищет ответ.
  'ktx2.mode.uastc': 'UASTC — sharper picture, heavier file',
  'ktx2.mode.etc1s': 'ETC1S — lighter file, coarser color',
  'decoder.legend': 'Marks options that need extra decoder/engine support to display correctly',
  'decoder.meshopt': 'Install the Meshopt decoder on the target site/engine.',
  'decoder.draco': 'Install the Draco decoder on the target site/engine.',
  'decoder.ktx2': 'Install the KTX2 transcoder on the target site/engine.',
  'decoder.instance': 'The target site/engine must be able to draw copies on the graphics card.',

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
  'issues.andMore': ({ shown, rest }) => `${shown} and ${rest} more`,
  'issues.countImportant': ({ n }) => `${n} important`,
  'issues.countPlain': ({ n }) => String(n),
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
  'budget.yourChoice': 'your threshold, from your own profile',
  'group.textureSize': 'Texture size',
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
  'log.engine': ({ id }) => `Engine: ${id}`,
  'log.platform.reset': ({ platform }) => `${platform} does not run on this engine — platform cleared`,
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
  'log.integrityFailed': 'The result differs from the source — the file is written and can be downloaded, check it before using it.',
  'log.notWritten': 'File not written — the model failed the integrity check.',
  'log.serverError': ({ status }) => `The server responded with an error (${status}).`,
  'log.noServer': ({ error }) => `Could not reach the server: ${error}`,
  'log.ktx2mode': ({ mode }) => `KTX2 mode: ${mode}`,
  'log.langChanged': ({ name }) => `Interface language: ${name}`,

};
