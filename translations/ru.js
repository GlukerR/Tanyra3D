// translations/ru.js — русский каталог строк интерфейса.
// Лежит в translations/, а не в ui/locales/: там только английский — язык, на который
// откатывается i18n.js. Сервер раздаёт эту папку по /translations/ (см. ui/locales/README.md).
// Ключи те же, что в en.js. Тон — по `docs/СЛОВАРЬ_формулировок.md`: человеческий язык,
// термин допустим, если рядом сразу его смысл. «Mesh» в интерфейсе — «модель»: для
// художника это одно и то же, а «меш» пугает без нужды.

window.I18N_CATALOGS = window.I18N_CATALOGS || {};
window.I18N_CATALOGS.ru = {
  'lang.name': 'Русский',

  'unit.kb': 'КБ',
  'unit.mb': 'МБ',
  'unit.locale': 'ru-RU',
  'pct.noChange': 'без изменений',

  // --- левая панель ---
  'outliner.models': 'Модели',
  'outliner.sub': 'Оптимизатор GLB',
  'outliner.add': 'Добавить модель',
  'outliner.metadata': '⊞ Метаданные',
  'outliner.metadata.title': 'Метаданные файла (сцены, меши, материалы…)',
  'outliner.validation': '✓ Проверка',
  'outliner.validation.title': 'Отчёт проверки glTF по стандарту Khronos',
  'dropzone.title': 'Перетащите сюда 3D-модель',
  'dropzone.sub': 'или нажмите + · пока только .glb',
  'dropzone.rejected': 'Пока поддерживается только .glb',

  // --- журнал ---
  'logs.label': 'Журнал',
  'logs.open': 'Открыть журнал',
  'logs.none': 'сообщений нет',
  'logs.empty': 'Пока нет сообщений.',
  'logs.clear': 'Очистить',

  // --- вьюпорты ---
  'vp.original': 'ИСХОДНАЯ МОДЕЛЬ',
  'vp.optimized': 'ПОСЛЕ ОПТИМИЗАЦИИ',
  'vp.splitter': 'Потяните, чтобы изменить ширину',
  'vp.reset': 'Сбросить вид',
  'vp.link': 'Связать камеры',
  'vp.exposure': 'Экспозиция',
  'vp.play': 'Запустить анимацию',
  'vp.pause': 'Остановить анимацию',
  'vp.clip': 'Клип анимации',
  'vp.time': 'Время анимации',
  'stage.hint': 'Загрузите .glb на левой панели — модель появится здесь',

  // --- окна ---
  'win.close': 'Закрыть',
  'win.metadata': 'Метаданные',
  'win.validation': 'Проверка',
  'win.logs': 'Журнал',
  'win.export': 'Экспорт результата',
  'win.error': 'Ошибка',
  'export.name': 'Имя файла',
  'export.format': 'Формат',
  'export.glb': '<b>GLB</b> — один двоичный файл, готов для веба',
  'export.json': '<b>glTF JSON</b> — самодостаточный .gltf со встроенными данными',
  'export.hint': 'Сохранится в папку загрузок браузера.',
  'export.save': 'Сохранить',

  'fail.notWritten': 'Файл не записан',
  'fail.text': 'Модель не прошла проверку целостности — исходный файл не тронут.',
  'fail.generic': 'Не удалось обработать файл',

  // --- инспектор ---
  'insp.platform': 'Платформа',
  'insp.advanced': 'Дополнительные опции',
  'opts.noServer': ({ error }) => `Не удалось загрузить настройки оптимизации: ${error}. Похоже, сервер не запущен — перезапустите его и обновите страницу.`,
  'opts.noPlatforms': 'Сервер не вернул ни одной целевой платформы — выбирать не из чего. Проверьте папку profiles/.',
  'opts.empty': ({ platform }) => `У платформы «${platform}» нет дополнительных опций.`,
  'insp.summary': 'Итог',
  'insp.integrity': 'Проверка целостности',
  'insp.analysis': 'Анализ',
  'insp.budget': 'Бюджет платформы',
  'insp.warnings': 'Предупреждения',
  'insp.done': 'Что сделано',
  'insp.skipped': 'Что пропущено',
  'insp.integrityFailed.title': 'Проверка целостности не пройдена',
  'insp.integrityFailed.text': 'Файл записан и его можно скачать, но результат отличается от исходника там, где компоненты обещают ничего не менять. Сравните оба вьюпорта, прежде чем выкладывать.',
  'insp.irreversible.title': 'Применены необратимые изменения',
  'insp.irreversible.text': 'Сохраните исходный файл — эти данные из результата не восстановить. Перечень — в «Анализе».',

  'btn.build': 'Собрать оптимизированную модель',
  'btn.rebuild': 'Пересобрать с новыми настройками',
  'btn.download': 'СКАЧАТЬ РЕЗУЛЬТАТ',
  'btn.pickOption': 'Выберите хотя бы одну оптимизацию',
  'btn.changeSetting': 'Измените настройку, чтобы пересобрать',

  // --- статус ---
  'busy.loading': 'Загрузка',
  'busy.uploading': 'Отправка файла',
  'busy.optimizing': 'Сборка',

  // --- живой замер отрисовки в HUD вьюпортов ---
  'perf.draw': 'КАДР',
  'perf.ms': 'мс',
  'perf.fps': 'кадр/с',
  'perf.faster': 'легче',
  'perf.slower': 'тяжелее',
  'perf.title': 'Сколько времени этот вьюпорт тратит на подготовку одного кадра, '
    + 'медиана по 60 кадрам. Замер на этой машине, а не на устройстве посетителя — '
    + 'число относительное: во сколько раз модель стала легче, а не что будет у людей.',
  'status.ready': 'Готово',
  'status.error': 'Ошибка',
  'status.uploading': 'Загрузка файла…',
  'status.optimizing': 'Оптимизация…',
  'status.failed': 'Файл не прошёл проверку',
  'status.phase': 'Фаза {n}: {name}',
  'status.rule': 'Правило: {title}',

  // --- группы опций ---
  'group.cleanup': 'Очистка',
  'group.structural': 'Структура',
  'group.geometry': 'Геометрия',
  'group.textures': 'Текстуры',
  'group.animation': 'Анимация',

  // --- значки у опций ---
  'ext.details': 'Подробнее: {name}',
  'ext.impact': 'Что даёт: {text}',
  'ext.source': 'В модели',
  'ext.source.title': 'Эта технология уже использована в загруженной модели',
  'ktx2.mode': 'Режим:',
  'decoder.legend': 'Отмечены опции, для которых сайту нужен дополнительный декодер — без него модель не отобразится',
  'decoder.meshopt': 'На сайте или в движке нужно подключить декодер Meshopt.',
  'decoder.draco': 'На сайте или в движке нужно подключить декодер Draco.',
  'decoder.ktx2': 'На сайте или в движке нужен транскодер KTX2 (Basis Universal).',
  'decoder.instance': 'Сайт или движок должен поддерживать EXT_mesh_gpu_instancing.',

  // --- категории находок ---
  'cat.geometry': 'Геометрия',
  'cat.textures': 'Текстуры',
  'cat.materials': 'Материалы',
  'cat.uv': 'UV-развёртка',
  'cat.attributes': 'Атрибуты',
  'cat.scene': 'Сцена',
  'cat.performance': 'Производительность',
  'cat.other': 'Находка',
  'issues.irreversible': 'Необратимые изменения ({n})',
  'issues.irreversible.hint': 'Эти данные из результата не восстановить — сохраните исходный файл.',

  // --- окна инспекции ---
  'inspect.original': 'Исходник',
  'inspect.optimized': 'Результат',
  'inspect.noModel': 'Модель ещё не загружена.',
  'inspect.noResult': 'Оптимизированной модели пока нет — соберите её, чтобы сравнить.',
  'inspect.noScene': 'Содержимое сцены не сообщается.',
  'inspect.clean': 'Замечаний нет — файл чистый.',
  'budget.source': 'источник',
  'budget.ourChoice': 'наш порог, а не документация платформы',
  'col.id': '№',
  'col.code': 'КОД',
  'col.count': 'МЕСТ',
  'col.message': 'СООБЩЕНИЕ',
  'col.severity': 'ВАЖНОСТЬ',
  'col.pointer': 'ГДЕ',
  'log.blindSpots': ({ n, names }) =>
    `Скрыто замечаний валидатора: ${n} — вызваны расширениями, которые он не читает (${names}), а не моделью`,
  'sev.0': 'Ошибка',
  'sev.1': 'Предупреждение',
  'sev.2': 'Сведения',
  'sev.3': 'Подсказка',

  // --- сообщения журнала ---
  'log.options': ({ list }) => `Опции: ${list}`,
  'log.none': 'нет',
  'log.platform': ({ id }) => `Целевая платформа: ${id}`,
  'log.rejected': ({ name }) => `Файл «${name}» отклонён — пока поддерживается только .glb`,
  'log.loaded': ({ name, size }) => `Модель загружена: ${name} (${size})`,
  'log.foundCompression': ({ list }) => `В исходнике найдено сжатие: ${list}`,
  'log.inspectFailed': ({ status }) => `Инспекция не удалась (${status}) — метаданные и проверка недоступны`,
  'log.inspectUnavailable': ({ error }) => `Инспекция недоступна: ${error}`,
  'log.sourceInspected': ({ n }) => (n
    ? `Исходник проверен — ${n} ${window.I18n.plural(n, ['замечание', 'замечания', 'замечаний'])}`
    : 'Исходник проверен — замечаний нет'),
  'log.resultInspectFailed': ({ status }) => `Не удалось проверить оптимизированную модель (${status})`,
  'log.resultInspectError': ({ error }) => `Не удалось проверить оптимизированную модель: ${error}`,
  'log.resultInspected': ({ n }) => (n
    ? `Результат проверен — ${n} ${window.I18n.plural(n, ['замечание', 'замечания', 'замечаний'])}`
    : 'Результат проверен — замечаний нет'),
  'log.buildStarted': ({ platform, options }) => `Сборка начата — платформа ${platform}, опции: ${options}`,
  'log.buildFinished': 'Сборка завершена',
  'log.buildFinishedSize': ({ before, after, pct }) => `Сборка завершена — ${before} → ${after} (${pct})`,
  'log.applied': ({ text }) => `Применено: ${text}`,
  'log.exported': ({ name, format }) => `Экспортировано ${name} (${format})`,
  'log.integrityFailed': 'Проверка целостности не пройдена — файл всё равно записан, проверьте результат перед использованием.',
  'log.notWritten': 'Файл не записан — модель не прошла проверку целостности.',
  'log.serverError': ({ status }) => `Сервер ответил ошибкой (${status}).`,
  'log.noServer': ({ error }) => `Нет связи с сервером: ${error}`,
  'log.ktx2mode': ({ mode }) => `Режим KTX2: ${mode}`,
  'log.langChanged': ({ name }) => `Язык интерфейса: ${name}`,

};
