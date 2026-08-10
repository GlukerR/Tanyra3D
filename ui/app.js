// app.js — клиентская логика Tanyra3D (v0.1.0). Без сборки, без CDN.
// Формат данных задают Core Engine (§4b ARCHITECTURE.md) и AI Assistant (assistant.mjs) —
// этот файл только форматирует байты/проценты и рисует то, что вернул сервер.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // Короткий доступ к каталогу строк (ui/i18n.js). Тексты интерфейса берутся ТОЛЬКО
  // отсюда — иначе смена языка оставляет островки английского.
  const t = (key, params) => window.I18n.t(key, params);
  // Подпись, которую ставит код, а не разметка. Отличается от `el.textContent = t(...)`
  // тем, что элемент запоминает ключ: смена языка перерисует его сама и не откатит на
  // ключ из разметки. Всё, что меняется по ходу работы (кнопка сборки, строка статуса,
  // счётчики на кнопках окон), обязано ставиться через это.
  const setText = (el, key, params) => window.I18n.setText(el, key, params);
  // Язык отчёта запрашивается у сервера явно: тексты итога, планов и описаний опций
  // живут в assistant.mjs и profiles/*.json, клиент их не хранит.
  const langParam = () => `lang=${encodeURIComponent(window.I18n.lang)}`;

  const dropzone = $('dropzone');
  const fileInput = $('file-input');
  const chooseFileBtn = $('choose-file-btn');
  const chosenFileLabel = $('chosen-file');
  const modelList = $('model-list');
  const stageHint = $('stage-hint');

  const btnMetadata = $('btn-metadata');
  const btnValidation = $('btn-validation');
  const metadataWindow = $('metadata-window');
  const validationWindow = $('validation-window');
  const metadataBody = $('metadata-body');
  const validationBody = $('validation-body');

  const logsBar = $('logs-bar');
  const logsCount = $('logs-count');
  const logsLast = $('logs-last');
  const logsWindow = $('logs-window');
  const logsBody = $('logs-body');
  const logsClear = $('logs-clear');

  const statsBefore = $('stats-before');
  const statsAfter = $('stats-after');
  const perfBefore = $('perf-before');
  const perfAfter = $('perf-after');
  const dropOverlay = $('drop-overlay');

  const failBanner = $('fail-banner');
  const failValidation = $('fail-validation');

  const viewportSplit = $('viewport-split');
  const viewportSplitter = $('viewport-splitter');
  const originalPane = $('preview-original');
  const resetViewBtn = $('reset-view-btn');
  const linkToggleBtn = $('link-toggle-btn');
  const animControls = $('anim-controls');
  const animPlayBtn = $('anim-play-btn');
  const animClipSel = $('anim-clip');
  const animSeek = $('anim-seek');
  const animTimeEl = $('anim-time');
  const exposureSlider = $('exposure-slider');
  const exposureValue = $('exposure-value');

  const platformSelect = $('platform-select');
  const platformInfo = $('platform-info');

  const engineSection = $('engine-section');
  const engineSelect = $('engine-select');
  const engineInfo = $('engine-info');

  const extensionsPanel = $('extensions-panel');
  const extensionsList = $('extensions-list');
  const decoderLegend = $('decoder-legend');

  const summarySection = $('summary-section');
  const summaryText = $('summary-text');
  const highlightsList = $('highlights-list');

  const analysisSection = $('analysis-section');
  const issuesCount = $('issues-count');
  const issuesList = $('issues-list');

  const budgetsSection = $('budgets-section');
  const budgetsList = $('budgets-list');

  const warningsSection = $('warnings-section');
  const warningsList = $('warnings-list');

  const appliedSection = $('applied-section');
  const appliedCount = $('applied-count');
  const appliedList = $('applied-list');

  const skippedSection = $('skipped-section');
  const skippedCount = $('skipped-count');
  const skippedList = $('skipped-list');

  const validationSection = $('validation-section');
  const validationList = $('validation-list');

  const runBtn = $('run-btn');
  const downloadBtn = $('download-btn');       // открывает окно экспорта
  const exportWindow = $('export-window');
  const exportName = $('export-name');
  const exportSave = $('export-save');
  const irreversibleWarning = $('irreversible-warning');
  const integrityWarning = $('integrity-warning');
  const downloadAlert = $('download-alert');
  const exportAlert = $('export-alert');
  const exportAlertDetails = $('export-alert-details');
  const validationCount = $('validation-count');

  const statusDot = $('status-dot');
  const phaseStatus = $('phase-status');
  const versionLabel = $('version-label');

  // ---------------------------------------------------------------
  // Индикатор ожидания во вьюпортах
  // ---------------------------------------------------------------
  //
  // Тяжёлая модель грузится и оптимизируется секундами, а то и десятками секунд.
  // Раньше единственным признаком работы была строка состояния в шапке — далеко от
  // того места, куда человек смотрит. Слева окно оставалось пустым, справа висела
  // прошлая модель, и отличить «считает» от «зависло» было не по чему.
  //
  // Индикатор живёт В САМОМ вьюпорте, сверху по центру. Правый показывается ПОВЕРХ
  // прежнего результата, не стирая его: старую картинку видно, и с ней же можно
  // сравнить новую, когда она приедет.
  const busyByPane = new Map();

  function initBusyIndicators() {
    const tpl = document.getElementById('vp-busy-template');
    if (!tpl) return;
    for (const id of ['preview-original', 'preview-optimized']) {
      const pane = document.getElementById(id);
      if (!pane) continue;
      const node = tpl.content.firstElementChild.cloneNode(true);
      pane.appendChild(node);
      busyByPane.set(id, node);
    }
  }

  // messageKey === null снимает индикатор. Ключ, а не готовая строка: подпись должна
  // перевестись, если язык переключат прямо во время долгой сборки.
  function setBusy(paneId, messageKey) {
    const node = busyByPane.get(paneId);
    if (!node) return;
    if (messageKey) node.dataset.i18nKey = messageKey;
    else delete node.dataset.i18nKey;
    const label = node.querySelector('.vp-busy-label');
    if (label) label.textContent = messageKey ? t(messageKey) : '';
    node.classList.toggle('hidden', !messageKey);
  }

  function refreshBusyLabels() {
    for (const node of busyByPane.values()) {
      const key = node.dataset.i18nKey;
      if (!key) continue;
      const label = node.querySelector('.vp-busy-label');
      if (label) label.textContent = t(key);
    }
  }

  // -----------------------------------------------------------------------
  // Живой замер нагрузки на отрисовку в HUD обоих вьюпортов.
  //
  // Показывается время кадра каждого вьюпорта в миллисекундах, а НЕ «FPS слева»
  // и «FPS справа»: кадр у обоих общий, оба рисуются в одном requestAnimationFrame,
  // и раздельный счётчик кадров дал бы два одинаковых числа при любой оптимизации.
  // Разбор — в комментарии у DualViewport._pushPerf (ui/viewer/index.js).
  //
  // Обновление раз в 500 мс, а не каждый кадр: цифра, меняющаяся 60 раз в секунду,
  // нечитаема, а запись в DOM в цикле отрисовки — лишняя работа в самом горячем месте.
  const PERF_TICK_MS = 500;
  let perfTimer = null;

  function initPerfMeter() {
    if (!perfBefore || !perfAfter || perfTimer != null) return;
    perfTimer = setInterval(renderPerf, PERF_TICK_MS);
    renderPerf();
  }

  function renderPerf() {
    const perf = window.OptiViewer && typeof window.OptiViewer.getPerf === 'function'
      ? window.OptiViewer.getPerf()
      : null;
    if (!perf) { // окно замера ещё не набралось или сцены нет
      perfBefore.innerHTML = '';
      perfAfter.innerHTML = '';
      return;
    }
    // fps общий на оба вьюпорта, поэтому показывается один раз — слева.
    setPerfLine(perfBefore, perf.leftMs, `${Math.round(perf.fps)} ${t('perf.fps')}`);
    setPerfLine(perfAfter, perf.rightMs, deltaText(perf.leftMs, perf.rightMs));
  }

  // Во сколько раз правый вьюпорт легче левого.
  //
  // Два порога, оба нужны:
  //
  // 1. PERF_RATIO_FLOOR_MS. Браузер огрубляет performance.now() до 0.1 мс — защита от
  //    атак по времени. На лёгкой сцене замер выходит 0.1–0.4 мс, то есть считанные
  //    отсчёта часов, и «×3» там означает разницу в две единицы младшего разряда, а не
  //    трёхкратный выигрыш. Ниже 1 мс отношение не показываем вовсе: сами миллисекунды
  //    остаются на виду, а вот множитель на таком замере — выдумка.
  // 2. Пять процентов. Даже выше порога мелкая разница — дрожание, а не результат.
  const PERF_RATIO_FLOOR_MS = 1;

  function deltaText(leftMs, rightMs) {
    if (!(leftMs > 0) || !(rightMs > 0)) return '';
    if (leftMs < PERF_RATIO_FLOOR_MS && rightMs < PERF_RATIO_FLOOR_MS) return '';
    const ratio = leftMs / rightMs;
    if (ratio > 1.05) return `×${ratio.toFixed(1)} ${t('perf.faster')}`;
    if (ratio < 0.95) return `×${(1 / ratio).toFixed(1)} ${t('perf.slower')}`;
    return '';
  }

  function setPerfLine(host, ms, note) {
    host.innerHTML = '';
    // Один знак после запятой, а не два: часы браузера огрублены до 0.1 мс,
    // и «0.30» рисовало бы точность, которой у замера нет.
    const row = hudLine(t('perf.draw'), `${ms.toFixed(1)} ${t('perf.ms')}`, null);
    row.title = t('perf.title');
    if (note) {
      const extra = document.createElement('span');
      extra.className = 'hud-val perf-note';
      extra.textContent = note;
      row.appendChild(extra);
    }
    host.appendChild(row);
  }

  let selectedFile = null;
  // Идентификатор загруженного исходника на сервере: пока он есть, повторная
  // оптимизация той же модели идёт без перезаливки файла (меняем только флажки).
  let currentSourceId = null;
  // Метрики исходной модели, посчитанные вьюером на клиенте (для левого HUD).
  // Хранятся, чтобы при возврате к модели не перегружать её ради одних цифр.
  let originalStats = null;
  // Анти-кэш для перезаписываемого результата (вьюпорт + скачивание) и одновременно
  // токен, по которому inspectResult() отличает свежий ответ от устаревшего — бампается
  // при каждой успешной сборке (bust()) и везде, где resultInspect сбрасывается вручную
  // (новый файл, fail), иначе поздний ответ старого запроса перезаписал бы уже очищенный
  // resultInspect чужими данными.
  let runToken = 0;
  // Подпись настроек (платформа + флажки) последней УСПЕШНОЙ сборки. Пока настройки не
  // менялись, «Rebuild with New Settings» неактивна — пересборка дала бы тот же результат.
  let lastBuildSignature = null;
  // Что найдено в исходнике (draco/meshopt/ktx2) — для авто-флажков [Source].
  let lastDetection = null;
  // Последний отчёт держим целиком: смена языка перерисовывает панель из этих же данных,
  // а не просит сервер собрать модель заново.
  let lastResult = null;
  let lastExplain = null;
  // Идёт ли сборка прямо сейчас. Нужна отдельная переменная, а не состояние кнопки:
  // кнопку включает обратно updateRunButtonState() при любом изменении настроек.
  let buildInFlight = false;
  // Настройки, с которыми запущена текущая сборка (флажки могут поменять по ходу).
  let startedSignature = null;
  // Результат /api/inspect (metadata + validation) для ЛЕВОЙ колонки окон — исходная модель.
  let modelInspect = null;
  // То же самое для ПРАВОЙ колонки — собранная модель (/api/inspect-result после сборки).
  let resultInspect = null;
  // Беда С САМОЙ МОДЕЛЬЮ, а не с нашей работой: файл не читается или в нём ошибки
  // по стандарту glTF. Отдельное состояние, потому что показывать её надо там, где
  // человек выбирает модель, а не там, где он читает отчёт о сборке.
  // null | { kind: 'unreadable' | 'validation', count?, detail? }
  let modelIssue = null;
  // URL готового результата (GLB) и предлагаемое имя без расширения — для окна экспорта.
  // Формат (glb/json) и расширение выбираются в окне; экспортёры добавляются там же.
  let resultDownloadUrl = null;
  let resultExportBase = 'model';
  // Режим KTX2: 'uastc' (точнее) либо 'mixed' (ETC1S для цвета — легче).
  //
  // Начальное значение НЕ зашито здесь. Его советует площадка (defaults.texMode с
  // /api/extensions), а интерфейс только показывает совет; выбор человека поверх
  // него живёт в savedSelections. До 2026-08-07 тут стояло 'uastc' — и профиль
  // площадки, объявлявший другой режим и объяснявший человеку почему, не мог на
  // это повлиять: интерфейс отправлял свою копию, сервер ставил её последней.
  const KTX2_MODE_FALLBACK = 'uastc';
  let ktx2Mode = KTX2_MODE_FALLBACK;
  // Что советует текущая площадка (приходит с /api/extensions).
  let platformDefaults = {};
  const defaultKtx2Mode = () => platformDefaults.texMode || KTX2_MODE_FALLBACK;
  // Геометрия — взаимоисключающий выбор: 'none' | 'meshopt' | 'draco'.
  let geometryChoice = 'none';
  let platforms = [];
  // Описание прочерка приходит отдельным полем /api/platforms: это не площадка, а
  // объяснение выбора БЕЗ неё (числа Khronos — советы, красного тут не бывает).
  let noPlatform = null;
  let engines = [];
  let extensions = [];
  // Взаимоисключающие группы — приходят с /api/extensions, объявлены в аддоне.
  // Интерфейс их только применяет: [{ id, members: [...] }].
  let exclusiveGroups = [];
  // Последний ВЫБОР пользователя по платформам: platformId → { geometryChoice, ktx2Mode,
  // checked:[...] }. Заполняется только явным действием пользователя (не дефолтами). Держит
  // настройки при загрузке новой модели и возврате на платформу. In-memory → перезагрузка
  // страницы сбрасывает всё к рекомендуемым дефолтам (так и задумано).
  const savedSelections = {};

  // -----------------------------------------------------------------------
  // Несколько моделей в списке, ОДНА в сцене.
  //
  // Решение Александра 2026-07-31: держать в двух вьюпортах несколько моделей
  // сразу — это уже сборка сцены, задача не наша. Поэтому список — про то, чтобы
  // не перезагружать файл заново, переключаясь между вариантами; сцена всегда
  // показывает выбранную модель и её результат.
  //
  // Состояние каждой модели ЖИВЁТ В ТЕХ ЖЕ переменных, что и раньше: переписывать
  // восемь десятков обращений на `M.поле` значило бы переколотить весь файл ради
  // косметики. Вместо этого при переключении текущие значения складываются в запись,
  // а из новой записи раскладываются обратно.
  //
  // Список полей — ОДИН, с геттером и сеттером рядом. Это принципиально: два
  // отдельных списка (сохранить / восстановить) неизбежно разъезжаются, и получается
  // самый неприятный сорт бага — состояние одной модели протекает в другую, причём
  // через раз и только по одному полю.
  const PER_MODEL_STATE = [
    { key: 'selectedFile', get: () => selectedFile, set: (v) => { selectedFile = v; } },
    { key: 'currentSourceId', get: () => currentSourceId, set: (v) => { currentSourceId = v; } },
    { key: 'originalStats', get: () => originalStats, set: (v) => { originalStats = v; } },
    { key: 'lastBuildSignature', get: () => lastBuildSignature, set: (v) => { lastBuildSignature = v; } },
    { key: 'lastDetection', get: () => lastDetection, set: (v) => { lastDetection = v; } },
    { key: 'lastResult', get: () => lastResult, set: (v) => { lastResult = v; } },
    { key: 'lastExplain', get: () => lastExplain, set: (v) => { lastExplain = v; } },
    { key: 'modelInspect', get: () => modelInspect, set: (v) => { modelInspect = v; } },
    { key: 'modelIssue', get: () => modelIssue, set: (v) => { modelIssue = v; } },
    { key: 'resultInspect', get: () => resultInspect, set: (v) => { resultInspect = v; } },
    { key: 'resultDownloadUrl', get: () => resultDownloadUrl, set: (v) => { resultDownloadUrl = v; } },
    { key: 'resultExportBase', get: () => resultExportBase, set: (v) => { resultExportBase = v; } },
  ];

  // Приоритет флажков оптимизации: 'advise' — каждая модель сбрасывает их под себя;
  // 'manual' — сохраняется последний выбор пользователя. Живёт в localStorage: это
  // настройка человека, а не сеанса, и переживать перезагрузку она обязана.
  const ADVICE_MODE_KEY = 'tanyra.adviceMode';
  let adviceMode = 'advise';
  try {
    const stored = localStorage.getItem(ADVICE_MODE_KEY);
    if (stored === 'advise' || stored === 'manual') adviceMode = stored;
  } catch (e) { /* приватный режим браузера — остаёмся на значении по умолчанию */ }

  const models = [];      // [{ id, file, state }] — порядок = порядок загрузки
  let activeModelId = null;
  let modelSeq = 0;

  const activeModel = () => models.find((m) => m.id === activeModelId) || null;

  function captureActiveModel() {
    const rec = activeModel();
    if (!rec) return;
    for (const f of PER_MODEL_STATE) rec.state[f.key] = f.get();
  }

  function applyModelState(state) {
    for (const f of PER_MODEL_STATE) f.set(state ? state[f.key] ?? null : null);
  }

  // Текущая подпись настроек оптимизации: платформа + флажки + режим KTX2.
  function currentSettingsSignature() {
    const feats = getSelectedFeatures().slice().sort();
    const mode = feats.includes('ktx2') ? `|ktx2:${ktx2Mode}` : '';
    return platformSelect.value + '|' + feats.join(',') + mode;
  }

  // Пользователь тронул флажок/радио — состояние кнопки + запись в логи, чтобы по логам
  // было видно, с какими настройками собиралась каждая версия.
  function onOptionChanged() {
    updateRunButtonState();
    // Строка «Сейчас в модели» договаривает разное в зависимости от выбора: сняли
    // все варианты группы — она предупреждает, что входное сжатие будет снято.
    // Значит обновлять её надо на каждое изменение, а не только при загрузке модели.
    refreshInputNotes();
    rememberSelection(); // запомнить выбор платформы — он переживёт новую модель/смену платформы
    // Раскрытые разделы описывают ПРОШЛУЮ сборку. Тронули флажок — они устарели,
    // и держать их открытыми значит показывать неверное как текущее.
    closeAllDetails();
    const feats = getSelectedFeatures();
    logMessage('debug', t('log.options', { list: feats.length ? feats.join(', ') : t('log.none') }));
  }

  // Состояние кнопки запуска. Всё — opt-in: без выбранного флажка оптимизировать нечего,
  // кнопка не активна. С файлом и ≥1 флажком: до сборки — активна; после сборки — активна
  // только если настройки изменились (иначе пересборка дала бы тот же результат).
  function updateRunButtonState() {
    // Сборка уже идёт — кнопка заблокирована, что бы человек ни менял в настройках.
    // Раньше этой строки не было, и любая правка флажка ВОЗВРАЩАЛА кнопку в строй
    // (сигнатура настроек разошлась с собранной → «есть что пересобирать»). Нажатие
    // запускало вторую сборку поверх первой: два запроса на сервер, два результата,
    // две одновременные загрузки в правый вьюпорт — и обе модели оставались в сцене.
    if (buildInFlight) {
      runBtn.disabled = true;
      runBtn.title = t('btn.building');
      return;
    }
    if (!selectedFile || getSelectedFeatures().length === 0) {
      runBtn.disabled = true;
      runBtn.title = !selectedFile ? '' : t('btn.pickOption');
      return;
    }
    if (lastBuildSignature === null) { runBtn.disabled = false; runBtn.removeAttribute('title'); return; }
    const unchanged = currentSettingsSignature() === lastBuildSignature;
    runBtn.disabled = unchanged;
    if (unchanged) runBtn.title = t('btn.changeSetting');
    else runBtn.removeAttribute('title');
  }

  // ---------------------------------------------------------------
  // Форматирование (байты → человекочитаемый вид) — зона web-interface
  // ---------------------------------------------------------------

  // Единицы и разделитель разрядов — часть языка: «11.4 MB» и «500,000» посреди
  // русского интерфейса читаются как недоделка.
  function fmtBytes(bytes) {
    if (bytes == null) return '—';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t('unit.kb')}`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} ${t('unit.mb')}`;
  }

  function fmtInt(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString(t('unit.locale'));
  }

  // Процент изменения. Правило то же, что в assistant.mjs (pctText): словами «без
  // изменений» результат не подписываем — там, где что-то изменилось, стоит число,
  // и точность подбирается по величине. Округление до целого прятало настоящие
  // изменения: 6 380 → 6 376 байт это −0.06 %, а показанный ноль рядом с ЗЕЛЁНОЙ
  // строкой читается как «инструмент ничего не сделал». Ноль — только при точном
  // совпадении чисел.
  function pctText(before, after) {
    if (!before) return '';
    if (after === before) return '0%';
    const abs = Math.abs(((after - before) / before) * 100);
    const shown = abs.toFixed(abs >= 1 ? 0 : abs >= 0.1 ? 1 : 2);
    const magnitude = Number(shown) === 0 ? '<0.01' : shown;
    return (after < before ? '−' : '+') + magnitude + '%';
  }

  // Категория находки → ключ каталога. Именно ключ, а не готовая строка: таблица
  // строится один раз при загрузке, а язык может смениться позже.
  const CATEGORY_KEYS = {
    geometry: 'cat.geometry',
    textures: 'cat.textures',
    materials: 'cat.materials',
    uv: 'cat.uv',
    attributes: 'cat.attributes',
    scene: 'cat.scene',
    performance: 'cat.performance',
  };

  const VALIDATION_ICON = { pass: '✓', info: 'i', fail: '✕' };

  // ---------------------------------------------------------------
  // Инициализация: список платформ
  // ---------------------------------------------------------------

  async function loadPlatforms() {
    try {
      const res = await fetch(`/api/platforms?${langParam()}`);
      const data = await res.json();
      platforms = data.platforms || [];
      noPlatform = data.noPlatform || null;
      versionLabel.textContent = data.engineVersion ? `core v${data.engineVersion}` : '';
      const menuVersion = document.getElementById('menu-version');
      if (menuVersion) menuVersion.textContent = data.engineVersion ? `Tanyra3D · core v${data.engineVersion}` : 'Tanyra3D';

      platformSelect.innerHTML = '';
      // Прочерк — и он же выбран по умолчанию. Без него первой вставала бы просто первая
      // площадка по алфавиту: приложение молча заявляло бы цель, которую человек не
      // называл, вместе с её жёсткими пределами (Shopify отклоняет файл больше 15 МБ).
      // «Площадка не выбрана» не утверждает ничего и показывает всё, что умеет движок.
      const none = document.createElement('option');
      none.value = '';
      window.I18n.setText(none, 'insp.platform.none');
      platformSelect.appendChild(none);

      for (const p of platforms) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.title || p.id;
        platformSelect.appendChild(opt);
      }
      platformSelect.value = '';
      updatePlatformDescription();
      // Список платформ пуст — выбирать нечего, и загружать опции не под что. Молча
      // оставить панель скрытой нельзя: см. комментарий в loadExtensions().
      if (!platforms.length) {
        showExtensionsUnavailable('opts.noPlatforms');
        return;
      }
      // Движки — после площадок: renderEngines() приводит два поля в согласие, а для
      // этого ему нужен уже заполненный список площадок.
      await loadEngines();
      loadExtensions(platformSelect.value);
    } catch (e) {
      platformSelect.innerHTML = '<option value="web">Web</option>';
      platforms = [{ id: 'web', title: 'Web', description: '' }];
      // Сюда попадали, когда сервер не ответил на /api/platforms, — и loadExtensions()
      // не вызывался вовсе. Панель опций так и оставалась с классом hidden из разметки:
      // для пользователя вся правая колонка настроек просто исчезала, без единого слова
      // о причине. Отказ должен быть виден там, где пропало содержимое.
      showExtensionsUnavailable('opts.noServer', { error: String((e && e.message) || e) });
    }
  }

  // Панель опций скрыта в разметке и открывается только при успешной загрузке. Любой
  // отказ по дороге поэтому выглядит одинаково — «панели нет». Показываем панель с
  // причиной вместо пустого места: пропавший блок интерфейса пользователь не отличит
  // от поломки, а строка с причиной сразу говорит, где искать.
  function showExtensionsUnavailable(messageKey, params) {
    extensions = [];
    extensionsList.innerHTML = '';
    infoTip.hide();
    if (decoderLegend) decoderLegend.classList.add('hidden');

    const note = document.createElement('p');
    note.className = 'opts-unavailable';
    note.textContent = t(messageKey, params);
    extensionsList.appendChild(note);
    extensionsPanel.classList.remove('hidden');

    logMessage('error', t(messageKey, params));
    updateRunButtonState();
  }

  // Названия и описания платформ приходят из профилей — на другом языке они другие.
  // Выбранная платформа сохраняется: меняется подпись, не выбор.
  async function reloadPlatformTitles() {
    const chosen = platformSelect.value;
    try {
      const res = await fetch(`/api/platforms?${langParam()}`);
      const data = await res.json();
      if (!data || !Array.isArray(data.platforms) || !data.platforms.length) return;
      platforms = data.platforms;
      noPlatform = data.noPlatform || null;
      for (const opt of platformSelect.options) {
        const p = platforms.find((x) => x.id === opt.value);
        if (p) opt.textContent = p.title || p.id;
      }
      if ([...platformSelect.options].some((o) => o.value === chosen)) platformSelect.value = chosen;
      updatePlatformDescription();
      // Движки называются и описываются в engines/*.json — на другом языке иначе.
      // Перечитываем их тем же порядком: renderEngines() заново соберёт оба поля, в том
      // числе строки «нужен другой движок», где подстановкой стоит имя площадки.
      await loadEngines();
    } catch (e) {
      /* язык подписей платформ остался прежним — не повод рушить интерфейс */
    }
  }

  // Отчёт пересказывается на сервере из того же результата: explainResult() — чистая
  // функция, файлы ей не нужны, поэтому пересобирать модель не требуется. Оттуда же
  // приходит result со строками правил на новом языке — они собраны из messageId,
  // а не переведены заново (см. localizeResult в core/i18n.mjs). Модель при смене
  // языка не перезаливается и не пересобирается: меняются слова, не результат.
  async function reexplainLastResult() {
    if (!lastResult) return;
    try {
      const res = await fetch(
        `/api/explain?platform=${encodeURIComponent(platformSelect.value)}&${langParam()}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: lastResult }) },
      );
      if (res.ok) {
        const data = await res.json();
        if (data && data.explain) lastExplain = data.explain;
        if (data && data.result) lastResult = data.result;
      }
    } catch (e) {
      /* отчёт останется на прежнем языке — лучше, чем пустая панель */
    }
    renderReport(lastResult, lastExplain);
    // Строки расхождения — часть того же результата и берутся из него же: без этой
    // строки они оставались на языке сборки, хотя весь отчёт вокруг уже переведён.
    renderIntegrity(lastResult);
  }

  // Описание поля живёт под книжечкой 📖 — той же, что у опций (infoButton/infoTip).
  // Абзацем под полем два описания превращали правую панель в свиток, который никто не
  // читает. Значка нет, когда описывать нечего: пустая книжечка обманывает ожидание.
  function renderFieldInfo(host, item) {
    infoTip.hide();
    host.textContent = '';
    if (!item || !item.description) return;
    host.appendChild(infoButton(item));
  }

  function updatePlatformDescription() {
    if (!platformSelect.value) {
      // У прочерка своя книжечка: там сказано, что жёлтые числа — общие рекомендации
      // Khronos, то есть совет, а не отказ. Заголовок берём из каталога: подпись
      // элемента управления принадлежит интерфейсу, а не файлу профиля.
      renderFieldInfo(platformInfo, noPlatform
        ? { id: 'none', title: t('insp.platform.none'), description: noPlatform.description }
        : null);
      return;
    }
    const p = platforms.find((x) => x.id === platformSelect.value);
    renderFieldInfo(platformInfo, p || null);
  }

  // ---------------------------------------------------------------
  // Движок — вторая ось выбора (ARCHITECTURE.md §4g)
  //
  // Поля симметричны: выбор площадки приводит движок в согласие, выбор движка
  // переупорядочивает площадки. Несовместимая пара НЕ прячется и не гасится — площадка
  // остаётся в списке, а причина стоит прямо в строке. Серая строка без объяснения
  // отправляет человека искать ответ в интернете; строка с причиной отвечает ему там,
  // где возник вопрос.
  // ---------------------------------------------------------------

  async function loadEngines() {
    try {
      const res = await fetch(`/api/engines?${langParam()}`);
      const data = await res.json();
      engines = Array.isArray(data.engines) ? data.engines : [];
    } catch (e) {
      // Сервер мог быть старее интерфейса и не знать про /api/engines. Это не поломка:
      // поле движка просто не появится, а площадки работают как работали.
      engines = [];
    }
    renderEngines();
  }

  function renderEngines() {
    engineSection.classList.toggle('hidden', !engines.length);
    if (!engines.length) return;

    engineSelect.innerHTML = '';
    for (const e of engines) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.title || e.id;
      engineSelect.appendChild(opt);
    }
    // Движок один — выбирать не из чего, поле заперто. Но ПОКАЗАНО: пара «площадка +
    // движок» должна быть видна, даже когда вторая половина безальтернативна. Заперто
    // молча — выглядит поломкой, поэтому подсказка объясняет причину.
    const single = engines.length === 1;
    engineSelect.disabled = single;
    if (single) {
      window.I18n.setTitle(engineSelect, 'insp.engine.only');
    } else {
      engineSelect.removeAttribute('data-i18n-title');
      engineSelect.removeAttribute('title');
    }
    syncEngineToPlatform();
    syncPlatformsToEngine();
  }

  function updateEngineDescription() {
    const e = engines.find((x) => x.id === engineSelect.value);
    renderFieldInfo(engineInfo, e || null);
    // «Другой движок — другой вьюпорт» (§4g). Имя реализации приходит из
    // engines/<id>.json; обвязка сама откажется монтировать незнакомое.
    //
    // Смена вступает в силу при следующем создании вьюпорта: уже загруженная модель
    // продолжает рисоваться прежней реализацией до сброса. Сегодня реализация одна и
    // случиться этого не может; когда появится вторая — здесь потребуется пересоздание
    // слотов, и это отмечено, а не забыто.
    if (e && e.viewer && window.OptiViewer && window.OptiViewer.useViewer) {
      window.OptiViewer.useViewer(e.viewer);
    }
  }

  // Площадка выбрана → поле движка показывает её движок.
  function syncEngineToPlatform() {
    if (!engines.length) return;
    const p = platforms.find((x) => x.id === platformSelect.value);
    const wanted = p && p.engine;
    if (wanted && [...engineSelect.options].some((o) => o.value === wanted)) engineSelect.value = wanted;
    updateEngineDescription();
  }

  // Движок выбран → площадки переупорядочены: годные сверху, остальные ниже и с
  // причиной. Список не сокращается — меняется только порядок и подпись.
  function syncPlatformsToEngine() {
    if (!engines.length || !platforms.length) return;
    const engineId = engineSelect.value;
    const titleOfEngine = (id) => (engines.find((x) => x.id === id) || {}).title || id;
    const fits = (p) => p.engine === engineId;
    const chosen = platformSelect.value;

    platformSelect.innerHTML = '';
    // Прочерк первым: «площадка не выбрана» — такой же выбор, как любая площадка
    // (решение Александра, 2026-08-10). Человек берёт движок и видит ВСЁ, что тот умеет,
    // без требований какой-либо витрины. Годится любому движку, поэтому не сортируется
    // вместе с остальными и не помечается «нужен другой движок».
    const none = document.createElement('option');
    none.value = '';
    window.I18n.setText(none, 'insp.platform.none');
    platformSelect.appendChild(none);

    for (const p of [...platforms].sort((a, b) => Number(fits(b)) - Number(fits(a)))) {
      const opt = document.createElement('option');
      opt.value = p.id;
      if (fits(p)) {
        opt.textContent = p.title || p.id;
      } else {
        // Подпись ставит код — значит помечаем ключом, иначе смена языка откатит её
        // к ключу из разметки (Правило 8).
        window.I18n.setText(opt, 'insp.platform.otherEngine', {
          title: p.title || p.id,
          engine: titleOfEngine(p.engine),
        });
      }
      platformSelect.appendChild(opt);
    }
    if ([...platformSelect.options].some((o) => o.value === chosen)) platformSelect.value = chosen;
    updatePlatformDescription();
  }

  engineSelect.addEventListener('change', async () => {
    updateEngineDescription();
    // Площадка на другом движке больше не может остаться выбранной: пара «Shopify +
    // Three.js» не существует, и держать её на экране значит показывать несуществующее
    // (решение Александра, 2026-08-10). Откатываемся на прочерк — он годится любому
    // движку и ничего не утверждает. Список площадок при этом не сокращается: выбрать
    // Shopify по-прежнему можно, и тогда движок догонит её сам, симметрично.
    const текущая = platforms.find((x) => x.id === platformSelect.value);
    if (текущая && текущая.engine !== engineSelect.value) {
      platformSelect.value = '';
      updatePlatformDescription();
      logMessage('info', t('log.platform.reset', { platform: текущая.title || текущая.id }));
    }
    syncPlatformsToEngine();
    logMessage('info', t('log.engine', { id: engineSelect.value }));
    await loadExtensions(platformSelect.value);
    updateRunButtonState();
  });

  platformSelect.addEventListener('change', async () => {
    updatePlatformDescription();
    // Симметрия: выбор площадки — тоже выбор движка, просто с другой стороны.
    syncEngineToPlatform();
    syncPlatformsToEngine();
    await loadExtensions(platformSelect.value);
    updateRunButtonState();
    logMessage('info', t('log.platform', { id: platformSelect.value }));
  });

  // ---------------------------------------------------------------
  // Расширенные опции (KTX2, Draco, strip-colors, ...) — данные и описания
  // приходят от AI Assistant через /api/extensions; здесь только рендер.
  // ---------------------------------------------------------------

  // Опции сгруппированы в секции. Геометрия — взаимоисключающий выбор (checkbox-тумблер
  // Meshopt/Draco, обе выключены = не сжимать). Meshopt/Draco/KTX2/Instance требуют
  // подключить декодер на целевом сайте (пометка ⚠); остальное (Join/Safe/Remove colors)
  // работает на голом three.js.
  const OPT_GROUPS = [
    { titleKey: 'group.cleanup', kind: 'checks', ids: ['safe', 'strip-colors'] },
    { titleKey: 'group.structural', kind: 'checks', ids: ['join', 'instance'] },
    { titleKey: 'group.geometry', kind: 'geometry' },
    { titleKey: 'group.textures', kind: 'checks', ids: ['ktx2', 'webp'] },
    { titleKey: 'group.animation', kind: 'checks', ids: ['resample'] },
  ];
  // Кому нужен декодер — говорит ДВИЖОК (engines/<id>.json, поле needsDecoder), а не
  // интерфейс. До 2026-08-10 здесь лежал зашитый список ['meshopt','draco','ktx2',
  // 'instance']: он был верен ровно для одного движка, а у второго умолчания другие.
  // Второй список одной правды расходится молча — это уже случалось с EXCLUSIVE_FEATURES.
  //
  // Пустое множество, пока опции не пришли: значков просто не будет, а не будут
  // проставлены наугад.
  let needsDecoder = new Set();
  const rememberDecoders = (list) => {
    needsDecoder = new Set((list || []).filter((e) => e && e.needsDecoder).map((e) => e.id));
  };

  // Взаимоисключающие флажки: включили один — второй гаснет.
  //
  // KTX2 и WebP делают с текстурами противоположное и оба разом не имеют смысла.
  // KTX2 остаётся сжатым в видеопамяти (её в 4–8 раз меньше), но файл на мелкой
  // текстуре растёт. WebP уменьшает файл, а до видеокарты доходит распакованным —
  // видеопамять не меняется вовсе. Включить оба значит перекодировать текстуры
  // дважды и получить последний по порядку.
  //
  // ЗДЕСЬ БОЛЬШЕ НЕТ СПИСКА (2026-08-04). Раньше интерфейс держал свой
  // `EXCLUSIVE_GROUPS = [['ktx2','webp']]`, а движок — свой, и они уже разошлись:
  // здесь была пара текстур, там пара кодеков, а группа геометрии жила третьим
  // способом. Разойдись они дальше — интерфейс погасил бы одну галочку, а движок
  // выбрал другую. Теперь объявление одно (аддон), сюда оно приезжает по API.
  //
  // Гашение остаётся работой интерфейса: движок обязан честно выполнить то, что
  // попросили, и отменять чужой выбор молча — не его дело.
  function clearExclusivePartners(id) {
    for (const { members } of exclusiveGroups) {
      if (!members.includes(id)) continue;
      for (const other of members) {
        if (other === id) continue;
        const box = document.getElementById(`ext-${other}`);
        if (box && box.checked) {
          box.checked = false;
          box.dispatchEvent(new Event('input', { bubbles: true })); // раскрывашки режима слушают его
        }
      }
    }
  }
  // ⚠ — не документация, а требование к разработчику (нужно подключить декодер на сайте).
  // 📖 остаётся отдельным значком «пояснение, как это работает» — их нельзя путать.
  // Текст — что именно установить, отдельно на каждую технологию (не один и тот же текст
  // под всеми значками): разработчик должен понять, ЧТО конкретно подключить.
  const DECODER_KEYS = {
    meshopt: 'decoder.meshopt',
    draco: 'decoder.draco',
    ktx2: 'decoder.ktx2',
    instance: 'decoder.instance',
  };
  // Общий смысл значка — для легенды панели (сама легенда не заменяет конкретный текст
  // на каждом значке, только объясняет, что вообще значит ⚠).
  const DECODER_NOTE_KEY = 'decoder.legend';

  // `keep` — снимок выбора, который надо вернуть после пересборки панели (см.
  // relabelExtensions). Без него панель заново решает, что включить, а это уже не
  // перерисовка, а изменение настроек.
  async function loadExtensions(platformId, keep) {
    extensions = [];
    extensionsList.innerHTML = '';
    // Подсказка живёт в <body> и переживает пересборку панели — но кнопка, к которой
    // она привязана, нет. Осталась бы висеть у пустого места.
    infoTip.hide();
    extensionsPanel.classList.add('hidden');
    if (decoderLegend) decoderLegend.classList.add('hidden');
    // Пустая площадка — прочерк, законный выбор: список берётся у движка (§4g). Раньше
    // здесь стоял выход по !platformId — тогда пустое значение означало «ещё не выбрана».
    // Выходим, только если спрашивать вообще не о чем: нет ни площадки, ни движка.
    if (!platformId && !engineSelect.value) return;

    let failure = null;
    // Пустой ответ по умолчанию: при провале запроса панель обязана обнулиться, а не
    // остаться с данными предыдущей площадки.
    let fetched = { extensions: [], exclusiveGroups: [], defaults: {} };
    try {
      // Движок передаём всегда: при выбранной площадке сервер его игнорирует (движок у
      // неё свой), а при прочерке — это единственный источник, откуда движок известен.
      const res = await fetch(
        `/api/extensions?platform=${encodeURIComponent(platformId)}`
        + `&engine=${encodeURIComponent(engineSelect.value || '')}&${langParam()}`,
      );
      const data = await res.json();
      fetched = {
        extensions: (data && data.extensions) || [],
        // Группы взаимоисключений приходят оттуда же, где живёт их единственное
        // объявление (аддон). Свой список интерфейс больше не держит.
        exclusiveGroups: (data && data.exclusiveGroups) || [],
        // Совет площадки (режим KTX2 и что появится дальше). Тем же порядком: объявлено
        // в профиле — прочитано здесь, а не продублировано константой.
        defaults: (data && data.defaults) || {},
      };
    } catch (e) {
      failure = String((e && e.message) || e);
    }

    // Пользователь мог переключить платформу ещё раз, пока этот fetch летел — устаревший
    // ответ не должен перестраивать панель под другую (текущую) платформу и записывать
    // savedSelections не в тот ключ.
    if (platformSelect.value !== platformId) return;

    // Ответ признан своим — только теперь он становится состоянием панели.
    //
    // Раньше присваивание стояло ВЫШЕ этой проверки, и опоздавший ответ прошлой
    // площадки перезаписывал списки уже после того, как панель собралась под новую:
    // на экране одно, в переменных другое, и следующая загрузка модели брала чужой
    // совет. Панель при этом не вздрагивала, поэтому заметить было нечем.
    extensions = fetched.extensions;
    exclusiveGroups = fetched.exclusiveGroups;
    platformDefaults = fetched.defaults;
    // Значки ⚠ — из того же ответа, что и сами опции. Иначе движок сменился, а значки
    // остались от прежнего.
    rememberDecoders(extensions);

    // Раньше оба этих случая заканчивались тихим `return`, и панель оставалась скрытой:
    // расширенные опции «недоступны» выглядели как исчезнувший кусок интерфейса.
    if (failure) {
      showExtensionsUnavailable('opts.noServer', { error: failure });
      return;
    }
    if (!extensions.length) {
      showExtensionsUnavailable('opts.empty', { platform: platformId });
      return;
    }

    const byId = Object.fromEntries(extensions.map((e) => [e.id, e]));
    for (const group of OPT_GROUPS) {
      const section = group.kind === 'geometry'
        ? renderGeometryGroup(byId)
        : renderCheckGroup(group, byId);
      if (section) extensionsList.appendChild(section);
    }
    // Легенда объясняет ⚠ ОДИН раз для всей панели — значок встречается в трёх разных
    // секциях (Structural/Geometry/Textures), поэтому показываем её, только если хотя бы
    // одна из ЭТИХ платформенных опций реально требует декодер.
    if (decoderLegend) decoderLegend.classList.toggle('hidden', !extensions.some((e) => needsDecoder.has(e.id)));
    extensionsPanel.classList.remove('hidden');
    // панель пересобрана → дефолты платформы + авто-флажки [Source] + состояние кнопки
    applyDetection(keep);
    updateRunButtonState();
  }

  function optSection(title, groupKind) {
    const sec = document.createElement('div');
    sec.className = 'opt-section';
    // Метка нужна, чтобы строку «Сейчас в модели» можно было вставить ПОЗЖЕ:
    // панель строится до того, как приходит инспекция файла.
    if (groupKind) sec.dataset.group = groupKind;
    const h = document.createElement('div');
    h.className = 'opt-section-title';
    h.textContent = title;
    sec.appendChild(h);
    return sec;
  }

  // Что УЖЕ лежит в загруженной модели по этой группе.
  //
  // Зачем. Движок снимает входное сжатие при загрузке всегда — по замыслу, чтобы не
  // накладывать кодек на кодек (ARCHITECTURE §6). Значит модель с Draco, собранная
  // без единого флажка геометрии, выйдет НЕСЖАТОЙ, и файл вырастет: замер на
  // `Ноутбук.glb` — 6.2 → 57.6 МБ. Раньше человек узнавал об этом из строки отчёта,
  // когда сборка уже закончилась.
  //
  // Отдельный пункт «не сжимать» этого не решает: при входном Draco непонятно,
  // означает он «оставить как было» или «убрать». Поэтому не пункт, а факт —
  // сказанный вовремя. Отсутствие галочки по-прежнему значит «не добавлять».
  const GROUP_INPUT_MARKERS = {
    geometry: {
      meshopt: 'EXT_meshopt_compression',
      draco: 'KHR_draco_mesh_compression',
      quantize: 'KHR_mesh_quantization',
    },
    textures: {
      ktx2: 'KHR_texture_basisu',
      webp: 'EXT_texture_webp',
    },
  };

  // Выбрана ли хоть одна опция группы — от этого зависит вторая половина строки.
  function groupHasChoice(groupKind) {
    if (groupKind === 'geometry') return geometryChoice !== 'none';
    const markers = GROUP_INPUT_MARKERS[groupKind] || {};
    return Object.keys(markers).some((id) => {
      const box = document.getElementById(`ext-${id}`);
      return box && box.checked;
    });
  }

  // Пересобирает строку «Сейчас в модели» во всех группах. Зовётся из applyDetection:
  // к этому моменту инспекция файла уже пришла, а панель уже построена.
  function refreshInputNotes() {
    for (const sec of extensionsList.querySelectorAll('.opt-section[data-group]')) {
      const old = sec.querySelector('.opt-input-note');
      if (old) old.remove();

      const groupKind = sec.dataset.group;
      const markers = GROUP_INPUT_MARKERS[groupKind];
      if (!markers) continue;
      // Два источника, потому что приходят они в разное время и знают разное:
      // detectSource из вьюера — сразу после загрузки, но только про четыре вещи;
      // инспекция файла — позже, зато полным списком расширений.
      const present = new Set((modelInspect && modelInspect.extensions) || []);
      const found = Object.entries(markers)
        .filter(([id, ext]) => present.has(ext) || (lastDetection && lastDetection[id]))
        .map(([id]) => id);
      if (!found.length) continue;

      const note = document.createElement('p');
      note.className = 'opt-input-note';
      // Названия берём из тех же опций, что видит человек рядом, — не из имён расширений
      // (идентификатор спецификации ему ничего не говорит).
      const byId = Object.fromEntries(extensions.map((e) => [e.id, e]));
      const names = found.map((id) => (byId[id] && byId[id].title) || id).join(', ');
      note.textContent = groupHasChoice(groupKind)
        ? t('opts.inputHas', { names })
        : t('opts.inputHasAndDropped', { names });
      // Сразу под заголовком группы, до самих опций.
      sec.insertBefore(note, sec.children[1] || null);
    }
  }

  // «?» — «на сайте нужно кое-что подключить». Один переиспользуемый индикатор вместо
  // повторения одного и того же title у каждой опции (Meshopt/Draco/KTX2/Instance).
  //
  // Значки-предупреждения — одна семья: только знак, без фигуры вокруг. «?» — вопрос к
  // площадке, «!» — проблема (см. .model-alert и .ext-cost-badge). Различает их сам знак
  // и цвет; размер, начертание и посадка общие. Книжечка 📖 в семью не входит намеренно:
  // это документация, а не предупреждение, и путать их нельзя.
  function decoderWarning(id) {
    const w = document.createElement('span');
    w.className = 'ext-decoder-warn icon-badge';
    w.textContent = '?';
    const note = t((id && DECODER_KEYS[id]) || DECODER_NOTE_KEY);
    w.title = note;
    w.setAttribute('aria-label', note);
    return w;
  }

  // Подсказка 📖 — ОДНА на всю панель. Раньше каждая иконка раскрывала свой блок прямо
  // в строке: описания копились одно под другим и выдавливали список опций вниз.
  // Один общий элемент в <body> решает и накопление (открыт ровно один — больше просто
  // нечему), и обрезание: .inspector-scroll имеет overflow-y, вложенная подсказка резалась
  // бы по краю панели, поэтому position: fixed и координаты от кнопки.
  const infoTip = (() => {
    const SHOW_DELAY_MS = 220; // заметно быстрее нативного title (~800 мс)
    const GAP = 6;
    const EDGE = 8;
    let el = null;
    let owner = null;
    let timer = 0;

    function node() {
      if (el) return el;
      el = document.createElement('div');
      el.className = 'ext-tip hidden';
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
      return el;
    }

    function fill(tip, ext) {
      tip.textContent = '';
      if (ext.description) {
        const p = document.createElement('p');
        p.textContent = ext.description;
        tip.appendChild(p);
      }
      if (ext.impact) {
        const p = document.createElement('p');
        p.className = 'ext-impact';
        p.textContent = t('ext.impact', { text: ext.impact });
        tip.appendChild(p);
      }
      return tip.childNodes.length > 0;
    }

    // Ширина — по панели, положение — от кнопки, но с зажимом в её границы: подсказка
    // не должна уезжать ни влево за панель, ни вниз за экран.
    function place(tip, btn) {
      const panel = btn.closest('.inspector') || document.documentElement;
      const p = panel.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      tip.style.maxWidth = `${Math.max(180, p.width - EDGE * 2)}px`;
      tip.classList.remove('hidden'); // сначала показать — иначе размеры нулевые
      const t = tip.getBoundingClientRect();
      const left = Math.min(Math.max(p.left + EDGE, b.right - t.width), p.right - t.width - EDGE);
      const below = b.bottom + GAP;
      const fitsBelow = below + t.height <= window.innerHeight - EDGE;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(fitsBelow ? below : Math.max(EDGE, b.top - t.height - GAP))}px`;
    }

    function show(btn, ext) {
      const tip = node();
      if (!fill(tip, ext)) return; // нечего показывать — не мигаем пустой карточкой
      owner = btn;
      place(tip, btn);
    }

    return {
      isOpenFor: (btn) => owner === btn,
      hide() {
        clearTimeout(timer);
        timer = 0;
        owner = null;
        if (el) el.classList.add('hidden');
      },
      showNow(btn, ext) {
        clearTimeout(timer);
        timer = 0;
        show(btn, ext);
      },
      showDelayed(btn, ext) {
        clearTimeout(timer);
        timer = setTimeout(() => show(btn, ext), SHOW_DELAY_MS);
      },
    };
  })();

  // Подсказка привязана к экранным координатам кнопки — любое их смещение делает её
  // враньём, поэтому прокрутка и ресайз просто гасят её, а не пересчитывают.
  window.addEventListener('scroll', () => infoTip.hide(), true);
  window.addEventListener('resize', () => infoTip.hide());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') infoTip.hide(); });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.ext-info-btn')) infoTip.hide();
  });

  // 📖 — документация «как это работает». Отдельный смысл от ⚠: это пояснение,
  // а не требование к разработчику. Нативный title не ставим — он дублировал бы
  // кастомную подсказку вторым всплывающим окном поверх неё.
  function infoButton(ext) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ext-info-btn';
    btn.textContent = '📖';
    btn.setAttribute('aria-label', t('ext.details', { name: ext.title || ext.id }));
    btn.addEventListener('mouseenter', () => infoTip.showDelayed(btn, ext));
    btn.addEventListener('mouseleave', () => infoTip.hide());
    btn.addEventListener('focus', () => infoTip.showNow(btn, ext));
    btn.addEventListener('blur', () => infoTip.hide());
    // На тач-экранах hover не существует — там клик единственный способ прочитать
    // описание. Показывает ту же одну подсказку, так что накопиться по-прежнему нечему.
    btn.addEventListener('click', () => {
      if (infoTip.isOpenFor(btn)) infoTip.hide();
      else infoTip.showNow(btn, ext);
    });
    return btn;
  }

  // Геометрия — Meshopt/Draco/квантование, взаимоисключающие. Нет отдельного пункта
  // "None": все выключены = геометрия не сжимается. Клик по уже активному пункту гасит
  // его (checkbox, не radio — только radio-группа не даёт снять выбор повторным кликом).
  //
  // Квантование стоит в этой же группе, потому что это третий ответ на тот же вопрос
  // «чем уменьшить геометрию», а не добавка к первым двум: Draco квантует сам, Meshopt
  // тянет то же расширение внутри себя. Единственное отличие — ему не нужен декодер,
  // поэтому движок не помечает его needsDecoder и значок ему не ставится.
  function renderGeometryGroup(byId) {
    if (!byId.meshopt && !byId.draco && !byId.quantize) return null;
    const sec = optSection(t('group.geometry'), 'geometry');
    const opts = [
      byId.meshopt && { v: 'meshopt', ext: byId.meshopt, label: byId.meshopt.title },
      byId.draco && { v: 'draco', ext: byId.draco, label: byId.draco.title },
      byId.quantize && { v: 'quantize', ext: byId.quantize, label: byId.quantize.title },
    ].filter(Boolean);
    for (const o of opts) {
      const row = document.createElement('div');
      row.className = 'opt-radio-row';
      row.dataset.geom = o.v;

      const head = document.createElement('div');
      head.className = 'opt-radio-head';

      const label = document.createElement('label');
      label.className = 'opt-radio';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = o.v;
      checkbox.id = `geom-${o.v}`;
      checkbox.checked = (o.v === geometryChoice);
      checkbox.addEventListener('change', () => {
        // Отмечен → он становится выбором (второй гасится). Снят (повторный клик по
        // уже активному) → выбор геометрии сбрасывается в "не сжимать".
        if (checkbox.checked) geometryChoice = o.v;
        else if (geometryChoice === o.v) geometryChoice = 'none';
        syncGeometryRadio();
        onOptionChanged();
      });
      const text = document.createElement('span');
      text.className = 'opt-radio-text';
      text.textContent = o.label;
      label.appendChild(checkbox);
      label.appendChild(text);
      head.appendChild(label);

      if (o.ext && needsDecoder.has(o.ext.id)) head.appendChild(decoderWarning(o.ext.id));

      row.appendChild(head);
      if (o.ext) head.appendChild(infoButton(o.ext));
      sec.appendChild(row);
    }
    return sec;
  }

  function renderCheckGroup(group, byId) {
    const items = group.ids.map((id) => byId[id]).filter(Boolean);
    if (!items.length) return null;
    // Текстурная группа — такой же случай, как геометрия: входной формат снимается,
    // и человек должен узнать об этом до сборки, а не из отчёта.
    const sec = optSection(t(group.titleKey), group.ids.includes('ktx2') ? 'textures' : null);
    for (const ext of items) sec.appendChild(buildExtensionRow(ext));
    return sec;
  }

  function buildExtensionRow(ext) {
    const row = document.createElement('div');
    row.className = 'ext-row';

    const head = document.createElement('div');
    head.className = 'ext-row-head';

    const label = document.createElement('label');
    label.className = 'ext-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'ext-checkbox';
    checkbox.value = ext.id;
    checkbox.id = `ext-${ext.id}`;
    checkbox.addEventListener('change', () => {
      // Гасим партнёра ДО пересчёта: getSelectedFeatures() читает флажки, и порядок
      // здесь решает, попадут ли в сборку оба текстурных правила сразу.
      if (checkbox.checked) clearExclusivePartners(ext.id);
      // KTX2 могли погасить не его собственным кликом, а выбором WebP — селектор
      // режима должен уехать вместе с ним. Свой обработчик у флажка KTX2 (ниже)
      // на чужой клик не срабатывает.
      toggleKtx2Mode(!!(document.getElementById('ext-ktx2') || {}).checked);
      onOptionChanged();
    });

    const titleSpan = document.createElement('span');
    titleSpan.textContent = ext.title || ext.id;

    label.appendChild(checkbox);
    label.appendChild(titleSpan);
    if (needsDecoder.has(ext.id)) label.appendChild(decoderWarning(ext.id));

    head.appendChild(label);
    head.appendChild(infoButton(ext));

    row.appendChild(head);

    // KTX2 — один флажок с раскрывающимся селектором режима. Отдельного чекбокса
    // ETC1S нет (future-proof). Что стоит предвыбранным — советует площадка, см.
    // defaultKtx2Mode(); интерфейс своего умолчания не назначает.
    if (ext.id === 'ktx2') {
      const mode = document.createElement('details');
      mode.className = 'ktx2-mode hidden';
      const summary = document.createElement('summary');
      summary.textContent = `${t('ktx2.mode')} `;
      const modeCurrent = document.createElement('span');
      modeCurrent.className = 'ktx2-mode-current';
      summary.appendChild(modeCurrent);
      mode.appendChild(summary);
      // Подпись каждого режима — ключ каталога, а не строка здесь (Правило 8). До
      // 2026-08-07 тут лежали 'UASTC (Recommended)' и 'ETC1S (Maximum Compression)':
      // по-русски они так и оставались английскими, потому что переводить было нечего.
      // Имена форматов внутри подписи остаются — по ним человек ищет ответ (Правило 10).
      const modeOpts = [
        { v: 'uastc', labelKey: 'ktx2.mode.uastc', short: 'UASTC' },
        { v: 'mixed', labelKey: 'ktx2.mode.etc1s', short: 'ETC1S' },
      ];
      modeCurrent.textContent = (modeOpts.find((o) => o.v === ktx2Mode) || modeOpts[0]).short;
      for (const o of modeOpts) {
        const optLabel = document.createElement('label');
        optLabel.className = 'ktx2-mode-opt';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'ktx2mode';
        radio.value = o.v;
        if (o.v === ktx2Mode) radio.checked = true;
        radio.addEventListener('change', () => {
          ktx2Mode = o.v;
          summary.querySelector('.ktx2-mode-current').textContent = o.short;
          updateRunButtonState();
          rememberSelection(); // режим KTX2 — тоже часть выбора платформы
          logMessage('debug', t('log.ktx2mode', { mode: o.short }));
        });
        optLabel.appendChild(radio);
        optLabel.appendChild(document.createTextNode(' ' + t(o.labelKey)));
        mode.appendChild(optLabel);
      }
      row.appendChild(mode);
      // режим виден только когда KTX2 выбран
      checkbox.addEventListener('change', () => mode.classList.toggle('hidden', !checkbox.checked));
    }

    return row;
  }

  // Показать/скрыть селектор режима KTX2 (при авто-включении из detection).
  function toggleKtx2Mode(show) {
    const cb = document.getElementById('ext-ktx2');
    const row = cb && cb.closest('.ext-row');
    const mode = row && row.querySelector('.ktx2-mode');
    if (mode) mode.classList.toggle('hidden', !show);
  }

  function getSelectedFeatures() {
    const feats = [];
    if (geometryChoice === 'meshopt') feats.push('meshopt');
    else if (geometryChoice === 'draco') feats.push('draco');
    else if (geometryChoice === 'quantize') feats.push('quantize');
    for (const cb of extensionsList.querySelectorAll('.ext-checkbox:checked')) feats.push(cb.value);
    return feats;
  }

  function setCheck(id, val) {
    const cb = document.getElementById(`ext-${id}`);
    if (cb) cb.checked = val;
  }

  // ---------------------------------------------------------------
  // Drag & drop / выбор файла
  // ---------------------------------------------------------------

  async function handleFile(file) {
    if (!file) return;
    if (!/\.glb$/i.test(file.name)) {
      chosenFileLabel.textContent = t('dropzone.rejected');
      logMessage('warn', t('log.rejected', { name: file.name }));
      selectedFile = null;
      runBtn.disabled = true;
      return;
    }
    // Новая модель — новая запись в списке. addModel сначала складывает состояние
    // той, что была на экране, поэтому вернуться к ней можно будет без перезагрузки.
    addModel(file);
    chosenFileLabel.textContent = '';
    runBtn.disabled = false;
    logMessage('info', t('log.loaded', { name: file.name, size: fmtBytes(file.size) }));
    renderModelList();
    if (stageHint) stageHint.classList.add('hidden');
    // Новый файл → сбросить прежний результат и серверный исходник (будет перезалит).
    clearResults();
    // Сразу показать оригинал в левом вьюпорте + его базовые данные (ещё до сборки).
    if (window.OptiViewer) {
      setBusy('preview-original', 'busy.loading');
      try {
        const info = await window.OptiViewer.loadOriginal(file);
        // Пока разбирался файл, человек мог бросить следующий: тогда эти данные уже
        // не про ту модель, что на экране, и записывать их в общие переменные нельзя.
        if (selectedFile !== file) return;
        originalStats = (info && info.stats) || null;
        renderSourceStats(file.size);
        // Определяем, что уже сжато в исходнике → авто-включаем флажки с бейджем [Source].
        lastDetection = (info && info.detected) || null;
        const found = Object.keys(lastDetection || {}).filter((k) => lastDetection[k]);
        if (found.length) logMessage('info', t('log.foundCompression', { list: found.join(', ') }));
        applyDetection();
      } finally {
        // finally, а не после await: битый файл кидает, и индикатор иначе остался бы
        // крутиться навсегда над окном, в котором уже ничего не произойдёт.
        setBusy('preview-original', null);
      }
    }
    // Инспекция на сервере (metadata + validation) + регистрация исходника, чтобы
    // сборка потом переиспользовала его без перезаливки.
    inspectModel(file);
  }

  async function inspectModel(file) {
    modelInspect = null;
    setModelIssue(null);
    btnMetadata.disabled = true;
    btnValidation.disabled = true;
    updateInspectButtons();
    try {
      const res = await fetch('/api/inspect', {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      // Пользователь мог выбрать другой файл, пока этот запрос летел — не затираем
      // его данные устаревшим ответом.
      if (selectedFile !== file) return;
      if (!res.ok) {
        // Сервер не смог даже прочитать файл. Раньше это была одна строка в журнале,
        // и модель в списке выглядела как все остальные — человек шёл собирать
        // заведомо битый файл. Теперь она помечена.
        let detail = '';
        try { detail = ((await res.json()) || {}).error || ''; } catch (e) { /* тело не JSON */ }
        setModelIssue({ kind: 'unreadable', detail });
        logMessage('warn', t('log.inspectFailed', { status: res.status }));
        return;
      }
      const data = await res.json();
      if (selectedFile !== file) return;
      modelInspect = data;
      // Цифры движка приехали — заменяем ими прикидку по отрисованной сцене.
      // Только до первой сборки: после неё в шапке стоят before/after из отчёта
      // (renderComparison), и затирать их односторонним «до» нельзя.
      if (!lastResult) renderSourceStats(file.size);
      if (data.sourceId) currentSourceId = data.sourceId; // сборка переиспользует исходник
      btnMetadata.disabled = false;
      btnValidation.disabled = false;
      const n = (data.validation || []).filter((m) => !m.explainedBy).length;
      // Ошибка по стандарту — это дефект САМОЙ модели, а не замечание к ней:
      // предупреждения и подсказки валидатора в счёт не идут.
      const errors = (data.validation || []).filter((m) => !m.explainedBy && m.severity === 0).length;
      setModelIssue(errors ? { kind: 'validation', count: errors } : null);
      updateInspectButtons();
      logMessage('info', n
        ? t('log.sourceInspected', { n })
        : t('log.sourceInspected', { n: 0 }));
      logBlindSpots(data.validation);
    } catch (e) {
      // инспекция недоступна — кнопки выключены, сборка всё равно работает
      setModelIssue({ kind: 'unreadable', detail: e.message });
      logMessage('warn', t('log.inspectUnavailable', { error: e.message }));
    }
  }

  // ---------------------------------------------------------------
  // Красный «!» — проблема САМОЙ МОДЕЛИ
  //
  // Отдельный знак, не путать с красным знаком цены у галочки оптимизации: тот говорит
  // «мы сделали, и вот чего это стоило», этот — «файл пришёл таким». Ставится там, где
  // человек про модель думает: у неё в списке и на кнопках её инспекции.
  // ---------------------------------------------------------------

  function setModelIssue(issue) {
    modelIssue = issue || null;
    renderModelList();
  }

  function issueTitle(issue) {
    if (!issue) return '';
    if (issue.kind === 'unreadable') return t('issue.unreadable', { detail: issue.detail || '' });
    return t('issue.validation', { n: issue.count });
  }

  // Знак стоит ТОЛЬКО в списке моделей (renderModelList). Пробовали ставить его ещё и
  // на кнопки «Метаданные» и «Проверка» — три одинаковых знака на одном экране не
  // усиливают сообщение, а размывают его: непонятно, три это разные беды или одна.
  // Беда принадлежит модели, поэтому знак живёт там, где модель выбирают.

  // Счётчик на кнопке Validation: пока собранной модели нет — число проблем исходника;
  // после сборки — «было → стало», чтобы разница была видна не открывая окно.
  function updateInspectButtons() {
    if (!modelInspect) { setText(btnValidation, 'outliner.validation'); return; }
    // считаем только настоящие проблемы: сообщения, объяснённые слепотой валидатора
    // к расширениям, дефектами модели не являются (см. explainedBy в addons/gltf).
    const real = (data) => (data.validation || []).filter((m) => !m.explainedBy).length;
    const src = real(modelInspect);
    const dst = resultInspect ? real(resultInspect) : null;
    // Обе стороны чистые — не мусорим нулями в подписи.
    if (!src && !dst) { setText(btnValidation, 'outliner.validation'); return; }
    if (dst === null) setText(btnValidation, 'outliner.validation.count', { n: src });
    else setText(btnValidation, 'outliner.validation.range', { from: src, to: dst });
  }

  // Инспекция собранного файла для правой колонки окон. Тот же формат, что и у исходника,
  // поэтому окна рисуются одной и той же функцией на два столбца.
  async function inspectResult(downloadUrl) {
    resultInspect = null;
    updateInspectButtons();
    if (!downloadUrl) return;
    const token = runToken; // ответ устарел, если за это время была новая сборка
    try {
      const res = await fetch(downloadUrl.replace('/api/download', '/api/inspect-result'));
      if (token !== runToken) return;
      if (!res.ok) {
        logMessage('warn', t('log.resultInspectFailed', { status: res.status }));
        return;
      }
      const data = await res.json();
      if (token !== runToken) return;
      resultInspect = data;
      updateInspectButtons();
      if (!metadataWindow.classList.contains('hidden')) renderMetadataWindow();
      if (!validationWindow.classList.contains('hidden')) renderValidationWindow();
      const n = (data.validation || []).filter((m) => !m.explainedBy).length;
      logMessage('info', n
        ? t('log.resultInspected', { n })
        : t('log.resultInspected', { n: 0 }));
      logBlindSpots(data.validation);
    } catch (e) {
      logMessage('warn', t('log.resultInspectError', { error: e.message }));
    }
  }

  // Состояние панели опций после (пере)сборки панели или загрузки модели.
  // Если пользователь уже что-то выбирал на этой платформе — ВОССТАНАВЛИВАЕМ его выбор
  // (настройки не слетают при новой модели/возврате платформы). Иначе — рекомендуемые
  // дефолты + авто-флажки по источнику. Бейджи [Source] показываем всегда по текущей модели.
  function applyDetection(keep) {
    // Знак цены снимается тоже: он относится к ПРОШЛОЙ сборке. Оставить его на новой
    // модели значило бы обвинить галочку в том, чего на этой модели ещё не случилось.
    extensionsList.querySelectorAll('.ext-source-badge, .ext-advised-badge, .ext-cost-badge').forEach((b) => b.remove());

    // Режим «Советуем» (по умолчанию): каждая модель сбрасывает флажки под себя —
    // под то, что в ней уже есть, и под то, что ей нужно. Иначе выбор, сделанный
    // однажды на одной модели, молча переезжает на все следующие, и человек не
    // понимает, почему совет не сработал. Режим «Мой выбор» оставляет всё как было.
    //
    // keep перебивает оба режима: панель пересобрали не из-за новой модели, а чтобы
    // перечитать подписи (смена языка), и выбор обязан пережить это дословно.
    const saved = savedSelections[platformSelect.value];
    if (keep) restoreSelection(keep);
    else if (saved && adviceMode === 'manual') restoreSelection(saved);
    else applyDefaultSelection();

    showDetectionBadges();
    refreshInputNotes();
    // Знак цены относится к показанному результату, а не к сборке, которая только что
    // прошла: пока на экране тот же результат, знак обязан быть на месте. Иначе он
    // пропадал при каждой пересборке панели — переключении модели, смене языка.
    if (lastResult) renderCostBadges(lastResult.skipped);
    syncGeometryRadio();
    syncKtx2ModeUI();
    toggleKtx2Mode(!!(document.getElementById('ext-ktx2') && document.getElementById('ext-ktx2').checked));
    // Панель пересобрана заново (смена языка) — заморозку надо наложить снова: новые
    // элементы про идущую сборку ничего не знают и приходят доступными.
    freezeSettings(buildInFlight);
    updateRunButtonState();
  }

  // Рекомендуемые дефолты: Safe + Join, геометрия None; авто-выбор по тому, что уже сжато
  // в исходнике. Remove vertex colors по умолчанию ВЫКЛ (белые каналы чистит Safe без потерь).
  function applyDefaultSelection() {
    setCheck('safe', true);
    setCheck('join', true);
    setCheck('strip-colors', false);
    setCheck('ktx2', false);
    // Человек ничего не выбирал — значит показываем то, что советует площадка.
    ktx2Mode = defaultKtx2Mode();
    geometryChoice = 'none';
    if (lastDetection) {
      if (lastDetection.draco) geometryChoice = 'draco';
      else if (lastDetection.meshopt) geometryChoice = 'meshopt';
      if (lastDetection.ktx2) setCheck('ktx2', true);
      // Модель построена на общей геометрии → инстансинг обязателен, и не столько ради
      // отрисовок, сколько ради того, чтобы join не размножил эту геометрию в копии.
      // Join включён по умолчанию, поэтому без этой строки шахматная доска из коробки
      // получала бы +84 % к весу. Замеры — в docs/ВОПРОСЫ_И_ОТВЕТЫ.md.
      if (hasSharedGeometry()) setCheck('instance', true);
    }
  }

  // Общая геометрия найдена в модели: несколько узлов на один меш.
  function hasSharedGeometry() {
    const opp = lastDetection && lastDetection.opportunity;
    return !!(opp && opp.sharedMeshes > 0);
  }

  // Восстановить последний выбор пользователя на этой платформе. Геометрия, которой на
  // платформе нет (нет radio), откатывается к None; флажки берём по существующим чекбоксам.
  function restoreSelection(saved) {
    geometryChoice = saved.geometryChoice || 'none';
    if (geometryChoice !== 'none' && !document.getElementById(`geom-${geometryChoice}`)) geometryChoice = 'none';
    ktx2Mode = saved.ktx2Mode || defaultKtx2Mode();
    for (const cb of extensionsList.querySelectorAll('.ext-checkbox')) {
      cb.checked = saved.checked.includes(cb.value);
    }
  }

  // Снимок того, что сейчас стоит в панели. Это ВЕСЬ её изменяемый состав: флажки,
  // выбранный кодек геометрии, режим KTX2. Значки ([Source], «Советуем», знак цены)
  // сюда не входят — они выводятся из lastDetection и lastResult и рисуются заново.
  function currentSelection() {
    return {
      geometryChoice,
      ktx2Mode,
      checked: [...extensionsList.querySelectorAll('.ext-checkbox:checked')].map((cb) => cb.value),
    };
  }

  // Снимок текущего выбора → память платформы. Зовётся только при ЯВНОМ действии
  // пользователя (не из applyDefaultSelection), иначе дефолты затирали бы «последний выбор».
  function rememberSelection() {
    savedSelections[platformSelect.value] = currentSelection();
  }

  // Перечитать панель опций на другом языке.
  //
  // Подписи и описания опций приходят с сервера (assistant.mjs), поэтому обойтись
  // подменой текста на месте нельзя — панель собирается заново. Но пересборка не имеет
  // права ничего решать: снимаем выбор до неё и возвращаем дословно после. Смена языка
  // меняет слова, а не настройки сборки.
  async function relabelExtensions() {
    if (!platformSelect.value) return;
    const keep = extensionsList.querySelector('.ext-checkbox') ? currentSelection() : undefined;
    await loadExtensions(platformSelect.value, keep);
  }

  // Бейджи [Source] — по текущей модели, информационно (что уже было в импортированном файле).
  function showDetectionBadges() {
    if (!lastDetection) return;
    if (lastDetection.draco) badgeGeometry('draco');
    else if (lastDetection.meshopt) badgeGeometry('meshopt');
    if (lastDetection.ktx2) badgeCheck('ktx2');
    if (lastDetection.instance) badgeCheck('instance');
    // Отдельный значок, а не [Source]: [Source] означает «в файле уже есть, сохраняем»,
    // а здесь наоборот — в файле этого нет, но содержимое просит включить. Одинаковый
    // значок на двух разных утверждениях обесценил бы оба.
    else if (hasSharedGeometry()) badgeAdvised('instance', lastDetection.opportunity);
  }

  // Красный знак у галочки, которая назначила цену: правило само измерило, во что
  // обошлась его работа, и назвало свою фичу (поле feature в записи skipped).
  //
  // Именно у галочки, а не только в отчёте: человек смотрит на «+1064 %» и ищет
  // виноватого среди семи флажков. Отчёт он прочтёт потом — если вообще прочтёт,
  // а решение принимает здесь и сейчас.
  function renderCostBadges(skipped) {
    extensionsList.querySelectorAll('.ext-cost-badge').forEach((b) => b.remove());
    for (const s of skipped || []) {
      if (!s || s.kind !== 'cost' || !s.feature) continue;
      // Геометрия — не чекбокс, а строка выбора кодека: ищем оба варианта разметки.
      const cb = document.getElementById(`ext-${s.feature}`);
      const container = (cb && cb.closest('.ext-row'))
        || document.querySelector(`.opt-radio-row[data-geom="${s.feature}"]`);
      if (!container || container.querySelector('.ext-cost-badge')) continue;
      const anchor = container.querySelector('.ext-label') || container.querySelector('.opt-radio-text') || container;
      const badge = document.createElement('span');
      badge.className = 'ext-cost-badge';
      badge.textContent = '!';
      badge.title = s.text;               // текст правила, с числами и советом
      badge.setAttribute('aria-label', s.text);
      anchor.appendChild(badge);
    }
  }

  function badgeAdvised(id, opp) {
    const cb = document.getElementById(`ext-${id}`);
    const container = cb && cb.closest('.ext-row');
    if (!container || container.querySelector('.ext-advised-badge')) return;
    const anchor = container.querySelector('.ext-label') || container;
    const badge = document.createElement('span');
    badge.className = 'ext-advised-badge';
    badge.textContent = t('ext.advised');
    badge.title = t('ext.advised.shared', { meshes: opp.sharedMeshes, nodes: opp.sharedNodes });
    anchor.appendChild(badge);
  }

  // Взаимоисключение геометрии — чекбоксы, не radio-группа (нужно уметь снимать выбор
  // повторным кликом), поэтому "снятие второго" делаем вручную при каждой смене.
  function syncGeometryRadio() {
    for (const row of extensionsList.querySelectorAll('.opt-radio-row[data-geom]')) {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = (row.dataset.geom === geometryChoice);
    }
  }

  // Синхронизировать UI режима KTX2 (radio + подпись) с переменной ktx2Mode при восстановлении.
  function syncKtx2ModeUI() {
    const radio = document.querySelector(`input[name="ktx2mode"][value="${ktx2Mode}"]`);
    if (radio) radio.checked = true;
    const cur = document.querySelector('.ktx2-mode-current');
    if (cur) cur.textContent = ktx2Mode === 'mixed' ? 'ETC1S' : 'UASTC';
  }

  function badgeGeometry(v) {
    addSourceBadge(document.querySelector(`.opt-radio-row[data-geom="${v}"]`), '.opt-radio-text');
  }

  function badgeCheck(id) {
    const cb = document.getElementById(`ext-${id}`);
    addSourceBadge(cb && cb.closest('.ext-row'), '.ext-label');
  }

  function addSourceBadge(container, anchorSel) {
    if (!container || container.querySelector('.ext-source-badge')) return;
    const anchor = container.querySelector(anchorSel) || container;
    const badge = document.createElement('span');
    badge.className = 'ext-source-badge';
    badge.textContent = t('ext.source');
    badge.title = t('ext.source.title');
    anchor.appendChild(badge);
  }

  // HUD слева — данные исходной модели, те же строки, что появятся там после сборки.
  //
  // Источник — метрики движка из /api/inspect (`modelInspect.metrics`), посчитанные той
  // же collectMetrics(), что даёт metrics.before в отчёте. Поэтому цифры до сборки и
  // после — одни и те же, а не два независимых подсчёта.
  //
  // Раньше здесь считалась отрисованная сцена three.js, и это давало две беды.
  // Первая: набор строк расходился — VRAM появлялась только после сборки, хотя это
  // главная величина для телефона и решать по ней надо ДО. Вторая, злее: не
  // отрисовалось — человек не узнавал о модели ничего. Пустая шапка при живом файле,
  // который сервер уже разобрал и даже назвал в нём замечания.
  //
  // Сцена осталась запасным вариантом: она приходит раньше инспекции, и на большой
  // модели эти секунды заметны. Как только инспекция ответит — цифры заменяются
  // движковыми. Обратной замены не бывает: авторитетный источник не уступает запасному.
  function renderSourceStats(fileSize) {
    statsBefore.innerHTML = '';
    const m = modelInspect && modelInspect.metrics;
    const rows = m
      ? [
        ['FILE', fmtBytes(m.fileBytes != null ? m.fileBytes : fileSize)],
        ['TRIS', fmtInt(m.triangles)],
        ['VERT', fmtInt(m.vertices)],
        ['DRAWS', fmtInt(m.drawCalls)],
        ['MATS', fmtInt(m.materials)],
        ['TEX', fmtInt(m.textures)],
        ['VRAM', fmtBytes(m.gpuBytes)],
      ]
      : originalStats
        ? [
          ['FILE', fmtBytes(fileSize)],
          ['TRIS', fmtInt(originalStats.triangles)],
          ['VERT', fmtInt(originalStats.vertices)],
          ['DRAWS', fmtInt(originalStats.drawCalls)],
          ['MATS', fmtInt(originalStats.materials)],
          ['TEX', fmtInt(originalStats.textures)],
        ]
        : [];
    for (const [k, v] of rows) statsBefore.appendChild(hudLine(k, v, null));
  }

  // Сбросить всё, что относится к предыдущему результату оптимизации (при загрузке
  // новой модели). Саму загруженную модель и вьюпорты не трогает.
  function clearResults() {
    lastResult = null;
    lastExplain = null;
    currentSourceId = null;
    lastBuildSignature = null; // новая модель ещё не собиралась — первая сборка разрешена
    resultInspect = null; // окна инспекции снова показывают только исходник
    runToken++; // инвалидирует inspectResult() прежней модели, если он ещё летит
    updateInspectButtons();
    resultDownloadUrl = null;
    downloadBtn.classList.add('hidden');
    exportWindow.classList.add('hidden');
    irreversibleWarning.classList.add('hidden');
    renderIntegrity(null); // прячет плашку, значок на кнопке и блок в окне выгрузки разом
    failBanner.classList.add('hidden');
    setText(runBtn, 'btn.build');
    // Правый HUD пуст до сборки; левый заполняется базовыми данными модели в handleFile.
    statsAfter.innerHTML = '';
    [summarySection, analysisSection, budgetsSection, warningsSection,
      appliedSection, skippedSection, validationSection].forEach((s) => s.classList.add('hidden'));
  }

  // Список моделей слева. Пока одна модель за раз; позже — несколько с выбором.
  // Большая зона сброса нужна ровно до первой модели: пока список пуст, это
  // единственная заметная подсказка, что от человека вообще хотят файл. Как только
  // модель загружена, она превращается в пустой прямоугольник, занимающий половину
  // сайдбара, — и уступает место списку. Заменить модель по-прежнему можно двумя
  // способами: кнопкой «+» в шапке и броском файла на сайдбар (см. dropTarget).
  //
  // Когда список станет многомодельным, менять здесь ничего не придётся: условие
  // «список пуст» уже сформулировано правильно.
  function syncDropzone() {
    dropzone.classList.toggle('hidden', modelList.children.length > 0);
  }

  function renderModelList() {
    modelList.innerHTML = '';
    for (const rec of models) {
      const li = document.createElement('li');
      li.className = 'model-item' + (rec.id === activeModelId ? ' selected' : '');
      li.dataset.modelId = rec.id;
      // Галочка у моделей, которые уже собраны: по списку сразу видно, что сделано,
      // а что ещё ждёт. Без этого при пяти моделях приходится щёлкать каждую.
      const icon = document.createElement('span');
      icon.className = 'model-icon';
      icon.textContent = rec.state.lastResult ? '✓' : '▣';
      if (rec.state.lastResult) icon.title = t('models.built');
      const name = document.createElement('span');
      name.className = 'model-name';
      name.textContent = rec.file.name;
      name.title = rec.file.name;
      const size = document.createElement('span');
      size.className = 'model-size';
      size.textContent = fmtBytes(rec.file.size);

      const remove = document.createElement('button');
      remove.className = 'model-remove';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = t('models.remove');
      remove.setAttribute('aria-label', t('models.remove'));
      // stopPropagation: клик по крестику не должен заодно выбирать модель,
      // которую он удаляет.
      remove.addEventListener('click', (e) => { e.stopPropagation(); removeModel(rec.id); });

      li.appendChild(icon);
      li.appendChild(name);
      // Знак беды у самой модели. В списке он нужнее всего: человек выбирает, с чем
      // работать, ещё до того, как откроет проверку. Активная модель берёт состояние
      // из живой переменной — в записи оно лежит только после captureActiveModel().
      const issue = rec.id === activeModelId ? modelIssue : rec.state.modelIssue;
      if (issue) {
        const alert = document.createElement('span');
        // Красный — только когда файл не открылся. Нарушения стандарта в файле,
        // который читается и рисуется, — жёлтые: смотреть стоит, но работать можно.
        // Красным они кричали «модель сломана» о персонаже, который нормально
        // выглядит и бегает (chibi_zenitsu — 142 нарушения byteStride в анимации,
        // three.js их прощает).
        alert.className = issue.kind === 'unreadable' ? 'model-alert' : 'model-alert is-warn';
        alert.textContent = '!';
        alert.title = issueTitle(issue);
        alert.setAttribute('aria-label', alert.title);
        li.appendChild(alert);
      }
      li.appendChild(size);
      li.appendChild(remove);
      li.addEventListener('click', () => selectModel(rec.id));
      modelList.appendChild(li);
    }
    syncDropzone();
  }

  // -----------------------------------------------------------------------
  // Добавление, выбор и удаление моделей
  // -----------------------------------------------------------------------

  function addModel(file) {
    captureActiveModel();          // не потерять состояние той, что сейчас на экране
    const rec = { id: `m${++modelSeq}`, file, state: {} };
    models.push(rec);
    activeModelId = rec.id;
    applyModelState(null);         // новая модель начинает с чистого состояния
    selectedFile = file;
    return rec;
  }

  async function selectModel(id) {
    if (id === activeModelId) return;
    const rec = models.find((m) => m.id === id);
    if (!rec) return;
    captureActiveModel();
    activeModelId = id;
    applyModelState(rec.state);
    renderModelList();
    await showActiveModel();
  }

  function removeModel(id) {
    const i = models.findIndex((m) => m.id === id);
    if (i === -1) return;
    const [rec] = models.splice(i, 1);
    // Сервер держит копию исходника на диске. Не сказать ему об удалении — значит
    // оставить файл лежать до перезапуска: у человека на диске молча копятся
    // десятки мегабайт, и он никогда не узнает почему.
    releaseSource(rec.state.currentSourceId || (rec.id === activeModelId ? currentSourceId : null));

    if (rec.id !== activeModelId) { renderModelList(); return; }

    // Удалили ту, что на экране: показываем соседнюю, а если список опустел —
    // возвращаем интерфейс в состояние «модель ещё не загружали».
    const next = models[i] || models[i - 1] || null;
    activeModelId = next ? next.id : null;
    applyModelState(next ? next.state : null);
    renderModelList();
    if (next) showActiveModel();
    else resetToEmpty();
  }

  function releaseSource(sourceId) {
    if (!sourceId) return;
    fetch(`/api/source/${encodeURIComponent(sourceId)}`, { method: 'DELETE' })
      .catch(() => { /* сервер мог уже перезапуститься — не наша забота */ });
  }

  // Показать активную модель целиком: сцена, HUD, отчёт, кнопки.
  //
  // Модель перезагружается во вьюпорт при каждом переключении, а не держится в сцене
  // про запас: одна ABeautifulGame стоит 704 МБ видеопамяти, и пара таких «про запас»
  // положила бы вкладку. Плата — секунды на разбор тяжёлого файла, поэтому крутится
  // индикатор ожидания.
  async function showActiveModel() {
    const rec = activeModel();
    if (!rec) return;

    clearResultPanels();
    if (window.OptiViewer) {
      setBusy('preview-original', 'busy.loading');
      try {
        await window.OptiViewer.loadOriginal(rec.file);
      } finally {
        setBusy('preview-original', null);
      }
    }
    renderSourceStats(rec.file.size);
    applyDetection();

    // Результат уже собран — вернуть его на экран целиком, не пересобирая.
    if (lastResult && lastExplain) {
      renderReport(lastResult, lastExplain);
      const integrityFailed = lastResult.status === 'fail';
      renderIntegrity(lastResult);
      setPhase(integrityFailed ? 'status.doneWithIssue' : 'status.ready', integrityFailed ? 'fail' : null);
      setText(runBtn, 'btn.rebuild');
      if (resultDownloadUrl) {
        downloadBtn.classList.remove('hidden');
        renderIrreversibleWarning(lastResult.applied);
        if (window.OptiViewer) {
          setBusy('preview-optimized', 'busy.loading');
          try {
            await window.OptiViewer.loadOptimized(resultDownloadUrl);
          } finally {
            setBusy('preview-optimized', null);
          }
        }
      }
    } else {
      setText(runBtn, 'btn.build');
      setPhase('status.ready', null);
    }
    updateInspectButtons();
    updateRunButtonState();
  }

  // Панели результата — в исходное. В отличие от clearResults() НЕ трогает состояние
  // модели: при переключении оно уже загружено из записи и затирать его нельзя.
  function clearResultPanels() {
    statsAfter.innerHTML = '';
    downloadBtn.classList.add('hidden');
    exportWindow.classList.add('hidden');
    irreversibleWarning.classList.add('hidden');
    renderIntegrity(null); // прячет плашку, значок на кнопке и блок в окне выгрузки разом
    failBanner.classList.add('hidden');
    [summarySection, analysisSection, budgetsSection, warningsSection,
      appliedSection, skippedSection, validationSection].forEach((s) => s.classList.add('hidden'));
  }

  // Список опустел — вернуть интерфейс к виду «модель ещё не загружали».
  function resetToEmpty() {
    applyModelState(null);
    clearResultPanels();
    statsBefore.innerHTML = '';
    chosenFileLabel.textContent = '';
    runBtn.disabled = true;
    setText(runBtn, 'btn.build');
    if (stageHint) stageHint.classList.remove('hidden');
    if (window.OptiViewer) window.OptiViewer.reset();
    setPhase('status.ready', null);
    updateInspectButtons();
  }

  // -----------------------------------------------------------------------
  // Строка меню
  // -----------------------------------------------------------------------

  function initMenubar() {
    const menubar = document.getElementById('menubar');
    if (!menubar) return;

    const panels = [...menubar.querySelectorAll('.menu-panel')];
    const titles = [...menubar.querySelectorAll('.menu-title')];
    const closeAll = () => {
      panels.forEach((p) => p.classList.add('hidden'));
      titles.forEach((b) => b.classList.remove('open'));
    };

    for (const btn of titles) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.menu;
        const panel = menubar.querySelector(`[data-menu-panel="${name}"]`);
        const wasOpen = panel && !panel.classList.contains('hidden');
        closeAll();
        if (panel && !wasOpen) { panel.classList.remove('hidden'); btn.classList.add('open'); }
      });
    }
    // Клик мимо и Escape закрывают меню. Без этого раскрытая панель висит поверх
    // модели, и её приходится закрывать тем же пунктом, которым открыл.
    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
    for (const p of panels) p.addEventListener('click', (e) => e.stopPropagation());

    const openItem = document.getElementById('menu-open');
    if (openItem) openItem.addEventListener('click', () => { closeAll(); fileInput.click(); });

    const dlItem = document.getElementById('menu-download');
    if (dlItem) {
      dlItem.addEventListener('click', () => { closeAll(); downloadBtn.click(); });
      // Пункт, который ничего не делает, хуже отсутствующего: пока результата нет,
      // он неактивен. Состояние обновляется при каждом открытии меню.
      const syncDownload = () => { dlItem.disabled = !resultDownloadUrl; };
      for (const btn of titles) btn.addEventListener('click', syncDownload);
      syncDownload();
    }

    for (const radio of menubar.querySelectorAll('input[name="advice-mode"]')) {
      radio.checked = radio.value === adviceMode;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        adviceMode = radio.value;
        try { localStorage.setItem(ADVICE_MODE_KEY, adviceMode); } catch (e) { /* приватный режим */ }
        logMessage('info', t(adviceMode === 'advise' ? 'log.adviceMode.advise' : 'log.adviceMode.manual'));
        // Переключили на «Советуем» — применить совет к модели, которая уже на экране,
        // а не ждать следующей загрузки: иначе настройка выглядит сломанной.
        if (adviceMode === 'advise') applyDetection();
      });
    }
  }

  chooseFileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

  dropzone.addEventListener('click', () => fileInput.click());

  // -----------------------------------------------------------------------
  // Перетаскивание: цель — ВСЁ ОКНО, а не зона сброса и не сайдбар.
  //
  // Три причины, каждой хватило бы по отдельности:
  //
  // 1. Зона сброса исчезает, как только модель загружена (см. syncDropzone).
  //    Держи обработчики на ней — вместе с ней пропала бы и возможность
  //    перетащить следующую модель.
  // 2. Человек целится туда, куда смотрит, а смотрит он на модель. Бросок на
  //    вьюпорт или на панель настроек — самое естественное движение, и оно
  //    обязано работать.
  // 3. Без перехвата на уровне окна бросок мимо цели УВОДИТ СО СТРАНИЦЫ:
  //    браузер по умолчанию открывает файл как документ, и вся работа теряется.
  //    Это чинится только тем, что окно само гасит событие. Проверено 2026-07-31:
  //    до этой правки drop на вьюпорте не перехватывал никто.
  //
  // dragenter/dragleave стреляют на КАЖДОМ элементе под курсором, поэтому голый
  // dragleave гасил бы подсветку при переходе между соседними кнопками. Считаем
  // глубину: подсветка снимается, только когда счётчик вернулся к нулю.
  let dragDepth = 0;

  // Тянуть можно и выделенный текст, и ссылку — на них подсветка не нужна.
  function isFileDrag(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.includes.call(types, 'Files');
  }

  function showDropOverlay(on) {
    if (dropOverlay) dropOverlay.classList.toggle('hidden', !on);
    document.body.classList.toggle('drag-active', on);
  }

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth++;
    showDropOverlay(true);
  });

  // preventDefault на dragover обязателен: без него drop не случится вовсе,
  // браузер сочтёт, что бросать сюда нельзя, и откроет файл сам.
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDropOverlay(false);
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault(); // иначе браузер откроет .glb как документ
    dragDepth = 0;
    showDropOverlay(false);
    if (!isFileDrag(e)) return;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });

  // ---------------------------------------------------------------
  // Статус-бар
  // ---------------------------------------------------------------

  // Принимает КЛЮЧ, а не готовую строку: статус живёт на экране долго, и при смене
  // языка его надо перерисовать. Готовую строку перерисовать нельзя — она уже забыла,
  // из чего собрана, и i18n откатил бы статус к «Готово» из разметки.
  function setPhase(key, mode, params) {
    setText(phaseStatus, key, params);
    statusDot.classList.remove('busy', 'fail');
    if (mode === 'busy') statusDot.classList.add('busy');
    if (mode === 'fail') statusDot.classList.add('fail');
  }

  function onProgressEvent(e) {
    if (e.type === 'phase') {
      setPhase('status.phase', 'busy', { n: e.phase, name: e.name });
      logMessage('debug', `Phase ${e.phase}: ${e.name}`);
    } else if (e.type === 'rule') {
      setPhase('status.rule', 'busy', { title: e.title });
      logMessage('debug', `Rule: ${e.title}`);
    }
  }

  // ---------------------------------------------------------------
  // Запуск обработки
  // ---------------------------------------------------------------

  runBtn.addEventListener('click', runOptimize);

  function buildOptimizeUrl(jobId, useSource) {
    const platformId = platformSelect.value;
    const features = getSelectedFeatures();
    const featuresParam = features.length ? `&features=${encodeURIComponent(features.join(','))}` : '';
    const sourceParam = useSource && currentSourceId ? `&source=${encodeURIComponent(currentSourceId)}` : '';
    // режим KTX2 (UASTC/ETC1S) → texMode; актуален только когда выбран флажок ktx2
    const texParam = features.includes('ktx2') ? `&texMode=${encodeURIComponent(ktx2Mode)}` : '';
    // Движок — по тем же основаниям, что и в /api/extensions: при прочерке базовый план
    // берётся у него, иначе сборка пошла бы с чужими умолчаниями.
    const engineParam = `&engine=${encodeURIComponent(engineSelect.value || '')}`;
    return `/api/optimize?platform=${encodeURIComponent(platformId)}${engineParam}&job=${encodeURIComponent(jobId)}&${langParam()}${featuresParam}${sourceParam}${texParam}`;
  }

  // Повтор по sourceId — без тела (модель уже на сервере); первый прогон — с телом файла.
  async function sendOptimize(jobId) {
    const doFetch = (withSource) => fetch(buildOptimizeUrl(jobId, withSource), {
      method: 'POST',
      headers: {
        'X-Filename': encodeURIComponent(selectedFile.name),
        'Content-Type': 'application/octet-stream',
      },
      body: withSource ? null : selectedFile,
    });

    const useSource = !!currentSourceId;
    let res = await doFetch(useSource);
    // Исходник на сервере пропал (например, перезапуск) — перезаливаем файл и повторяем.
    if (res.status === 410 && useSource) {
      currentSourceId = null;
      res = await doFetch(false);
    }
    return res;
  }

  // Настройки на время сборки замораживаются целиком: флажки, выбор площадки, режим
  // текстур — всё, что влияет на результат.
  //
  // Причина не в защите от второй сборки (её держит buildInFlight), а в том, что
  // человек читает. Сборка тяжёлой модели идёт минуту; за минуту флажки успевают
  // передвинуть, и к моменту, когда отчёт наконец появляется, панель показывает уже
  // не тот набор, которым он собран. Отчёт при этом верный — но проверить его не по
  // чему, и «что конкретно мы делали» приходится вспоминать. Замороженная панель
  // отвечает на этот вопрос сама: рядом с готовым отчётом стоят ровно те галочки,
  // которые его дали.
  //
  // disabled, а не «клик игнорируем»: недоступный вид сам объясняет, что сейчас нельзя,
  // и не создаёт впечатления, будто интерфейс не отвечает.
  function freezeSettings(frozen) {
    platformSelect.disabled = frozen;
    for (const el of extensionsList.querySelectorAll('input, select, button')) el.disabled = frozen;
    extensionsPanel.classList.toggle('is-frozen', frozen);
  }

  async function runOptimize() {
    if (!selectedFile || buildInFlight) return;

    buildInFlight = true;
    // Снимок настроек на момент запуска — см. renderResult.
    startedSignature = currentSettingsSignature();
    freezeSettings(true);
    runBtn.disabled = true;
    setPhase(currentSourceId ? 'status.optimizing' : 'status.uploading', 'busy');
    setBusy('preview-optimized', currentSourceId ? 'busy.optimizing' : 'busy.uploading');
    const feats = getSelectedFeatures();
    logMessage('info', t('log.buildStarted', {
      platform: platformSelect.value,
      options: feats.join(', ') || t('log.none'),
    }));

    const jobId = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    let es = null;
    try {
      es = new EventSource(`/api/progress?job=${encodeURIComponent(jobId)}`);
      es.onmessage = (msg) => {
        try { onProgressEvent(JSON.parse(msg.data)); } catch (e2) { /* игнор */ }
      };
      es.onerror = () => { /* соединение закроется само после завершения — не страшно */ };
    } catch (e) {
      // SSE недоступен — работаем без живого статуса фаз
    }

    try {
      const res = await sendOptimize(jobId);

      if (es) es.close();

      const data = await res.json();

      if (!res.ok) {
        showGenericError(data && data.error ? data.error : t('log.serverError', { status: res.status }));
        return;
      }

      // Ждём, пока результат появится в правом окне: индикатор должен гаснуть по
      // картинке, а не по ответу сервера. Ошибку загрузки глотаем — её показывает
      // сам вьюпорт своей строкой состояния, а нам здесь важно снять индикатор.
      const shown = renderResult(data);
      if (shown) await shown.catch(() => {});
    } catch (e) {
      if (es) es.close();
      showGenericError(t('log.noServer', { error: e.message }));
    } finally {
      buildInFlight = false;
      freezeSettings(false);
      setBusy('preview-optimized', null);
      updateRunButtonState();
      // Сложить результат в запись модели СРАЗУ, а не при следующем переключении:
      // иначе галочка «собрана» в списке появлялась бы с опозданием на одно действие,
      // а закрытие вкладки теряло бы связь результата с моделью.
      captureActiveModel();
      renderModelList();
    }
  }

  function showGenericError(message) {
    setPhase('status.error', 'fail');
    logMessage('error', message);
    showWindow(failBanner);
    failBanner.querySelector('.fail-title').textContent = t('fail.generic');
    failBanner.querySelector('.fail-text').textContent = message;
    failValidation.innerHTML = '';
    // Кнопку не прячем; прогон не удался — разрешаем повтор даже с теми же настройками.
    lastBuildSignature = null;
    irreversibleWarning.classList.add('hidden');
    renderIntegrity(null); // прячет плашку, значок на кнопке и блок в окне выгрузки разом
  }

  // ---------------------------------------------------------------
  // Рендер результата
  // ---------------------------------------------------------------

  function renderReport(result, explain) {
    lastResult = result;
    lastExplain = explain;
    renderComparison(result.metrics);
    renderSummary(explain);
    renderValidation(result.validation);
    renderIssues(result.findings, result.applied);
    renderBudgets(explain && explain.budgetChecks);
    renderWarnings(explain && explain.warnings);
    renderAppliedSkipped(result.applied, result.skipped);
    // Красный знак цены у галочки: правило само измерило, во что обошлась его работа
    // (kind:'cost' + feature в записях skipped). Рисуется ПОСЛЕ отчёта — иначе его
    // снёс бы перерендер панели опций, а отдельного вызова в runOptimize нет намеренно:
    // смена языка тоже перерисовывает отчёт (reexplainLastResult → renderReport),
    // и бейджи должны пережить её.
    renderCostBadges(result.skipped);
  }

  function renderResult(data) {
    const { result, explain, downloadUrl } = data;

    // Запоминаем серверный исходник даже при fail (файл уже загружен) — чтобы повтор
    // с другими флажками шёл без перезаливки.
    if (data.sourceId) currentSourceId = data.sourceId;

    // Файла нет вовсе (обработка сорвалась) — показать окно отказа и остановиться:
    // показывать нечего. А вот провал проверки целостности при записанном файле —
    // не то же самое: результат существует, его надо показать, дать сравнить глазами
    // и дать скачать. Решать, годится ли расхождение, — пользователю, не программе.
    const written = !!(result && result.file && result.file.written);
    if (!result || (result.status === 'fail' && !written)) {
      renderFail(result, explain);
      return;
    }

    const integrityFailed = result.status === 'fail';
    setPhase(integrityFailed ? 'status.doneWithIssue' : 'status.ready', integrityFailed ? 'fail' : null);
    failBanner.classList.add('hidden');

    // Применённые правила — раньше итога, чтобы в свёрнутой панели логов (она показывает
    // последнее сообщение) оставался итог сборки, а не случайное последнее правило.
    for (const a of result.applied || []) logMessage('debug', t('log.applied', { text: a.text }));
    const m = result.metrics;
    if (m && m.before && m.after) {
      logMessage('info', t('log.buildFinishedSize', {
        before: fmtBytes(m.before.fileBytes),
        after: fmtBytes(m.after.fileBytes),
        pct: pctText(m.before.fileBytes, m.after.fileBytes),
      }));
    } else {
      logMessage('info', t('log.buildFinished'));
    }

    renderReport(result, explain);
    renderCostBadges(result.skipped);
    renderIntegrity(result);
    // warn, а не error: файл собран и лежит готовый. Красная строка в журнале рядом с
    // работающей кнопкой выгрузки — сообщение о несуществующей поломке.
    if (integrityFailed) logMessage('warn', t('log.integrityFailed'));

    // Кнопку не прячем — можно менять флажки и пересобирать результат сколько угодно раз.
    // Запоминаем настройки ЭТОЙ сборки: пока их не изменят, пересборка неактивна.
    //
    // Именно те, с которыми сборку запускали, а не те, что стоят сейчас. Человек успевает
    // передвинуть флажки, пока идёт сборка, — и снимок текущих настроек означал бы
    // «собрано ровно это», хотя собрано другое: кнопка «Пересобрать» гасла, и результат,
    // не соответствующий флажкам на экране, выдавался за соответствующий.
    setText(runBtn, 'btn.rebuild');
    lastBuildSignature = startedSignature ?? currentSettingsSignature();

    // Результат перезаписывается на сервере при каждом прогоне → анти-кэш в URL,
    // чтобы вьюпорт и скачивание всегда брали свежий вариант.
    const bust = (u) => (u ? u + (u.includes('?') ? '&' : '?') + 't=' + (++runToken) : u);
    const freshUrl = bust(downloadUrl);

    // Правый вьюпорт: загрузить оптимизированную модель (оригинал уже показан слева).
    // Промис возвращается наружу: индикатор ожидания в правом окне должен гаснуть,
    // когда модель ВИДНА, а не когда сервер ответил. Между этими моментами на тяжёлой
    // модели проходят секунды разбора и загрузки текстур.
    let optimizedShown = null;
    if (window.OptiViewer) optimizedShown = Promise.resolve(window.OptiViewer.loadOptimized(freshUrl));

    if (downloadUrl) {
      resultDownloadUrl = freshUrl;
      const dstName = result.file && result.file.dst ? result.file.dst.split(/[\\/]/).pop() : 'model.glb';
      resultExportBase = dstName.replace(/\.[^.]+$/, '') || 'model'; // имя без расширения — предзаполнить окно
      downloadBtn.classList.remove('hidden');
      renderIrreversibleWarning(result.applied);
      // Metadata/Validation собранной модели — правая колонка тех же окон.
      inspectResult(freshUrl);
    } else {
      resultDownloadUrl = null;
      downloadBtn.classList.add('hidden');
      irreversibleWarning.classList.add('hidden');
      renderIntegrity(null); // прячет плашку, значок на кнопке и блок в окне выгрузки разом
      resultInspect = null;
      runToken++; // инвалидирует inspectResult() предыдущей сборки, если он ещё летит
      updateInspectButtons();
    }
    return optimizedShown;
  }

  // §4d ARCHITECTURE.md: перед скачиванием предупреждаем, что часть данных потеряна
  // безвозвратно. Здесь остаётся ТОЛЬКО эта строка — перечень конкретных правок
  // переехал в «Анализ» отдельной карточкой (см. renderIssues). Причина простая:
  // закреплённый над кнопкой блок не прокручивается, и на модели с десятком
  // необратимых изменений он занимал половину панели, пряча всё остальное.
  function renderIrreversibleWarning(applied) {
    const lossy = (applied || []).filter((a) => a.reversible === false && a.dataLoss === 'significant');
    irreversibleWarning.classList.toggle('hidden', !lossy.length);
  }

  // Результат не сошёлся с исходником — сказать об этом громко и в трёх местах СРАЗУ,
  // но ничего при этом не запрещать.
  //
  // Действие выполняется всегда: файл собран, записан и выгружается по первому нажатию.
  // Отказ выдавать результат означал бы, что программа решила за человека, — а решает он:
  // на одной модели девятнадцать треугольников из ста девяноста пяти тысяч не значат
  // ничего, на другой это дырка в видимом месте. Наше дело — назвать расхождение точно,
  // числами, и не дать пройти мимо него случайно.
  //
  // Три места, и у каждого своя мера подробности:
  //   • плашка в панели — заголовок и одна строка, она закреплена и мешать не должна;
  //   • значок на кнопке — чтобы не уйти с экрана, не заметив;
  //   • блок в окне выгрузки — там числа целиком: окно открывают намеренно, ровно за
  //     этим, и это последняя точка, где ещё можно передумать.
  // Полный разбор — в сворачиваемом разделе «Проверка целостности» правой панели.
  // Строки берём из result.validation как есть: их собрал движок, они несут рецепт i18n
  // и переживают смену языка (core/i18n.mjs, LOCALIZED_LISTS).
  function renderIntegrity(result) {
    const failed = (result && result.status === 'fail')
      ? (result.validation || []).filter((v) => v.level === 'fail')
      : [];
    const show = failed.length > 0;

    integrityWarning.classList.toggle('hidden', !show);
    downloadAlert.classList.toggle('hidden', !show);
    exportAlert.classList.toggle('hidden', !show);
    if (show) {
      window.I18n.setTitle(downloadBtn, 'btn.download.alert');
    } else {
      // Снимаем и подсказку, и метку ключа: без второго apply() при смене языка
      // вернул бы подсказку на кнопку, у которой уже нечего предупреждать.
      downloadBtn.removeAttribute('data-i18n-title');
      downloadBtn.removeAttribute('title');
    }

    exportAlertDetails.innerHTML = '';
    if (!show) return;
    for (const v of failed) {
      const li = document.createElement('li');
      li.textContent = v.text;
      exportAlertDetails.appendChild(li);
    }
  }

  function renderFail(result, explain) {
    setPhase('status.failed', 'fail');
    logMessage('error', t('log.notWritten'));
    showWindow(failBanner);
    failBanner.querySelector('.fail-title').textContent = t('fail.notWritten');
    failBanner.querySelector('.fail-text').textContent =
      (explain && explain.summary) || t('fail.text');

    failValidation.innerHTML = '';
    const items = (result && result.validation) || [];
    for (const v of items) {
      const row = document.createElement('div');
      row.textContent = `${VALIDATION_ICON[v.level] || '·'} ${v.text}`;
      failValidation.appendChild(row);
    }

    resultDownloadUrl = null;
    downloadBtn.classList.add('hidden');
    exportWindow.classList.add('hidden');
    irreversibleWarning.classList.add('hidden');
    renderIntegrity(null); // прячет плашку, значок на кнопке и блок в окне выгрузки разом
    resultInspect = null; // собранного файла нет — правая колонка окон пуста
    runToken++; // инвалидирует inspectResult() предыдущей (успешной) сборки, если он ещё летит
    updateInspectButtons();
    // Кнопку оставляем; сборка не прошла — разрешаем повтор даже без смены настроек.
    lastBuildSignature = null;
    // Кнопку OPTIMIZE оставляем — пользователь может изменить флажки и повторить.
  }

  // Компактный HUD со статистикой в углах панелей. У оптимизированной стороны значения
  // подсвечиваются: зелёным — если метрика улучшилась (меньше), янтарным — если выросла.
  function renderComparison(metrics) {
    if (!metrics || !metrics.before || !metrics.after) return;
    const { before, after } = metrics;

    statsBefore.innerHTML = '';
    statsAfter.innerHTML = '';

    // Проценты — только у файла и видеопамяти, и это не экономия места.
    //
    // Эти две строки составляют размен, ради которого всё и делается, а поодиночке
    // каждая врёт. KTX2 на маленькой модели раздувает файл в одиннадцать раз и вчетверо
    // сокращает видеопамять: «+1064 %» без второй половины читается как катастрофа,
    // хотя это выигрыш по метрике, которая и определяет, потянет ли модель телефон.
    //
    // У остальных строк процент был бы шумом: треугольников оптимизация не меняет
    // по построению, а «материалов на 33 % меньше» — число без смысла, важно само
    // изменение, и его видно по цвету.
    const PCT_ROWS = new Set(['FILE', 'VRAM']);

    const rows = [
      ['FILE', before.fileBytes, after.fileBytes, fmtBytes],
      ['TRIS', before.triangles, after.triangles, fmtInt],
    ];
    if (before.vertices != null || after.vertices != null) {
      rows.push(['VERT', before.vertices, after.vertices, fmtInt]);
    }
    rows.push(
      ['DRAWS', before.drawCalls, after.drawCalls, fmtInt],
      ['MATS', before.materials, after.materials, fmtInt],
      ['TEX', before.textures, after.textures, fmtInt],
      ['VRAM', before.gpuBytes, after.gpuBytes, fmtBytes],
    );

    // Левая колонка — всегда нейтральная. Оценивать исходную модель по бюджету платформы
    // пробовали: почти всё уходило в жёлтый (пороги Khronos рассчитаны на витрину товара,
    // а не на любую модель), и цвет переставал что-либо значить. Оценка по бюджету осталась
    // там, где к ней есть пояснение и ссылка на источник, — в разделе «Бюджет платформы».
    for (const [label, beforeVal, afterVal, fmt] of rows) {
      statsBefore.appendChild(hudLine(label, fmt(beforeVal), null));
      let cls = null;
      if (beforeVal != null && afterVal != null && afterVal !== beforeVal) {
        cls = afterVal < beforeVal ? 'better' : 'worse';
      }
      const row = hudLine(label, fmt(afterVal), cls);
      if (PCT_ROWS.has(label) && beforeVal > 0 && afterVal != null && afterVal !== beforeVal) {
        const pct = document.createElement('span');
        pct.className = 'hud-pct ' + (afterVal < beforeVal ? 'better' : 'worse');
        pct.textContent = pctText(beforeVal, afterVal);
        row.appendChild(pct);
      }
      statsAfter.appendChild(row);
    }
    // Общего вердикта над строками здесь нет и не будет. Он стоял сверху и считался по
    // ОДНОМУ размеру файла: KTX2 даёт файл +26 % при меньших видеопамяти, вершинах,
    // отрисовках, материалах и текстурах — и жёлтая плашка сверху объявляла это
    // ухудшением, перекрывая пять зелёных строк под собой. Одним числом такой размен не
    // выражается; пусть человек читает строки, они не врут.
  }

  function hudLine(label, value, valClass) {
    const row = document.createElement('div');
    row.className = 'hud-line';
    const k = document.createElement('span');
    k.className = 'hud-key';
    k.textContent = `${label}:`;
    const v = document.createElement('span');
    v.className = 'hud-val' + (valClass ? ` ${valClass}` : '');
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }

  function renderSummary(explain) {
    const hasSummary = explain && (explain.summary || (explain.highlights && explain.highlights.length));
    summarySection.classList.toggle('hidden', !hasSummary);
    if (!hasSummary) return;

    summaryText.textContent = explain.summary || '';
    highlightsList.innerHTML = '';
    for (const h of explain.highlights || []) {
      const li = document.createElement('li');
      li.textContent = h;
      highlightsList.appendChild(li);
    }
  }

  function renderIssues(findings, applied) {
    // Необратимые изменения — одной карточкой внутри анализа, а не списком,
    // закреплённым над кнопкой. Закреплённым остаётся только предупреждение
    // «сохраните исходник»: оно короткое, всегда одинаковое и относится к файлу
    // целиком. Перечень же растёт с числом правок и на большой модели закрывал
    // собой окно просмотра — то самое, ради которого пользователь и пришёл.
    const lossy = (applied || []).filter((a) => a.reversible === false && a.dataLoss === 'significant');
    const lossyLines = condense(lossy);

    const hasAny = (findings && findings.length) || lossyLines.length;
    analysisSection.classList.toggle('hidden', !hasAny);
    if (!hasAny) return;

    // Счётчик в заголовке — через каталог: собирался в коде по-английски и смену
    // языка не переживал.
    const notableCount = (findings || []).filter((f) => f.severity === 'error' || f.severity === 'warn').length;
    if (notableCount) setText(issuesCount, 'issues.countImportant', { n: notableCount });
    else setText(issuesCount, 'issues.countPlain', { n: (findings || []).length });

    issuesList.innerHTML = '';

    if (lossyLines.length) {
      const card = document.createElement('div');
      card.className = 'issue-card sev-error issue-card--lossy';
      const title = document.createElement('p');
      title.className = 'issue-title';
      title.textContent = t('issues.irreversible', { n: lossyLines.length });
      const hint = document.createElement('p');
      hint.className = 'issue-text';
      hint.textContent = t('issues.irreversible.hint');
      const ul = document.createElement('ul');
      ul.className = 'issue-sublist';
      for (const text of lossyLines) {
        const li = document.createElement('li');
        li.textContent = text;
        ul.appendChild(li);
      }
      card.appendChild(title);
      card.appendChild(hint);
      card.appendChild(ul);
      issuesList.appendChild(card);
    }

    // Находки схлопываем так же, как применённые правила: пять мешей с вершинной
    // раскраской давали пять одинаковых карточек, между которыми терялись остальные.
    // Группируем внутри пары «категория + важность», чтобы не смешать разное.
    const buckets = new Map();
    for (const f of findings || []) {
      const key = `${f.category}|${f.severity}`;
      if (!buckets.has(key)) buckets.set(key, { category: f.category, severity: f.severity, items: [] });
      // i18n переносим вместе с текстом: по нему condense() узнаёт одинаковые находки
      // (см. там же). Без него в схлопывание уходили голые строки, и восемь записей
      // об одном и том же оставались восемью строками.
      buckets.get(key).items.push({ ruleId: f.ruleId, text: f.text, i18n: f.i18n });
    }

    // Одна карточка на всю пару «категория + важность», а внутри список строк.
    //
    // Раньше карточка заводилась на КАЖДУЮ строку, и заголовок категории повторялся
    // столько же раз: восемь неиспользуемых атрибутов давали восемь окошек с одним и
    // тем же словом «Сцена» над каждым. Панель разрасталась на пустом месте, а найти
    // в ней что-то становилось тем труднее, чем больше находок, — то есть ровно тогда,
    // когда это нужнее всего. Категория пишется один раз, находки идут под ней.
    for (const b of buckets.values()) {
      const lines = condense(b.items);
      if (!lines.length) continue;
      const sev = b.severity === 'error' ? 'sev-error' : b.severity === 'warn' ? 'sev-warn' : 'sev-info';

      const card = document.createElement('div');
      card.className = `issue-card ${sev}`;

      const title = document.createElement('p');
      title.className = 'issue-title';
      title.textContent = CATEGORY_KEYS[b.category] ? t(CATEGORY_KEYS[b.category]) : (b.category || t('cat.other'));
      card.appendChild(title);

      const ul = document.createElement('ul');
      ul.className = 'issue-sublist';
      for (const line of lines) {
        const li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      }
      card.appendChild(ul);
      issuesList.appendChild(card);
    }
  }

  function renderBudgets(budgetChecks) {
    const has = budgetChecks && budgetChecks.length;
    budgetsSection.classList.toggle('hidden', !has);
    if (!has) return;

    budgetsList.innerHTML = '';
    // Четыре состояния строки. 'none' — порога нет: показываем измеренное и молчим.
    // Значок тоже молчит: галочка означала бы «проверено и хорошо», а мы не проверяли.
    const ICON = { ok: '✓', warn: '⚠', over: '✕', none: '·' };
    for (const b of budgetChecks) {
      const row = document.createElement('div');
      row.className = `budget-row ${b.level || 'none'}`;

      const head = document.createElement('div');
      head.className = 'budget-row-head';
      const name = document.createElement('span');
      name.className = 'budget-name';
      name.textContent = b.name;
      const icon = document.createElement('span');
      icon.className = 'budget-icon';
      icon.textContent = ICON[b.level] || ICON.none;
      head.appendChild(name);
      head.appendChild(icon);

      const values = document.createElement('div');
      values.className = 'budget-values';
      const thresholds = [b.warnText, b.limitText].filter(Boolean).join(' · ');
      values.textContent = thresholds ? `${b.actualText} — ${thresholds}` : b.actualText;

      row.appendChild(head);
      row.appendChild(values);

      if (b.advice) {
        const advice = document.createElement('p');
        advice.className = 'budget-advice';
        advice.textContent = b.advice;
        row.appendChild(advice);
      }

      // Ссылка на документ, из которого взят порог. Число без проверяемого источника
      // пользователь принимает на веру — пусть у него будет способ не принимать.
      if (b.source) {
        const src = document.createElement('a');
        src.className = 'budget-source';
        src.href = b.source;
        src.target = '_blank';
        src.rel = 'noopener noreferrer';
        src.textContent = t('budget.source');
        row.appendChild(src);
      } else if (b.by === 'project') {
        // Наш собственный порог. Показываем как есть, без ссылки: ссылаться не на что,
        // и делать вид, что это требование платформы, нельзя.
        const own = document.createElement('span');
        own.className = 'budget-source budget-source--own';
        own.textContent = t('budget.ourChoice');
        row.appendChild(own);
      }

      budgetsList.appendChild(row);
    }
  }

  function renderWarnings(warnings) {
    const has = warnings && warnings.length;
    warningsSection.classList.toggle('hidden', !has);
    if (!has) return;
    warningsList.innerHTML = '';
    for (const w of warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      warningsList.appendChild(li);
    }
  }

  // ---------------------------------------------------------------
  // Схлопывание повторов
  //
  // Правила отчитываются по одному объекту: пять мешей потеряли вершинные цвета —
  // пять строк, тринадцать текстур перекодированы — тринадцать строк. По отдельности
  // каждая верна, вместе они превращают панель в простыню, где ничего не найти.
  //
  // Схлопываем ЗДЕСЬ, а не в правилах: правило не знает, сколько таких же строк
  // напишут соседи, и не должно знать. Разное между строками — почти всегда имя
  // в кавычках, поэтому группируем по тексту с вырезанными кавычками, а имена
  // собираем в список.
  // ---------------------------------------------------------------

  const NAME_SLOT = ' ';
  const MAX_NAMES = 4; // дальше список сам становится простынёй

  function condense(items) {
    const groups = new Map();
    for (const it of items) {
      const text = String(it.text || '');
      const names = [];
      const template = text.replace(/"([^"]*)"/g, (_, n) => { names.push(n); return NAME_SLOT; });
      // Ключ группировки — messageId, если запись несёт рецепт i18n. Он точен и не
      // зависит от языка: две записи с одним messageId — одна и та же находка про разные
      // объекты, что бы ни стояло в подстановках. Шаблон по кавычкам остаётся запасным
      // путём для записей без рецепта; он ловил различия только ВНУТРИ кавычек, поэтому
      // восемь строк «атрибут TEXCOORD_N не используется» (имя без кавычек) так и
      // оставались восемью строками.
      const messageId = it.i18n && it.i18n.text && it.i18n.text.messageId;
      const key = (it.ruleId || '') + '|' + (messageId || template);
      if (!groups.has(key)) groups.set(key, { template, names: [], count: 0 });
      const g = groups.get(key);
      g.count += 1;
      for (const n of names) if (n && n !== '—' && !g.names.includes(n)) g.names.push(n);
    }

    const out = [];
    for (const g of groups.values()) {
      if (g.count === 1) {
        // Одна строка — возвращаем как есть, вместе с именами на своих местах.
        let i = 0;
        out.push(g.template.replace(new RegExp(NAME_SLOT, 'g'), () => `"${g.names[i++] ?? '—'}"`));
        continue;
      }
      // Количество — суффиксом: «…не используется ни одним материалом ×8». Стояло
      // префиксом («8× …»), но строка при этом начиналась с числа, и глаз, идущий по
      // левому краю списка, читал сначала счётчики и только потом суть. Суть важнее.
      //
      // Имена — на месте того самого имени. Складывать количество внутрь скобок
      // пробовали: получалось «mesh 5: Fringe», похожее на номер меша, а не на их число.
      const shown = g.names.slice(0, MAX_NAMES).join(', ');
      const rest = g.names.length - MAX_NAMES;
      // «и ещё N» — через каталог: строка склеивалась в коде по-английски и от смены
      // языка не менялась.
      const list = g.names.length ? (rest > 0 ? t('issues.andMore', { shown, rest }) : shown) : '—';
      let first = true;
      const body = g.template.replace(new RegExp(NAME_SLOT, 'g'), () => {
        if (first) { first = false; return list; }
        return '—';
      });
      out.push(`${body} ×${g.count}`);
    }
    return out;
  }

  function renderAppliedSkipped(applied, skipped) {
    const appliedLines = condense(applied || []);
    appliedSection.classList.toggle('hidden', !appliedLines.length);
    appliedList.innerHTML = '';
    if (appliedLines.length) {
      appliedCount.textContent = `(${appliedLines.length})`;
      for (const text of appliedLines) {
        const li = document.createElement('li');
        li.textContent = text;
        appliedList.appendChild(li);
      }
    }

    // Показываем только те пропуски, которые что-то значат: отказ по безопасности
    // и превышение уровня риска. «Фича не включена» — выбор пользователя, а
    // «делать было нечего» — нормальный исход; раздел из таких строк сообщал
    // читателю о несуществующем и занимал место наравне с настоящими находками.
    const meaningful = (skipped || []).filter((s) => s && (s.kind === 'unsafe' || s.kind === 'policy'));
    const skippedLines = condense(meaningful.map((s) => ({
      ruleId: s.ruleId,
      text: (s.reason && s.reason !== s.text) ? `${s.text} — ${s.reason}` : s.text,
    })));
    skippedSection.classList.toggle('hidden', !skippedLines.length);
    skippedList.innerHTML = '';
    if (skippedLines.length) {
      skippedCount.textContent = `(${skippedLines.length})`;
      for (const text of skippedLines) {
        const li = document.createElement('li');
        li.textContent = text;
        li.classList.add('skip-reason');
        skippedList.appendChild(li);
      }
    }
  }

  function renderValidation(validation) {
    const has = validation && validation.length;
    validationSection.classList.toggle('hidden', !has);
    if (!has) return;

    // Вердикт выносим в заголовок: раздел свёрнут, и без него человеку пришлось бы
    // раскрывать список, чтобы узнать ответ на главный вопрос — цела ли модель.
    const failed = validation.filter((v) => v.level === 'fail').length;
    if (validationCount) {
      // Через setText, а не textContent: иначе вердикт застревал на языке сборки —
      // строка собиралась в коде по-английски и смену языка не переживала.
      if (failed) setText(validationCount, 'insp.validation.failed', { n: failed });
      else setText(validationCount, 'insp.validation.allPassed', { n: validation.length });
      validationCount.className = failed ? 'check-verdict is-fail' : 'check-verdict is-ok';
    }

    validationList.innerHTML = '';
    for (const v of validation) {
      const li = document.createElement('li');
      li.className = `val-${v.level}`;
      li.textContent = v.text;
      validationList.appendChild(li);
    }
  }

  // ---------------------------------------------------------------
  // Окна (ошибки/диалоги): закрытие по × и перетаскивание за заголовок.
  // Переиспользуемый паттерн — навесить setupWindow на любой .window (класс).
  // ---------------------------------------------------------------

  function setupWindow(el) {
    if (!el) return;
    const closeBtn = el.querySelector('.window-close');
    if (closeBtn) closeBtn.addEventListener('click', () => el.classList.add('hidden'));

    const bar = el.querySelector('.window-titlebar');
    if (!bar) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.window-close, .window-action')) return;
      dragging = true;
      bar.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      const parent = el.offsetParent ? el.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
      baseLeft = rect.left - parent.left;
      baseTop = rect.top - parent.top;
      // перейти с центрирующего transform на явные left/top в пикселях
      el.style.left = `${baseLeft}px`;
      el.style.top = `${baseTop}px`;
      el.style.transform = 'none';
      startX = e.clientX;
      startY = e.clientY;
      e.preventDefault();
    });

    bar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      el.style.left = `${baseLeft + e.clientX - startX}px`;
      el.style.top = `${baseTop + e.clientY - startY}px`;
    });

    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      try { bar.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
  }

  function closeAllWindows(except) {
    for (const w of document.querySelectorAll('.window')) {
      if (w !== except) w.classList.add('hidden');
    }
  }

  // Показать окно, вернув его в центр. Одновременно открыто не больше одного окна.
  function showWindow(el) {
    closeAllWindows(el);
    el.style.left = '';
    el.style.top = '';
    el.style.transform = '';
    el.classList.remove('hidden');
  }

  // Любое окно (Metadata/Validation/Logs/ошибка) закрывается кликом мыши ВНЕ окна.
  // Клик внутри окна (в т.ч. перетаскивание за заголовок) и клик по кнопке-триггеру
  // окно не закрывают.
  document.addEventListener('pointerdown', (e) => {
    if (!document.querySelector('.window:not(.hidden)')) return;
    if (e.target.closest('.window')) return;
    if (e.target.closest('[data-window-trigger]')) return;
    closeAllWindows(null);
  });

  // ---------------------------------------------------------------
  // Логи (внизу сайдбара): ошибки и заметные события. Клик по панели
  // разворачивает отдельное окно логов.
  // ---------------------------------------------------------------

  // Одна сборка добавляет десятки debug-строк (фазы + правила) — держим запас, чтобы
  // ход предыдущих сборок не вытеснялся из окна логов сразу же.
  const LOG_LIMIT = 500;
  const logs = [];

  function logMessage(level, text) {
    if (!text) return;
    logs.push({ time: new Date(), level, text: String(text) });
    if (logs.length > LOG_LIMIT) logs.shift();
    updateLogsBar();
    if (!logsWindow.classList.contains('hidden')) renderLogsWindow();
  }

  function updateLogsBar() {
    logsCount.textContent = String(logs.length);
    logsBar.classList.toggle('has-error', logs.some((l) => l.level === 'error'));
    const last = logs[logs.length - 1];
    logsLast.textContent = last ? last.text : t('logs.none');
    logsLast.title = last ? last.text : '';
  }

  function renderLogsWindow() {
    logsBody.innerHTML = '';
    if (!logs.length) {
      const p = document.createElement('p');
      p.className = 'meta-empty';
      p.textContent = t('logs.empty');
      logsBody.appendChild(p);
      return;
    }
    for (const entry of [...logs].reverse()) { // новые сверху
      const row = document.createElement('div');
      row.className = 'log-row log-' + entry.level;
      const t = document.createElement('span');
      t.className = 'log-time';
      t.textContent = entry.time.toTimeString().slice(0, 8);
      const lv = document.createElement('span');
      lv.className = 'log-level';
      lv.textContent = entry.level.toUpperCase();
      const msg = document.createElement('span');
      msg.className = 'log-text';
      msg.textContent = entry.text;
      row.appendChild(t);
      row.appendChild(lv);
      row.appendChild(msg);
      logsBody.appendChild(row);
    }
  }

  logsBar.addEventListener('click', () => {
    renderLogsWindow();
    showWindow(logsWindow);
  });

  // Одна кнопка Download Result → окно экспорта (формат + имя). Новые форматы = новые
  // пункты радио, поведение кнопки и обработчик Save не меняются.
  downloadBtn.addEventListener('click', () => {
    if (!resultDownloadUrl) return;
    exportName.value = resultExportBase;
    showWindow(exportWindow);
    exportName.focus();
    exportName.select();
  });

  // Каталог форматов экспорта: формат → { расширение, как построить URL из resultDownloadUrl }.
  // Добавить экспортёр = добавить строку сюда и пункт радио в index.html; больше ничего.
  const EXPORT_FORMATS = {
    glb: { ext: '.glb', url: (base) => base },
    json: { ext: '.gltf', url: (base) => base.replace('/api/download', '/api/export-json') },
  };

  function currentExportFormat() {
    const r = exportWindow.querySelector('input[name="export-format"]:checked');
    return (r && r.value) || 'glb';
  }

  exportSave.addEventListener('click', () => {
    if (!resultDownloadUrl) return;
    const fmt = EXPORT_FORMATS[currentExportFormat()] || EXPORT_FORMATS.glb;
    const base = (exportName.value || resultExportBase).trim() || 'model';
    const fileName = base.replace(/\.[^.]+$/, '') + fmt.ext;
    // ?name= → сервер ставит его в Content-Disposition (см. chosenExportName); плюс атрибут
    // download как подстраховка. Место сохранения в браузере не выбирается — папка загрузок.
    const url = fmt.url(resultDownloadUrl) + '&name=' + encodeURIComponent(fileName);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    exportWindow.classList.add('hidden');
    logMessage('info', t('log.exported', {
      name: fileName,
      format: fmt === EXPORT_FORMATS.json ? 'glTF JSON' : 'GLB',
    }));
  });

  logsClear.addEventListener('click', () => {
    logs.length = 0;
    updateLogsBar();
    renderLogsWindow();
  });

  updateLogsBar();

  // Легенда ⚠ — строится тем же decoderWarning(), что и значки в списке опций, чтобы
  // значение символа было визуально узнаваемо одним и тем же элементом. Пересобирается
  // целиком: текст в ней переводится, дописать перевод к готовому узлу нельзя.
  function renderDecoderLegend() {
    if (!decoderLegend) return;
    decoderLegend.innerHTML = '';
    decoderLegend.appendChild(decoderWarning());
    decoderLegend.appendChild(document.createTextNode(' ' + t(DECODER_NOTE_KEY) + '.'));
  }

  renderDecoderLegend();

  setupWindow(failBanner);
  setupWindow(metadataWindow);
  setupWindow(validationWindow);
  setupWindow(logsWindow);
  setupWindow(exportWindow);

  btnMetadata.addEventListener('click', () => {
    renderMetadataWindow();
    showWindow(metadataWindow);
  });
  btnValidation.addEventListener('click', () => {
    renderValidationWindow();
    showWindow(validationWindow);
  });

  // ---------------------------------------------------------------
  // Окна Metadata / Validation (данные из /api/inspect: fns.inspect + gltf-validator)
  // ---------------------------------------------------------------

  const severityName = (code) => t(`sev.${code}`);

  function fmtCell(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'number') return Number.isInteger(v) ? fmtInt(v) : v.toFixed(2);
    if (typeof v === 'boolean') return v ? '✓' : '';
    return String(v);
  }

  // Таблица из массива объектов: колонки = ключи (с колонкой ID = индекс).
  function buildTable(rows, sizeKeys = []) {
    const table = document.createElement('table');
    table.className = 'meta-table';
    if (!rows.length) return table;
    const keys = Object.keys(rows[0]);
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const h of ['id', ...keys]) {
      const th = document.createElement('th');
      // Заголовки колонок берутся из каталога по ключу col.<имя поля>. Метаданные приносят
      // произвольные поля (их называет gltf-transform), для них перевода нет и не будет —
      // такие остаются как есть, в верхнем регистре.
      const label = t(`col.${h}`);
      th.textContent = label === `col.${h}` ? h.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase() : label;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      const idTd = document.createElement('td');
      idTd.textContent = i;
      tr.appendChild(idTd);
      for (const k of keys) {
        const td = document.createElement('td');
        td.textContent = sizeKeys.includes(k) && typeof row[k] === 'number' ? fmtBytes(row[k]) : fmtCell(row[k]);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function metaSection(title, rows, sizeKeys) {
    if (!rows || !rows.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'meta-block';
    const h = document.createElement('div');
    h.className = 'meta-block-title';
    h.textContent = title;
    wrap.appendChild(h);
    const scroll = document.createElement('div');
    scroll.className = 'meta-table-scroll';
    scroll.appendChild(buildTable(rows, sizeKeys));
    wrap.appendChild(scroll);
    return wrap;
  }

  // Оба окна инспекции делятся пополам: слева исходная модель, справа собранная. Формат
  // данных у обеих сторон один (inspectFile), поэтому столбец рисуется одной функцией.
  function splitPanes(buildPane) {
    const wrap = document.createElement('div');
    wrap.className = 'window-split';
    wrap.appendChild(inspectColumn(t('inspect.original'), modelInspect, buildPane, t('inspect.noModel')));
    wrap.appendChild(inspectColumn(t('inspect.optimized'), resultInspect, buildPane,
      t('inspect.noResult')));
    return wrap;
  }

  function inspectColumn(title, data, buildPane, emptyText) {
    const col = document.createElement('div');
    col.className = 'split-col';
    const h = document.createElement('div');
    h.className = 'split-col-title';
    h.textContent = title;
    col.appendChild(h);
    if (!data) {
      const p = document.createElement('p');
      p.className = 'meta-empty';
      p.textContent = emptyText;
      col.appendChild(p);
      return col;
    }
    buildPane(col, data);
    return col;
  }

  function buildMetadataPane(col, data) {
    const { asset = {}, extensions: exts = [], metadata = {} } = data;

    const head = document.createElement('div');
    head.className = 'meta-head';
    const pairs = [
      ['Version', asset.version || '—'],
      ['Generator', asset.generator || '—'],
      ['Extensions', exts.length ? exts.join(', ') : 'None'],
    ];
    for (const [k, v] of pairs) {
      const row = document.createElement('div');
      row.className = 'meta-kv';
      row.innerHTML = `<span class="meta-k">${k}</span><span class="meta-v"></span>`;
      row.querySelector('.meta-v').textContent = v;
      head.appendChild(row);
    }
    col.appendChild(head);

    const sections = [
      metaSection('Scenes', metadata.scenes && metadata.scenes.properties),
      metaSection('Meshes', metadata.meshes && metadata.meshes.properties, ['size']),
      metaSection('Materials', metadata.materials && metadata.materials.properties),
      metaSection('Textures', metadata.textures && metadata.textures.properties, ['size', 'gpuSize']),
      metaSection('Animations', metadata.animations && metadata.animations.properties, ['size']),
    ].filter(Boolean);
    for (const s of sections) col.appendChild(s);
    if (!sections.length) {
      const p = document.createElement('p');
      p.className = 'meta-empty';
      p.textContent = t('inspect.noScene');
      col.appendChild(p);
    }
  }

  // Аддон схлопывает сообщения валидатора по виду нарушения и приносит count. Показываем
  // число повторений: «нарушение в 79 398 местах» и «нарушение в одном» — разные новости,
  // а раньше это были 79 398 одинаковых строк, по которым не пролистать.
  // Перевод сообщений gltf-validator (Khronos) на стороне клиента.
  // Ключ — код ошибки (m.code), значение — ключ в каталоге ui/locales/.
  // Если перевода нет — возвращается оригинальное английское сообщение.
  function translateValidatorMessage(code, originalMessage) {
    const key = 'validator.' + code;
    const translated = t(key);
    // t() возвращает ключ как есть, если перевода нет — значит код неизвестен.
    return translated === key ? originalMessage : translated;
  }

  function issuesTable(issues) {
    const rows = issues.map((m) => ({
      code: m.code,
      count: fmtInt(m.count || 1),
      message: translateValidatorMessage(m.code, m.message),
      severity: severityName(m.severity),
      // указатель у схлопнутой группы — пример, а не полный адрес; многоточие об этом говорит
      pointer: (m.pointer || '') + ((m.count || 1) > 1 ? ' …' : ''),
    }));
    const scroll = document.createElement('div');
    scroll.className = 'meta-table-scroll';
    const table = buildTable(rows);
    const trs = table.querySelectorAll('tbody tr');
    issues.forEach((m, i) => { if (trs[i]) trs[i].classList.add(`sev-${m.severity}`); });
    scroll.appendChild(table);
    return scroll;
  }

  // Сообщения, которые валидатор выдал только потому, что не читает расширение (аддон
  // помечает их `explainedBy`), пользователю не показываются вовсе.
  //
  // Раньше они висели свёрнутой группой с подписью «это не дефекты». Не помогало: человек
  // видел число «26 замечаний» и открывал таблицу, где в колонке важности стояло
  // «Предупреждение». Объяснять пользователю, чего именно не умеет сторонний валидатор, —
  // не его работа и не его забота: он спрашивает «цела ли модель», а не «что не понял
  // валидатор». Данные никуда не делись — они в ответе /api/inspect и в журнале (debug).
  //
  // Настоящая цель — научиться проверять сжатые расширения самим, тогда этих сообщений
  // не будет вовсе.
  // Слепые пятна валидатора — в журнал уровнем debug, не в окно проверки. Если модель
  // однажды окажется сломанной, а мы спишем это на «валидатор не читает расширение»,
  // след должен остаться где-то, кроме нашей памяти.
  function logBlindSpots(validation) {
    const explained = (validation || []).filter((m) => m.explainedBy);
    if (!explained.length) return;
    const names = [...new Set(explained.map((m) => m.explainedBy))].sort().join(', ');
    logMessage('debug', t('log.blindSpots', { n: explained.length, names }));
  }

  function buildValidationPane(col, data) {
    const issues = (data.validation || []).filter((m) => !m.explainedBy);

    if (issues.length) {
      col.appendChild(issuesTable(issues));
      return;
    }
    const p = document.createElement('p');
    p.className = 'meta-empty';
    p.textContent = t('inspect.clean');
    col.appendChild(p);
  }

  function renderMetadataWindow() {
    metadataBody.innerHTML = '';
    metadataBody.appendChild(splitPanes(buildMetadataPane));
  }

  function renderValidationWindow() {
    validationBody.innerHTML = '';
    validationBody.appendChild(splitPanes(buildValidationPane));
  }

  // ---------------------------------------------------------------
  // Перетаскиваемый разделитель между вьюпортами (как в референс-макете)
  // ---------------------------------------------------------------

  (function setupSplitter() {
    if (!viewportSplitter || !viewportSplit || !originalPane) return;
    let dragging = false;

    viewportSplitter.addEventListener('pointerdown', (e) => {
      dragging = true;
      viewportSplitter.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      e.preventDefault();
    });

    viewportSplitter.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = viewportSplit.getBoundingClientRect();
      let pct = ((e.clientX - rect.left) / rect.width) * 100;
      pct = Math.max(15, Math.min(85, pct));
      originalPane.style.flex = `0 0 ${pct}%`;
    });

    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      try { viewportSplitter.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      document.body.classList.remove('resizing');
    };
    viewportSplitter.addEventListener('pointerup', stop);
    viewportSplitter.addEventListener('pointercancel', stop);
  })();

  // ---------------------------------------------------------------
  // Раскрывающиеся разделы: открыт всегда ровно один
  //
  // Разделы длинные, и три открытых сразу выталкивают всё остальное за нижний
  // край панели. Открытие любого закрывает прочие; смена настроек тоже закрывает —
  // содержимое относится к прошлой сборке и после правки флажков устаревает.
  // ---------------------------------------------------------------

  // Только разделы ОТЧЁТА. Раскрывашка «Mode: UASTC» в панели опций — настройка,
  // а не отчёт: закрывать её, когда человек открыл «Что сделано», нельзя, он может
  // быть в середине настройки.
  const inspectorDetails = () => Array.from(document.querySelectorAll('details.report-accordion'));

  function closeOtherDetails(except) {
    for (const d of inspectorDetails()) if (d !== except) d.open = false;
  }

  function closeAllDetails() {
    closeOtherDetails(null);
  }

  for (const d of inspectorDetails()) {
    d.addEventListener('toggle', () => { if (d.open) closeOtherDetails(d); });
  }

  // ---------------------------------------------------------------
  // Мини-панель управления вьюпортом
  // ---------------------------------------------------------------

  if (resetViewBtn) {
    resetViewBtn.addEventListener('click', () => {
      if (window.OptiViewer) window.OptiViewer.resetView();
    });
  }

  if (linkToggleBtn) {
    linkToggleBtn.addEventListener('click', () => {
      const on = !linkToggleBtn.classList.contains('is-on');
      linkToggleBtn.classList.toggle('is-on', on);
      linkToggleBtn.setAttribute('aria-pressed', String(on));
      if (window.OptiViewer) window.OptiViewer.setLinked(on);
    });
  }

  // ---------------------------------------------------------------
  // Управление анимацией
  //
  // Панель появляется только у моделей с клипами. Оба вьюпорта идут по одному
  // времени (см. _advanceAnimation в ui/viewer/index.js), поэтому и ползунок, и
  // выбор клипа — общие: раздельные развели бы позы и сделали сравнение
  // «до и после» бессмысленным.
  //
  // Ползунок целочисленный 0…1000 — это доля клипа, а не секунды: длительность
  // у каждого клипа своя, а range с дробным шагом ведёт себя по-разному в разных
  // браузерах. Перевод в секунды — в одном месте, ниже.
  // ---------------------------------------------------------------

  const SEEK_STEPS = 1000;
  let animPollId = null;
  let seekDragging = false;

  function fmtTime(sec) {
    return `${(Number(sec) || 0).toFixed(1)}s`;
  }

  /** Показать/скрыть панель и наполнить список клипов под текущую модель. */
  function refreshAnimUI() {
    if (!animControls || !window.OptiViewer || !window.OptiViewer.getAnimation) return;
    const info = window.OptiViewer.getAnimation();
    const has = info.count > 0;
    animControls.classList.toggle('hidden', !has);
    if (!has) return;

    // Список пересобираем, только если модель сменилась — иначе выпадающий
    // список схлопывался бы под курсором на каждом опросе.
    const signature = info.names.join(' ');
    if (animClipSel && animClipSel.dataset.signature !== signature) {
      animClipSel.dataset.signature = signature;
      animClipSel.innerHTML = '';
      info.names.forEach((name, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        // Имя клипа приходит из файла как есть. Пустое — значит автор его не задал,
        // и подпись придумываем здесь, по ключу: движок просмотра языка не знает.
        if (name) opt.textContent = name;
        else setText(opt, 'viewer.clip.unnamed', { n: i + 1 });
        animClipSel.appendChild(opt);
      });
      // Один клип — выбирать не из чего.
      animClipSel.classList.toggle('hidden', info.count < 2);
    }
    if (animClipSel && Number(animClipSel.value) !== info.index) {
      animClipSel.value = String(info.index);
    }
  }

  /** Раз в кадр подтягивать положение ползунка и время под играющую анимацию. */
  function syncAnimProgress() {
    if (!window.OptiViewer || !window.OptiViewer.getAnimation) return;
    const info = window.OptiViewer.getAnimation();
    if (!info.count) return;
    const dur = info.duration || 0;
    const t = dur > 0 ? (info.time % dur) : 0;
    if (animTimeEl) animTimeEl.textContent = fmtTime(t);
    // Пока пользователь тянет ползунок — не перебиваем его позицию.
    if (animSeek && !seekDragging && dur > 0) {
      animSeek.value = String(Math.round((t / dur) * SEEK_STEPS));
    }
  }

  // В цикле кадров — только бегущее время: оно и правда меняется каждый кадр.
  // Состав модели (есть ли клипы, какие) обновляется по уведомлению setOnLoaded,
  // а не опросом. Опрос здесь был ошибкой: в фоновой вкладке requestAnimationFrame
  // замораживается, и панель анимации не появлялась вовсе.
  function startAnimPolling() {
    if (animPollId != null) return;
    const tick = () => {
      syncAnimProgress();
      animPollId = requestAnimationFrame(tick);
    };
    animPollId = requestAnimationFrame(tick);
  }

  // Подпись кнопки воспроизведения зависит от состояния, а не от разметки: «Пауза»
  // при игре, «Пуск» на паузе. Отдельной функцией — чтобы смена языка перечитала её,
  // не трогая само состояние.
  function refreshAnimLabels() {
    if (!animPlayBtn) return;
    const playing = animPlayBtn.classList.contains('is-on');
    window.I18n.setTitle(animPlayBtn, playing ? 'vp.pause' : 'vp.play');
    window.I18n.setAria(animPlayBtn, playing ? 'vp.pause' : 'vp.play');
  }

  if (animPlayBtn) {
    animPlayBtn.addEventListener('click', () => {
      const playing = !animPlayBtn.classList.contains('is-on');
      animPlayBtn.classList.toggle('is-on', playing);
      animPlayBtn.setAttribute('aria-pressed', String(playing));
      animPlayBtn.textContent = playing ? '⏸' : '▶';
      refreshAnimLabels();
      if (window.OptiViewer) window.OptiViewer.setAnimationPlaying(playing);
    });
  }

  if (animClipSel) {
    animClipSel.addEventListener('change', () => {
      if (window.OptiViewer) window.OptiViewer.selectAnimationClip(Number(animClipSel.value) || 0);
    });
  }

  if (animSeek) {
    const applySeek = () => {
      if (!window.OptiViewer || !window.OptiViewer.getAnimation) return;
      const dur = window.OptiViewer.getAnimation().duration || 0;
      if (dur > 0) window.OptiViewer.seekAnimation((Number(animSeek.value) / SEEK_STEPS) * dur);
    };
    animSeek.addEventListener('pointerdown', () => { seekDragging = true; });
    animSeek.addEventListener('pointerup', () => { seekDragging = false; });
    animSeek.addEventListener('input', applySeek);
  }

  // Объявляем ДО того, как модуль вьюера выполнится: app.js — обычный скрипт и
  // отрабатывает раньше type="module". Подписаться через window.OptiViewer здесь
  // ещё нельзя — его не существует.
  window.onOptiViewerModelLoaded = refreshAnimUI;
  refreshAnimUI(); // стартовое состояние: моделей нет — панели нет
  startAnimPolling();

  // ---------------------------------------------------------------
  // Экспозиция
  //
  // Ползунок целочисленный 10…300 — это сотые доли экспозиции (100 = 1.0).
  // Так же, как с перемоткой: range с дробным шагом ведёт себя по-разному
  // в разных браузерах, поэтому дроби держим на нашей стороне.
  // ---------------------------------------------------------------

  if (exposureSlider) {
    const applyExposure = () => {
      const v = Number(exposureSlider.value) / 100;
      if (exposureValue) exposureValue.textContent = v.toFixed(1);
      if (window.OptiViewer && window.OptiViewer.setExposure) window.OptiViewer.setExposure(v);
    };
    exposureSlider.addEventListener('input', applyExposure);
    // Двойной клик по ползунку — вернуть 1.0. Прицелиться в единицу мышью трудно,
    // а вернуться к «как было» нужно постоянно: это точка отсчёта при сравнении.
    exposureSlider.addEventListener('dblclick', () => {
      exposureSlider.value = '100';
      applyExposure();
    });
  }

  // ---------------------------------------------------------------
  // Язык интерфейса
  //
  // Кнопки строятся по списку каталогов, а не зашиты: добавить язык = добавить файл
  // каталога и строку <script> в index.html, этот код не трогается.
  // ---------------------------------------------------------------

  function renderLangSwitch() {
    const box = $('lang-switch');
    if (!box) return;
    box.innerHTML = '';
    for (const code of window.I18n.languages()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-btn' + (code === window.I18n.lang ? ' is-on' : '');
      btn.textContent = code.toUpperCase();
      btn.title = window.I18n.t('lang.name');
      btn.setAttribute('aria-pressed', String(code === window.I18n.lang));
      btn.addEventListener('click', () => window.I18n.setLang(code));
      box.appendChild(btn);
    }
  }

  // Статику переводит сам i18n по атрибутам; всё, что нарисовано из JS, надо
  // перерисовать — оно осталось на прежнем языке.
  //
  // Смена языка — перерисовка, и только. Ни одна строка ниже не имеет права принять
  // решение за пользователя: флажки, выбранная платформа, значки, открытые окна, уже
  // собранный результат остаются как были. Модель не перезагружается и не пересобирается.
  window.I18n.onChange(async () => {
    renderLangSwitch();
    updateRunButtonState();
    updateLogsBar();
    renderDecoderLegend();
    refreshBusyLabels(); // язык могли переключить посреди долгой сборки
    refreshAnimLabels();
    renderModelList();
    if (!logsWindow.classList.contains('hidden')) renderLogsWindow();
    await reloadPlatformTitles();
    // Строго по порядку: панель пересобирается, и отчёт должен ложиться на готовую
    // панель. Иначе знак цены успевал нарисоваться до пересборки и исчезал вместе
    // со старой разметкой — гонка, которая проявлялась через раз.
    await relabelExtensions();
    await reexplainLastResult();
    if (!validationWindow.classList.contains('hidden')) renderValidationWindow();
    if (!metadataWindow.classList.contains('hidden')) renderMetadataWindow();
    updateInspectButtons();
    logMessage('debug', t('log.langChanged', { name: t('lang.name') }));
  });

  window.I18n.apply();
  renderLangSwitch();
  initBusyIndicators();
  initPerfMeter();
  initMenubar();

  loadPlatforms();
})();
