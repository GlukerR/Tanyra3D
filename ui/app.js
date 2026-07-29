// app.js — клиентская логика Tanyra3D (v0.1.0). Без сборки, без CDN.
// Формат данных задают Core Engine (§4b ARCHITECTURE.md) и AI Assistant (assistant.mjs) —
// этот файл только форматирует байты/проценты и рисует то, что вернул сервер.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

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
  const deltaBadge = $('delta-badge');

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
  const platformDescription = $('platform-description');

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
  const validationCount = $('validation-count');

  const statusDot = $('status-dot');
  const phaseStatus = $('phase-status');
  const versionLabel = $('version-label');

  let selectedFile = null;
  // Идентификатор загруженного исходника на сервере: пока он есть, повторная
  // оптимизация той же модели идёт без перезаливки файла (меняем только флажки).
  let currentSourceId = null;
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
  // Результат /api/inspect (metadata + validation) для ЛЕВОЙ колонки окон — исходная модель.
  let modelInspect = null;
  // То же самое для ПРАВОЙ колонки — собранная модель (/api/inspect-result после сборки).
  let resultInspect = null;
  // URL готового результата (GLB) и предлагаемое имя без расширения — для окна экспорта.
  // Формат (glb/json) и расширение выбираются в окне; экспортёры добавляются там же.
  let resultDownloadUrl = null;
  let resultExportBase = 'model';
  // Режим KTX2: 'uastc' (по умолчанию, безопасный/качественный) либо 'mixed' (ETC1S, макс. сжатие).
  let ktx2Mode = 'uastc';
  // Геометрия — взаимоисключающий выбор: 'none' | 'meshopt' | 'draco'.
  let geometryChoice = 'none';
  let platforms = [];
  let extensions = [];
  // Последний ВЫБОР пользователя по платформам: platformId → { geometryChoice, ktx2Mode,
  // checked:[...] }. Заполняется только явным действием пользователя (не дефолтами). Держит
  // настройки при загрузке новой модели и возврате на платформу. In-memory → перезагрузка
  // страницы сбрасывает всё к рекомендуемым дефолтам (так и задумано).
  const savedSelections = {};

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
    rememberSelection(); // запомнить выбор платформы — он переживёт новую модель/смену платформы
    // Раскрытые разделы описывают ПРОШЛУЮ сборку. Тронули флажок — они устарели,
    // и держать их открытыми значит показывать неверное как текущее.
    closeAllDetails();
    const feats = getSelectedFeatures();
    logMessage('debug', 'Options: ' + (feats.length ? feats.join(', ') : 'none'));
  }

  // Состояние кнопки запуска. Всё — opt-in: без выбранного флажка оптимизировать нечего,
  // кнопка не активна. С файлом и ≥1 флажком: до сборки — активна; после сборки — активна
  // только если настройки изменились (иначе пересборка дала бы тот же результат).
  function updateRunButtonState() {
    if (!selectedFile || getSelectedFeatures().length === 0) {
      runBtn.disabled = true;
      runBtn.title = !selectedFile ? '' : 'Select an optimization to build';
      return;
    }
    if (lastBuildSignature === null) { runBtn.disabled = false; runBtn.removeAttribute('title'); return; }
    const unchanged = currentSettingsSignature() === lastBuildSignature;
    runBtn.disabled = unchanged;
    if (unchanged) runBtn.title = 'Change a setting to rebuild';
    else runBtn.removeAttribute('title');
  }

  // ---------------------------------------------------------------
  // Форматирование (байты → человекочитаемый вид) — зона web-interface
  // ---------------------------------------------------------------

  function fmtBytes(bytes) {
    if (bytes == null) return '—';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fmtInt(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('en-US');
  }

  function pctText(before, after) {
    if (!before) return '';
    const p = Math.round(((after - before) / before) * 100);
    if (p === 0) return 'no change';
    return p < 0 ? `−${Math.abs(p)}%` : `+${p}%`;
  }

  const CATEGORY_LABELS = {
    geometry: 'Geometry',
    textures: 'Textures',
    materials: 'Materials',
    uv: 'UV layout',
    attributes: 'Attributes',
    scene: 'Scene',
    performance: 'Performance',
  };

  const VALIDATION_ICON = { pass: '✓', info: 'i', fail: '✕' };

  // ---------------------------------------------------------------
  // Инициализация: список платформ
  // ---------------------------------------------------------------

  async function loadPlatforms() {
    try {
      const res = await fetch('/api/platforms');
      const data = await res.json();
      platforms = data.platforms || [];
      versionLabel.textContent = data.engineVersion ? `core v${data.engineVersion}` : '';

      platformSelect.innerHTML = '';
      for (const p of platforms) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.title || p.id;
        platformSelect.appendChild(opt);
      }
      updatePlatformDescription();
      loadExtensions(platformSelect.value);
    } catch (e) {
      platformSelect.innerHTML = '<option value="web">Web</option>';
      platforms = [{ id: 'web', title: 'Web', description: '' }];
    }
  }

  function updatePlatformDescription() {
    const p = platforms.find((x) => x.id === platformSelect.value);
    platformDescription.textContent = p ? p.description || '' : '';
  }

  platformSelect.addEventListener('change', async () => {
    updatePlatformDescription();
    await loadExtensions(platformSelect.value);
    updateRunButtonState();
    logMessage('info', 'Target platform: ' + platformSelect.value);
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
    { title: 'Cleanup', kind: 'checks', ids: ['safe', 'strip-colors'] },
    { title: 'Structural', kind: 'checks', ids: ['join', 'instance'] },
    { title: 'Geometry', kind: 'geometry' },
    { title: 'Textures', kind: 'checks', ids: ['ktx2'] },
    { title: 'Animation', kind: 'checks', ids: ['resample'] },
  ];
  const NEEDS_DECODER = new Set(['meshopt', 'draco', 'ktx2', 'instance']);
  // ⚠ — не документация, а требование к разработчику (нужно подключить декодер на сайте).
  // 📖 остаётся отдельным значком «пояснение, как это работает» — их нельзя путать.
  // Текст — что именно установить, отдельно на каждую технологию (не один и тот же текст
  // под всеми значками): разработчик должен понять, ЧТО конкретно подключить.
  const DECODER_NOTES = {
    meshopt: 'Install the Meshopt decoder on the target site/engine.',
    draco: 'Install the Draco decoder on the target site/engine.',
    ktx2: 'Install a KTX2 (Basis Universal) transcoder on the target site/engine.',
    instance: 'Target site/engine must support EXT_mesh_gpu_instancing.',
  };
  // Общий смысл значка — для легенды панели (сама легенда не заменяет конкретный текст
  // на каждом значке, только объясняет, что вообще значит ⚠).
  const DECODER_NOTE = 'Marks options that need extra decoder/engine support to display correctly';

  async function loadExtensions(platformId) {
    extensions = [];
    extensionsList.innerHTML = '';
    // Подсказка живёт в <body> и переживает пересборку панели — но кнопка, к которой
    // она привязана, нет. Осталась бы висеть у пустого места.
    infoTip.hide();
    extensionsPanel.classList.add('hidden');
    if (decoderLegend) decoderLegend.classList.add('hidden');
    if (!platformId) return;

    try {
      const res = await fetch(`/api/extensions?platform=${encodeURIComponent(platformId)}`);
      const data = await res.json();
      extensions = (data && data.extensions) || [];
    } catch (e) {
      extensions = []; // расширенные опции недоступны — базовая обработка всё равно работает
    }

    // Пользователь мог переключить платформу ещё раз, пока этот fetch летел — устаревший
    // ответ не должен перестраивать панель под другую (текущую) платформу и записывать
    // savedSelections не в тот ключ.
    if (platformSelect.value !== platformId) return;

    if (!extensions.length) return;

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
    if (decoderLegend) decoderLegend.classList.toggle('hidden', !extensions.some((e) => NEEDS_DECODER.has(e.id)));
    extensionsPanel.classList.remove('hidden');
    // панель пересобрана → дефолты платформы + авто-флажки [Source] + состояние кнопки
    applyDetection();
    updateRunButtonState();
  }

  function optSection(title) {
    const sec = document.createElement('div');
    sec.className = 'opt-section';
    const h = document.createElement('div');
    h.className = 'opt-section-title';
    h.textContent = title;
    sec.appendChild(h);
    return sec;
  }

  // ⚠ — предупреждение «нужен доп. декодер на сайте». Один переиспользуемый индикатор
  // вместо повторения одного и того же title у каждой опции (Meshopt/Draco/KTX2/Instance).
  function decoderWarning(id) {
    const w = document.createElement('span');
    w.className = 'ext-decoder-warn';
    w.textContent = '⚠';
    const note = (id && DECODER_NOTES[id]) || DECODER_NOTE;
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
        p.textContent = `Impact: ${ext.impact}`;
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
    btn.setAttribute('aria-label', `Details: ${ext.title || ext.id}`);
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

  // Геометрия — Meshopt/Draco, взаимоисключающие. Нет отдельного пункта "None": обе
  // технологии выключены = геометрия не сжимается. Клик по уже активному пункту гасит
  // его (checkbox, не radio — только radio-группа не даёт снять выбор повторным кликом).
  function renderGeometryGroup(byId) {
    if (!byId.meshopt && !byId.draco) return null;
    const sec = optSection('Geometry');
    const opts = [
      byId.meshopt && { v: 'meshopt', ext: byId.meshopt, label: byId.meshopt.title },
      byId.draco && { v: 'draco', ext: byId.draco, label: byId.draco.title },
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

      if (o.ext && NEEDS_DECODER.has(o.ext.id)) head.appendChild(decoderWarning(o.ext.id));

      row.appendChild(head);
      if (o.ext) head.appendChild(infoButton(o.ext));
      sec.appendChild(row);
    }
    return sec;
  }

  function renderCheckGroup(group, byId) {
    const items = group.ids.map((id) => byId[id]).filter(Boolean);
    if (!items.length) return null;
    const sec = optSection(group.title);
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
    checkbox.addEventListener('change', onOptionChanged);

    const titleSpan = document.createElement('span');
    titleSpan.textContent = ext.title || ext.id;

    label.appendChild(checkbox);
    label.appendChild(titleSpan);
    if (NEEDS_DECODER.has(ext.id)) label.appendChild(decoderWarning(ext.id));

    head.appendChild(label);
    head.appendChild(infoButton(ext));

    row.appendChild(head);

    // KTX2 — один флажок с раскрывающимся селектором режима (UASTC по умолчанию,
    // ETC1S — максимальное сжатие). Отдельного чекбокса ETC1S нет (future-proof).
    if (ext.id === 'ktx2') {
      const mode = document.createElement('details');
      mode.className = 'ktx2-mode hidden';
      const summary = document.createElement('summary');
      summary.innerHTML = 'Mode: <span class="ktx2-mode-current">UASTC</span>';
      mode.appendChild(summary);
      const modeOpts = [
        { v: 'uastc', label: 'UASTC (Recommended)', short: 'UASTC' },
        { v: 'mixed', label: 'ETC1S (Maximum Compression)', short: 'ETC1S' },
      ];
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
          logMessage('debug', 'KTX2 mode: ' + o.short);
        });
        optLabel.appendChild(radio);
        optLabel.appendChild(document.createTextNode(' ' + o.label));
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
      chosenFileLabel.textContent = 'Only .glb is supported for now';
      logMessage('warn', `Rejected "${file.name}" — only .glb is supported for now`);
      selectedFile = null;
      runBtn.disabled = true;
      return;
    }
    selectedFile = file;
    chosenFileLabel.textContent = '';
    runBtn.disabled = false;
    logMessage('info', `Model loaded: ${file.name} (${fmtBytes(file.size)})`);
    renderModelList(file);
    if (stageHint) stageHint.classList.add('hidden');
    // Новый файл → сбросить прежний результат и серверный исходник (будет перезалит).
    clearResults();
    // Сразу показать оригинал в левом вьюпорте + его базовые данные (ещё до сборки).
    if (window.OptiViewer) {
      const info = await window.OptiViewer.loadOriginal(file);
      renderOriginalStats(file.size, info && info.stats);
      // Определяем, что уже сжато в исходнике → авто-включаем флажки с бейджем [Source].
      lastDetection = (info && info.detected) || null;
      const found = Object.keys(lastDetection || {}).filter((k) => lastDetection[k]);
      if (found.length) logMessage('info', 'Compression found in source: ' + found.join(', '));
      applyDetection();
    }
    // Инспекция на сервере (metadata + validation) + регистрация исходника, чтобы
    // сборка потом переиспользовала его без перезаливки.
    inspectModel(file);
  }

  async function inspectModel(file) {
    modelInspect = null;
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
        logMessage('warn', `Inspection failed (${res.status}) — Metadata and Validation are unavailable`);
        return;
      }
      const data = await res.json();
      if (selectedFile !== file) return;
      modelInspect = data;
      if (data.sourceId) currentSourceId = data.sourceId; // сборка переиспользует исходник
      btnMetadata.disabled = false;
      btnValidation.disabled = false;
      updateInspectButtons();
      const n = (data.validation || []).filter((m) => !m.explainedBy).length;
      logMessage('info', n
        ? `Source inspected — ${n} validation issue${n === 1 ? '' : 's'}`
        : 'Source inspected — no validation issues');
    } catch (e) {
      // инспекция недоступна — кнопки выключены, сборка всё равно работает
      logMessage('warn', 'Inspection unavailable: ' + e.message);
    }
  }

  // Счётчик на кнопке Validation: пока собранной модели нет — число проблем исходника;
  // после сборки — «было → стало», чтобы разница была видна не открывая окно.
  function updateInspectButtons() {
    if (!modelInspect) { btnValidation.textContent = '✓ Validation'; return; }
    // считаем только настоящие проблемы: сообщения, объяснённые слепотой валидатора
    // к расширениям, дефектами модели не являются (см. explainedBy в addons/gltf).
    const real = (data) => (data.validation || []).filter((m) => !m.explainedBy).length;
    const src = real(modelInspect);
    const dst = resultInspect ? real(resultInspect) : null;
    // Обе стороны чистые — не мусорим нулями в подписи.
    if (!src && !dst) { btnValidation.textContent = '✓ Validation'; return; }
    btnValidation.textContent = dst === null ? `✓ Validation (${src})` : `✓ Validation (${src} → ${dst})`;
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
        logMessage('warn', `Could not inspect the optimized model (${res.status})`);
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
        ? `Optimized model inspected — ${n} validation issue${n === 1 ? '' : 's'}`
        : 'Optimized model inspected — no validation issues');
    } catch (e) {
      logMessage('warn', 'Could not inspect the optimized model: ' + e.message);
    }
  }

  // Состояние панели опций после (пере)сборки панели или загрузки модели.
  // Если пользователь уже что-то выбирал на этой платформе — ВОССТАНАВЛИВАЕМ его выбор
  // (настройки не слетают при новой модели/возврате платформы). Иначе — рекомендуемые
  // дефолты + авто-флажки по источнику. Бейджи [Source] показываем всегда по текущей модели.
  function applyDetection() {
    extensionsList.querySelectorAll('.ext-source-badge').forEach((b) => b.remove());

    const saved = savedSelections[platformSelect.value];
    if (saved) restoreSelection(saved);
    else applyDefaultSelection();

    showDetectionBadges();
    syncGeometryRadio();
    syncKtx2ModeUI();
    toggleKtx2Mode(!!(document.getElementById('ext-ktx2') && document.getElementById('ext-ktx2').checked));
    updateRunButtonState();
  }

  // Рекомендуемые дефолты: Safe + Join, геометрия None; авто-выбор по тому, что уже сжато
  // в исходнике. Remove vertex colors по умолчанию ВЫКЛ (белые каналы чистит Safe без потерь).
  function applyDefaultSelection() {
    setCheck('safe', true);
    setCheck('join', true);
    setCheck('strip-colors', false);
    setCheck('ktx2', false);
    geometryChoice = 'none';
    if (lastDetection) {
      if (lastDetection.draco) geometryChoice = 'draco';
      else if (lastDetection.meshopt) geometryChoice = 'meshopt';
      if (lastDetection.ktx2) setCheck('ktx2', true);
    }
  }

  // Восстановить последний выбор пользователя на этой платформе. Геометрия, которой на
  // платформе нет (нет radio), откатывается к None; флажки берём по существующим чекбоксам.
  function restoreSelection(saved) {
    geometryChoice = saved.geometryChoice || 'none';
    if (geometryChoice !== 'none' && !document.getElementById(`geom-${geometryChoice}`)) geometryChoice = 'none';
    ktx2Mode = saved.ktx2Mode || 'uastc';
    for (const cb of extensionsList.querySelectorAll('.ext-checkbox')) {
      cb.checked = saved.checked.includes(cb.value);
    }
  }

  // Снимок текущего выбора → память платформы. Зовётся только при ЯВНОМ действии
  // пользователя (не из applyDefaultSelection), иначе дефолты затирали бы «последний выбор».
  function rememberSelection() {
    savedSelections[platformSelect.value] = {
      geometryChoice,
      ktx2Mode,
      checked: [...extensionsList.querySelectorAll('.ext-checkbox:checked')].map((cb) => cb.value),
    };
  }

  // Бейджи [Source] — по текущей модели, информационно (что уже было в импортированном файле).
  function showDetectionBadges() {
    if (!lastDetection) return;
    if (lastDetection.draco) badgeGeometry('draco');
    else if (lastDetection.meshopt) badgeGeometry('meshopt');
    if (lastDetection.ktx2) badgeCheck('ktx2');
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
    badge.textContent = 'Source';
    badge.title = 'This technology was already used in the imported model';
    anchor.appendChild(badge);
  }

  // HUD слева до первой сборки: основные данные модели, посчитанные из сцены на клиенте.
  // После сборки заменяются авторитетными before/after-метриками ядра (renderComparison).
  function renderOriginalStats(fileSize, stats) {
    statsBefore.innerHTML = '';
    if (!stats) return;
    const rows = [
      ['FILE', fmtBytes(fileSize)],
      ['TRIS', fmtInt(stats.triangles)],
      ['VERT', fmtInt(stats.vertices)],
      ['DRAWS', fmtInt(stats.drawCalls)],
      ['MATS', fmtInt(stats.materials)],
      ['TEX', fmtInt(stats.textures)],
    ];
    for (const [k, v] of rows) statsBefore.appendChild(hudLine(k, v, null));
  }

  // Сбросить всё, что относится к предыдущему результату оптимизации (при загрузке
  // новой модели). Саму загруженную модель и вьюпорты не трогает.
  function clearResults() {
    currentSourceId = null;
    lastBuildSignature = null; // новая модель ещё не собиралась — первая сборка разрешена
    resultInspect = null; // окна инспекции снова показывают только исходник
    runToken++; // инвалидирует inspectResult() прежней модели, если он ещё летит
    updateInspectButtons();
    resultDownloadUrl = null;
    downloadBtn.classList.add('hidden');
    exportWindow.classList.add('hidden');
    irreversibleWarning.classList.add('hidden');
    failBanner.classList.add('hidden');
    runBtn.textContent = 'Build Optimized Model';
    // Правый HUD пуст до сборки; левый заполняется базовыми данными модели в handleFile.
    statsAfter.innerHTML = '';
    deltaBadge.textContent = '';
    [summarySection, analysisSection, budgetsSection, warningsSection,
      appliedSection, skippedSection, validationSection].forEach((s) => s.classList.add('hidden'));
  }

  // Список моделей слева. Пока одна модель за раз; позже — несколько с выбором.
  function renderModelList(file) {
    modelList.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'model-item selected';
    const icon = document.createElement('span');
    icon.className = 'model-icon';
    icon.textContent = '▣';
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = file.name;
    name.title = file.name;
    const size = document.createElement('span');
    size.className = 'model-size';
    size.textContent = fmtBytes(file.size);
    li.appendChild(icon);
    li.appendChild(name);
    li.appendChild(size);
    modelList.appendChild(li);
  }

  chooseFileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });

  // ---------------------------------------------------------------
  // Статус-бар
  // ---------------------------------------------------------------

  function setPhase(text, mode) {
    phaseStatus.textContent = text;
    statusDot.classList.remove('busy', 'fail');
    if (mode === 'busy') statusDot.classList.add('busy');
    if (mode === 'fail') statusDot.classList.add('fail');
  }

  function onProgressEvent(e) {
    if (e.type === 'phase') {
      setPhase(`Phase ${e.phase}: ${e.name}`, 'busy');
      logMessage('debug', `Phase ${e.phase}: ${e.name}`);
    } else if (e.type === 'rule') {
      setPhase(`Rule: ${e.title}`, 'busy');
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
    return `/api/optimize?platform=${encodeURIComponent(platformId)}&job=${encodeURIComponent(jobId)}${featuresParam}${sourceParam}${texParam}`;
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

  async function runOptimize() {
    if (!selectedFile) return;

    runBtn.disabled = true;
    setPhase(currentSourceId ? 'Optimizing…' : 'Uploading file…', 'busy');
    const feats = getSelectedFeatures();
    logMessage('info', `Build started — platform ${platformSelect.value}, options: ${feats.join(', ') || 'none'}`);

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
        showGenericError(data && data.error ? data.error : `The server responded with an error (${res.status}).`);
        return;
      }

      renderResult(data);
    } catch (e) {
      if (es) es.close();
      showGenericError('Could not reach the server: ' + e.message);
    } finally {
      updateRunButtonState();
    }
  }

  function showGenericError(message) {
    setPhase('Error', 'fail');
    logMessage('error', message);
    showWindow(failBanner);
    failBanner.querySelector('.fail-title').textContent = 'Could not process the file';
    failBanner.querySelector('.fail-text').textContent = message;
    failValidation.innerHTML = '';
    // Кнопку не прячем; прогон не удался — разрешаем повтор даже с теми же настройками.
    lastBuildSignature = null;
    irreversibleWarning.classList.add('hidden');
  }

  // ---------------------------------------------------------------
  // Рендер результата
  // ---------------------------------------------------------------

  function renderResult(data) {
    const { result, explain, downloadUrl } = data;

    // Запоминаем серверный исходник даже при fail (файл уже загружен) — чтобы повтор
    // с другими флажками шёл без перезаливки.
    if (data.sourceId) currentSourceId = data.sourceId;

    if (!result || result.status === 'fail') {
      renderFail(result, explain);
      return;
    }

    setPhase('Ready', null);
    failBanner.classList.add('hidden');

    // Применённые правила — раньше итога, чтобы в свёрнутой панели логов (она показывает
    // последнее сообщение) оставался итог сборки, а не случайное последнее правило.
    for (const a of result.applied || []) logMessage('debug', 'Applied: ' + a.text);
    const m = result.metrics;
    if (m && m.before && m.after) {
      logMessage('info', `Build finished — ${fmtBytes(m.before.fileBytes)} → ${fmtBytes(m.after.fileBytes)}`
        + ` (${pctText(m.before.fileBytes, m.after.fileBytes)})`);
    } else {
      logMessage('info', 'Build finished');
    }

    renderComparison(result.metrics);
    renderSummary(explain);
    renderValidation(result.validation);
    renderIssues(result.findings, result.applied);
    renderBudgets(explain && explain.budgetChecks);
    renderWarnings(explain && explain.warnings);
    renderAppliedSkipped(result.applied, result.skipped);

    // Кнопку не прячем — можно менять флажки и пересобирать результат сколько угодно раз.
    // Запоминаем настройки этой сборки: пока их не изменят, пересборка неактивна.
    runBtn.textContent = 'Rebuild with New Settings';
    lastBuildSignature = currentSettingsSignature();

    // Результат перезаписывается на сервере при каждом прогоне → анти-кэш в URL,
    // чтобы вьюпорт и скачивание всегда брали свежий вариант.
    const bust = (u) => (u ? u + (u.includes('?') ? '&' : '?') + 't=' + (++runToken) : u);
    const freshUrl = bust(downloadUrl);

    // Правый вьюпорт: загрузить оптимизированную модель (оригинал уже показан слева).
    if (window.OptiViewer) window.OptiViewer.loadOptimized(freshUrl);

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
      resultInspect = null;
      runToken++; // инвалидирует inspectResult() предыдущей сборки, если он ещё летит
      updateInspectButtons();
    }
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

  function renderFail(result, explain) {
    setPhase('File failed validation', 'fail');
    logMessage('error', 'File not written — the model failed the integrity check.');
    showWindow(failBanner);
    failBanner.querySelector('.fail-title').textContent = 'File not written';
    failBanner.querySelector('.fail-text').textContent =
      (explain && explain.summary) || 'The model failed the integrity check — the source file is untouched.';

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

    for (const [label, beforeVal, afterVal, fmt] of rows) {
      statsBefore.appendChild(hudLine(label, fmt(beforeVal), null));
      let cls = null;
      if (beforeVal != null && afterVal != null && afterVal !== beforeVal) {
        cls = afterVal < beforeVal ? 'better' : 'worse';
      }
      statsAfter.appendChild(hudLine(label, fmt(afterVal), cls));
    }

    const fileDelta = pctText(before.fileBytes, after.fileBytes);
    deltaBadge.textContent = fileDelta;
    deltaBadge.classList.remove('good', 'neutral');
    deltaBadge.classList.add(after.fileBytes <= before.fileBytes ? 'good' : 'neutral');
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

    const notableCount = (findings || []).filter((f) => f.severity === 'error' || f.severity === 'warn').length;
    issuesCount.textContent = notableCount ? `${notableCount} important` : `${(findings || []).length}`;

    issuesList.innerHTML = '';

    if (lossyLines.length) {
      const card = document.createElement('div');
      card.className = 'issue-card sev-error issue-card--lossy';
      const title = document.createElement('p');
      title.className = 'issue-title';
      title.textContent = `Irreversible changes (${lossyLines.length})`;
      const hint = document.createElement('p');
      hint.className = 'issue-text';
      hint.textContent = 'This data cannot be restored from the result — keep the source file.';
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
      buckets.get(key).items.push({ ruleId: f.ruleId, text: f.text });
    }

    for (const b of buckets.values()) {
      const sev = b.severity === 'error' ? 'sev-error' : b.severity === 'warn' ? 'sev-warn' : 'sev-info';
      for (const line of condense(b.items)) {
        const card = document.createElement('div');
        card.className = `issue-card ${sev}`;

        const title = document.createElement('p');
        title.className = 'issue-title';
        title.textContent = CATEGORY_LABELS[b.category] || b.category || 'Finding';

        const text = document.createElement('p');
        text.className = 'issue-text';
        text.textContent = line;

        card.appendChild(title);
        card.appendChild(text);
        issuesList.appendChild(card);
      }
    }
  }

  function renderBudgets(budgetChecks) {
    const has = budgetChecks && budgetChecks.length;
    budgetsSection.classList.toggle('hidden', !has);
    if (!has) return;

    budgetsList.innerHTML = '';
    for (const b of budgetChecks) {
      const row = document.createElement('div');
      row.className = `budget-row ${b.ok ? 'ok' : 'warn'}`;

      const head = document.createElement('div');
      head.className = 'budget-row-head';
      const name = document.createElement('span');
      name.className = 'budget-name';
      name.textContent = b.name;
      const icon = document.createElement('span');
      icon.className = 'budget-icon';
      icon.textContent = b.ok ? '✅' : '⚠️';
      head.appendChild(name);
      head.appendChild(icon);

      const values = document.createElement('div');
      values.className = 'budget-values';
      values.textContent = `${b.actualText} / ${b.limitText}`;

      row.appendChild(head);
      row.appendChild(values);

      if (!b.ok && b.advice) {
        const advice = document.createElement('p');
        advice.className = 'budget-advice';
        advice.textContent = b.advice;
        row.appendChild(advice);
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
      const key = (it.ruleId || '') + '|' + template;
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
      // Количество — префиксом, имена — на месте того самого имени. Читается как
      // обычная фраза: «5× COLOR_0 (mesh Fringe, Paisley, …): PAINTED, removed…».
      // Складывать количество внутрь скобок пробовали — получалось «mesh 5: Fringe»,
      // что похоже на номер меша, а не на их число.
      const shown = g.names.slice(0, MAX_NAMES).join(', ');
      const rest = g.names.length - MAX_NAMES;
      const list = g.names.length ? `${shown}${rest > 0 ? ` and ${rest} more` : ''}` : '—';
      let first = true;
      const body = g.template.replace(new RegExp(NAME_SLOT, 'g'), () => {
        if (first) { first = false; return list; }
        return '—';
      });
      out.push(`${g.count}× ${body}`);
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
      validationCount.textContent = failed
        ? `— ${failed} failed`
        : `— all ${validation.length} passed`;
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
    logsLast.textContent = last ? last.text : 'no messages';
    logsLast.title = last ? last.text : '';
  }

  function renderLogsWindow() {
    logsBody.innerHTML = '';
    if (!logs.length) {
      const p = document.createElement('p');
      p.className = 'meta-empty';
      p.textContent = 'No log messages yet.';
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
    logMessage('info', `Exported ${fileName} (${fmt === EXPORT_FORMATS.json ? 'glTF JSON' : 'GLB'})`);
  });

  logsClear.addEventListener('click', () => {
    logs.length = 0;
    updateLogsBar();
    renderLogsWindow();
  });

  updateLogsBar();

  // Легенда ⚠ — построена один раз тем же decoderWarning(), что и значки в списке опций,
  // чтобы значение символа было визуально узнаваемо одним и тем же элементом.
  if (decoderLegend) {
    decoderLegend.appendChild(decoderWarning());
    decoderLegend.appendChild(document.createTextNode(' ' + DECODER_NOTE + '.'));
  }

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

  const SEVERITY = { 0: 'Error', 1: 'Warning', 2: 'Info', 3: 'Hint' };

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
    for (const h of ['ID', ...keys]) {
      const th = document.createElement('th');
      th.textContent = h.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
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
    wrap.appendChild(inspectColumn('Original', modelInspect, buildPane, 'No model loaded yet.'));
    wrap.appendChild(inspectColumn('Optimized', resultInspect, buildPane,
      'No optimized model yet — run a build to compare.'));
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
      p.textContent = 'No scene contents reported.';
      col.appendChild(p);
    }
  }

  function issuesTable(issues) {
    const rows = issues.map((m) => ({
      code: m.code,
      message: m.message,
      severity: SEVERITY[m.severity] || String(m.severity),
      pointer: m.pointer || '',
    }));
    const scroll = document.createElement('div');
    scroll.className = 'meta-table-scroll';
    const table = buildTable(rows);
    // подсветка по severity
    const trs = table.querySelectorAll('tbody tr');
    issues.forEach((m, i) => { if (trs[i]) trs[i].classList.add(`sev-${m.severity}`); });
    scroll.appendChild(table);
    return scroll;
  }

  // Сообщения, которые валидатор выдал только потому, что не читает расширение (аддон помечает
  // их `explainedBy`), — отдельной свёрнутой группой: это не дефекты модели, но и прятать вывод
  // валидатора совсем неправильно, поэтому он доступен в один клик.
  function explainedGroup(explained) {
    const names = [...new Set(explained.map((m) => m.explainedBy))].sort();
    const box = document.createElement('details');
    box.className = 'meta-explained';
    const sum = document.createElement('summary');
    sum.textContent = `${explained.length} note${explained.length === 1 ? '' : 's'} from extensions the validator cannot read`
      + ` (${names.join(', ')}) — not defects`;
    box.appendChild(sum);
    box.appendChild(issuesTable(explained));
    return box;
  }

  function buildValidationPane(col, data) {
    const all = data.validation || [];
    const issues = all.filter((m) => !m.explainedBy);
    const explained = all.filter((m) => m.explainedBy);

    if (issues.length) {
      col.appendChild(issuesTable(issues));
    } else {
      const p = document.createElement('p');
      p.className = 'meta-empty';
      p.textContent = 'No validation issues — the file is clean.';
      col.appendChild(p);
    }
    if (explained.length) col.appendChild(explainedGroup(explained));
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
        opt.textContent = name;
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

  if (animPlayBtn) {
    animPlayBtn.addEventListener('click', () => {
      const playing = !animPlayBtn.classList.contains('is-on');
      animPlayBtn.classList.toggle('is-on', playing);
      animPlayBtn.setAttribute('aria-pressed', String(playing));
      animPlayBtn.textContent = playing ? '⏸' : '▶';
      animPlayBtn.title = playing ? 'Pause animation' : 'Play animation';
      animPlayBtn.setAttribute('aria-label', animPlayBtn.title);
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

  loadPlatforms();
})();
