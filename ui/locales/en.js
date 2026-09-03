// ui/locales/en.js — English catalog of interface strings.
// Ключи те же, что в ru.js. Значение — строка с подстановками {name} или функция.
// Тексты отчёта (итог, бюджеты, предупреждения) приходят с сервера и живут отдельно.

window.I18N_CATALOGS = window.I18N_CATALOGS || {};
window.I18N_CATALOGS.en = {
  'lang.switch': 'Language',
  'lang.name': 'English',

  // Единицы и формат чисел. 'unit.locale' — тег для Number.toLocaleString:
  // разделитель разрядов у языков разный (500,000 против 500 000).
  'unit.kb': 'KB',
  'unit.mb': 'MB',
  'unit.gb': 'GB',
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
  'dropzone.sub': 'or click + · GLB, glTF, STL, FBX, OBJ',
  'dropzone.rejected': 'Accepted: .glb, .gltf, .stl, .fbx, .obj',

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
  // Подпись у списка вариантов материала. «Look», а не «Variant»: художник называет
  // это внешним видом модели, а слово из спецификации ему ничего не говорит (Правило 10).
  'vp.variant': 'Look',
  // Подпись у списка уровней детализации. Два варианта по ИСТОЧНИКУ: расширение —
  // факт, имена соседних узлов — догадка, и выдавать её за факт нечестно.
  'vp.lod': 'Detail',
  'vp.lod.guess': 'Looks like detail levels',
  // Полка значков справа внизу: свойства этой модели, каждое со своей полочкой.
  'vp.rail': 'This model’s controls',
  'vp.shading': 'Viewport shading',
  // Чем показывать модель. «Clay» — слово из трёхмерных редакторов, художник его знает;
  // объяснять, что это matcap, ему незачем (Правило 10).
  'vp.display.file': 'Materials from the file',
  'vp.display.clay': 'Clay',
  'vp.display.wire': 'Wireframe',
  // Свет. Появляется только у моделей, которые несут свои источники.
  'vp.light': 'Lighting',
  'vp.interactivity': 'Interactive parts',
  'log.interactivity.hit': ({ name }) => `Clicked “${name}” — the model responded.`,
  'log.interactivity.silent': ({ name }) => `Clicked “${name}” — the graph has no response for this part.`,
  'vp.interactivity.count': ({ n }) => `Interactive parts: ${n}. Click an outlined part and the model responds.`,
  'vp.interactivity.shownOnly': ({ n }) => `Interactive parts: ${n}. Outlined only: this graph uses nodes we do not know, so nothing is played.`,
  'viewer.light.studio': 'Studio',
  'viewer.light.none': 'No light',
  'viewer.light.file': 'From the file',
  // Камеры автора. Первый пункт — наша свободная орбита, остальные его ракурсы.
  'vp.camera': 'Camera',
  'viewer.camera.free': 'Free orbit',
  // Автор не дал камере имени — подпись придумываем здесь, движок языка не знает.
  'viewer.camera.unnamed': ({ n }) => `Camera ${n}`,
  'stage.hint': 'Load a model from the left panel to preview it here',

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
  // Первый пункт списка вариантов: вид, записанный в файле основным. Не «не выбрано» —
  // экспортёр выбирает его сознательно, и вернуться к нему человек вправе.
  'viewer.variant.original': 'As in the file',
  // Первый пункт списка уровней. У уровней, узнанных по именам, это честно значит «все
  // сразу, друг сквозь друга» — именно так модель и приезжает.
  'viewer.lod.asFile': 'As in the file',
  // Все уровни сразу, наложенные друг на друга — чтобы сравнить их между собой.
  'viewer.lod.all': 'Show all at once',
  // Номер уровня и его подробность — ОДНО сообщение с подстановками, а не склейка в коде.
  //
  // Номер НАШ, по подробности: 1 — самый детальный. Имя узла из файла ушло в подсказку
  // при наведении. Причина: у Sketchfab-экспорта имя несёт ВТОРОЙ номер — порядок узла
  // при выгрузке (`Stone_Well_LOD5_5`, `Stone_Well_LOD4_0`, `Stone_Well_LOD0_3`), и в
  // списке два номера спорили друг с другом: по подробности шло 5,4,3,2,1,0, а хвосты
  // имён читались как 5,0,1,2,4,3. Один номер вместо двух — и он про то, ради чего
  // человек сюда смотрит.
  'viewer.lod.item': ({ n, tri }) => `Level ${n} — ${Number(tri).toLocaleString('en-US')} tri`,

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

  // --- своя площадка (окно настроек) ---
  // Форма спрашивает имя, движок и несколько чисел. Всё остальное подставляется само:
  // список опций и их слова принадлежат движку (Правило 10б).
  'win.profile': 'Your own platform',
  'profile.pick': 'Platform',
  'profile.new': 'New platform',
  'profile.title': 'Name',
  'profile.engine': 'Engine',
  'profile.description': 'Description',
  'profile.source': 'Where from',
  'profile.count': ({ n, max }) => `${n}/${max}`,
  // Площадка умеет ВЫЧИТАТЬ из палитры движка, а не объявлять возможности: поэтому
  // все галочки стоят, а снятая означает «здесь это не работает».
  'profile.features.hint': 'Everything the engine can do is on. Switch off what this platform does not read — those options simply will not appear.',
  // Единственное, что стоит объяснить: пустое поле — это не ноль.
  'profile.kind.warn': 'advice',
  'profile.kind.limit': 'refusal',
  'profile.budgets.hint': 'Fill in only the numbers you know. An empty field means the metric is shown without any verdict. "Advice" means the platform still accepts the model; "refusal" means it does not.',
  'profile.save': 'Save',
  'profile.delete': 'Delete',
  'profile.delete.confirm': 'Delete for good?',
  // Обмен площадками: профиль — один .json, «поделиться» это «отправить файл».
  'profile.import': 'Open a file…',
  'profile.export': 'Save to a file',
  'profile.dir': ({ path }) => `Files live in ${path}`,
  'profile.err.title_required': 'Give the platform a name.',
  'profile.err.engine_unknown': 'No such engine.',
  'profile.err.builtin_id': 'A built-in platform cannot be changed or removed.',
  'profile.err.bad_number': ({ field }) => `"${field}" needs a number greater than zero, or nothing at all.`,
  'profile.err.unknown_profile': 'This platform no longer exists.',
  'profile.err.id_taken': 'Too many platforms with this name — pick another one.',
  'profile.err.bad_file': 'This file is not a platform: it could not be read as JSON.',
  'profile.err.too_long': 'The text is too long — shorten it.',
  'profile.err.write_failed': 'The file could not be written.',
  'profile.err.no_assistant': 'This copy of the program cannot create platforms.',
  'profile.err.unknown': 'The platform was not saved.',

  'fail.notWritten': 'File not written',
  'fail.text': 'The engine did not say why. The source file is untouched.',
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
  'menu.settings.platforms': 'Your own platforms',
  'menu.settings.newPlatform': 'Create your own platform…',

  'menu.settings.workdir': 'Work folder',
  'menu.settings.workdir.counting': 'Counting…',
  'menu.settings.workdir.note': ({ size, limit }) =>
    `${size} of ${limit} used. It will not grow further: the excess is cleared on its own, and everything goes when you quit.`,
  'menu.settings.workdir.open': 'Show the folder',
  'menu.settings.workdir.clear': 'Clear it now',
  'menu.settings.workdir.cleared': 'The folder is empty. The model has to be loaded again.',
  'menu.help': 'Help',
  'menu.render': 'Render',
  'menu.render.what': 'A PNG of the optimized model, exactly as you see it now.',
  'menu.render.light': 'Lighting',
  'menu.render.light.own': 'This model brought no lights of its own.',
  'menu.render.size': 'Size',
  'menu.render.size.screen': 'As on screen',
  'menu.render.size.multiple': ({ times, w, h }) => `${times}× — ${w}×${h}`,
  'menu.render.background': 'Background',
  'menu.render.background.none': 'Transparent',
  'menu.render.background.white': 'White',
  'menu.render.background.black': 'Black',
  'menu.render.go': 'Render the picture',
  'menu.render.working': 'Rendering…',
  'menu.render.done': ({ name, w, h }) => `Picture saved: ${name} (${w}×${h})`,
  'menu.render.failed': 'The picture could not be rendered.',
  'menu.render.clamped': ({ w, h }) => `The graphics card caps the size — rendered at ${w}×${h}.`,
  'menu.help.local': 'Everything runs on this machine. Models are never uploaded anywhere.',
  'log.profile.saved': ({ name }) => `Your platform saved: ${name}`,
  'log.profile.deleted': ({ name }) => `Your platform removed: ${name}`,
  'log.profile.exported': ({ name }) => `Platform saved to a file: ${name}`,
  'log.profile.imported': ({ name }) => `Platform added from a file: ${name}`,
  // Отдельное сообщение, а не то же самое: «обновлена» значит, что прежний файл
  // перезаписан принесённым, и об этом человек должен узнать.
  'log.profile.replaced': ({ name }) => `Platform updated from a file: ${name}`,

  // --- список моделей ---
  'models.remove': 'Remove from list',
  'models.tooHeavy': ({ limit }) => `Heavier than what this program is built for (up to ${limit}). It works, but slowly.`,
  'models.packSize': ({ n }) => `Total weight of the model and the ${n} file(s) beside it`,
  // Беда с самой моделью, а не с нашей работой (красный круг с «!»).
  'issue.incomplete': ({ n }) => `The model refers to ${n} file(s) that were not dropped. The file itself is fine — drop the whole folder, not just the .gltf.`,
  // Два разных случая, и совет у них ПРОТИВОПОЛОЖНЫЙ.
  //
  // Причина известна (движок объяснил, почему не читает) — показываем ЕЁ и молчим
  // дальше. Приклеенное к ней «похоже, файл обрезан» было прямой неправдой: у облака
  // точек файл целый, переэкспорт его не спасёт, а час работы человеку стоит. Оттуда же
  // бралась вторая точка подряд — причина от движка своей точкой уже заканчивается.
  'issue.unreadable.reason': ({ detail }) => `The engine cannot read this file — ${detail}`,
  // Причины нет — только тогда догадка и уместна, потому что сказать больше нечего.
  // Слово «GLB» убрано: сюда доходят и .gltf, и .stl, и .ply, а называть чужой формат
  // своим — сбивать человека там, где он и так в затруднении.
  'issue.unreadable': 'The engine cannot read this file. It looks truncated or corrupted: re-export it or download it again.',
  'issue.validation': ({ n }) => `The model breaks the glTF standard: ${n} error(s). It opened and renders here, but another engine may refuse to show it. This came with the file — see "Validation".`,
  'models.built': 'Already built',

  // --- batch build ---
  'batch.count': ({ n, total }) => `${n} of ${total} selected`,
  'batch.remove': 'Remove selected',
  'batch.remove.title': 'Remove models',
  'batch.remove.text': ({ n }) => `Remove ${n} model${n === 1 ? '' : 's'} from the list? The files on disk stay where they are — only the entries and their results go.`,
  'batch.remove.yes': 'Remove',
  'batch.remove.cancel': 'Cancel',
  'log.batchRemoved': ({ n }) => `Removed from the list: ${n}`,
  'batch.toggle': 'Pick all or clear the selection',
  'batch.pick': 'Include in the batch',
  'btn.buildPicked': ({ n }) => `Build selected (${n})`,
  'btn.stop': 'Stop',
  'btn.stopping': 'Stopping…',
  'btn.nothingPicked': 'Select at least one model',
  'status.batch': ({ i, total, name }) => `Model ${i} of ${total}: ${name}`,
  'status.batchDone': ({ ok, failed }) => (failed
    ? `Done: ${ok} built, ${failed} failed`
    : `Done: ${ok} built`),
  'status.batchStopped': ({ ok, failed }) => (failed
    ? `Stopped: ${ok} built, ${failed} failed`
    : `Stopped: ${ok} built`),
  'log.loadedMany': ({ n }) => `Models added: ${n}`,
  // Вес, на который программа рассчитана, назван Александром 2026-08-20 после проверки
  // на файле в 330 МБ. Говорим ЗАРАНЕЕ и цифрами: и сколько весит, и на что рассчитано.
  'log.tooHeavy': ({ size, limit }) => `The model weighs ${size}, and this program is built for models up to ${limit}. It will open and build, but the preview will be sluggish and the build may take a very long time.`,
  'log.packAssets': ({ n }) => `Files alongside the models: ${n} — loaded together with them`,
  'log.packMissing': ({ name }) => `The model refers to "${name}", but that file was not dropped`,
  'log.packMissingMany': ({ n }) => `Files the model refers to but that were not dropped: ${n}`,
  'log.packUploadFailed': ({ name, error }) => `Failed to send "${name}" to the server: ${error}`,
  'log.texturesAttached': ({ n, name }) => (n === 1
    ? `A map was added to "${name}". Build again to see it on the result.`
    : `${n} maps were added to "${name}". Build again to see them on the result.`),
  'log.texturesAlready': ({ name }) => `"${name}" already has these maps`,
  'log.texturesReplaced': ({ n }) => (n === 1
    ? 'The earlier map for the same slot was removed — the new one stays.'
    : `${n} earlier maps for the same slots were removed — the new ones stay.`),
  'log.rejectedMany': ({ n }) => `Skipped files: ${n} — accepted: .glb, .gltf, .stl, .fbx, .obj`,
  'log.batchAlreadyBuilt': ({ n }) => `Already built with these settings, skipped: ${n}`,
  'log.batchStarted': ({ n }) => `Batch build: ${n} model(s) queued`,
  'log.batchDone': ({ ok, failed }) => `Batch build finished: ${ok} built, ${failed} failed`,
  'log.batchStopped': ({ ok, failed, left }) => `Batch build stopped: ${ok} built, ${failed} failed, ${left} left`,

  // --- batch summary ---
  'batch.summary': 'Summary',
  'win.summary': 'Batch summary',
  'summary.save': 'Save as CSV',
  'summary.fileName': 'tanyra3d-summary.csv',
  'summary.empty': 'Nothing to show yet: no model has been built.',
  'summary.col.model': 'Model',
  'summary.col.before': 'Before',
  'summary.col.after': 'After',
  'summary.col.pct': 'Change',
  'summary.col.vram': 'Video memory',
  'summary.col.tris': 'Triangles',
  'summary.col.budget': 'Target budget',
  'summary.failed': 'build failed',
  'summary.budget.none': '—',
  'summary.budget.ok': 'within budget',
  'summary.budget.warn': 'above the recommendation',
  'summary.budget.over': 'over the limit',
  'summary.total': ({ n, before, after, pct }) => `Models: ${n}. Before ${before}, after ${after} (${pct}).`,
  'summary.totalFailed': ({ n }) => `Failed: ${n}. The reason is in each of those models' own report.`,
  'log.summarySaved': ({ n }) => `Summary saved, rows: ${n}`,

  // --- полноэкранная подсветка при перетаскивании ---
  'dropOverlay.title': 'Drop the model anywhere',
  'dropOverlay.sub': '.glb · .gltf',

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
  'group.interactivity': 'Interactivity',

  // --- значки у опций ---
  'ext.details': 'Details: {name}',
  'ext.impact': 'Impact: {text}',
  // Откуда у площадки её запреты и числа — второй вопрос, отдельный от «что это за
  // площадка», поэтому и строка отдельная. Не `ext.source`: тот занят значком «эта
  // технология уже есть в загруженной модели», и смысл у него противоположный.
  'ext.origin': 'Where from: {text}',
  'ext.source': 'Source',
  'ext.source.title': 'This technology is present in the imported model',
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
  // WebP quality slider: one number and nothing else (Alexander, 2026-08-17). There used
  // to be three labels — "as in the source", "recommended", plain percent; the first also
  // promised something the code does not deliver. The scale is explained in the 📖 hint;
  // the position label has to read at a glance.
  'opt.webpQuality': 'Quality:',
  'opt.webpQuality.share': ({ share }) => `${share}%`,
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
  // Формат, пришедший НЕ из glTF (.stl, .ply), проверять по стандарту glTF нечем:
  // стандарта для него нет, а самого glTF ещё нет. Писать в этом месте «замечаний нет —
  // файл чистый» значило бы отчитаться о проверке, которой не было. Сказать надо ровно
  // две вещи: почему пусто сейчас и где проверка всё-таки будет.
  'inspect.noValidation': ({ format }) => `The glTF standard check does not apply to .${format} — there is no glTF here yet. The assembled .glb is checked, and its result is in the right column.`,
  'log.sourceNotValidated': ({ format }) => `Source read: .${format} is not checked against the glTF standard — the assembled file is`,
  'budget.source': 'source',
  'budget.ourChoice': 'our own threshold, not platform documentation',
  'budget.yourChoice': 'your threshold, from your own profile',
  'group.textureSize': 'Texture size',
  'textureSize.none': 'Do not shrink',
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
  'log.rejected': ({ name }) => `Rejected "${name}" — accepted: .glb, .gltf, .stl, .fbx`,
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
  // Отказов два, и они разные (см. renderFail в ui/app.ts). Причина известна —
  // называем её; неизвестна — говорим только то, что знаем наверняка: файла нет.
  // Прежняя единственная строка утверждала непройденную проверку целостности всегда,
  // в том числе когда до проверки дело не дошло и список проверок пуст.
  // Файл результата убрала уборка сервера — она идёт сама и про открытые у человека
  // модели не знает. Одна строка на весь обход, а не строка на модель (Правило 9):
  // после очистки папки исчезают все результаты разом.
  'log.resultGone': ({ name }) => `The built file for “${name}” is gone — the work folder was cleared. Build it again.`,
  'log.resultGoneMany': ({ n }) => `Built files are gone: ${n}. The work folder was cleared — build them again.`,
  'log.notProcessed': ({ reason }) => `File not written — ${reason}`,
  'log.notWritten': 'File not written — the engine did not produce a result.',
  'log.serverError': ({ status }) => `The server responded with an error (${status}).`,
  'log.noServer': ({ error }) => `Could not reach the server: ${error}`,
  'log.ktx2mode': ({ mode }) => `KTX2 mode: ${mode}`,
  'log.webpQuality': ({ share }) => `WebP quality: ${share}%`,
  'log.langChanged': ({ name }) => `Interface language: ${name}`,

};
