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

  const platformSelect = $('platform-select');
  const platformDescription = $('platform-description');

  const extensionsPanel = $('extensions-panel');
  const extensionsList = $('extensions-list');

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
  const downloadBtn = $('download-btn');
  const irreversibleWarning = $('irreversible-warning');
  const irreversibleList = $('irreversible-list');

  const statusDot = $('status-dot');
  const phaseStatus = $('phase-status');
  const versionLabel = $('version-label');

  let selectedFile = null;
  // Идентификатор загруженного исходника на сервере: пока он есть, повторная
  // оптимизация той же модели идёт без перезаливки файла (меняем только флажки).
  let currentSourceId = null;
  let runToken = 0; // анти-кэш для перезаписываемого результата (вьюпорт + скачивание)
  // Подпись настроек (платформа + флажки) последней УСПЕШНОЙ сборки. Пока настройки не
  // менялись, «Rebuild with New Settings» неактивна — пересборка дала бы тот же результат.
  let lastBuildSignature = null;
  let platforms = [];
  let extensions = [];

  // Текущая подпись настроек оптимизации: платформа + отсортированный набор флажков.
  function currentSettingsSignature() {
    return platformSelect.value + '|' + getSelectedFeatures().slice().sort().join(',');
  }

  // Состояние кнопки запуска: до первой сборки — активна при выбранном файле;
  // после сборки — активна только если настройки изменились с момента той сборки.
  function updateRunButtonState() {
    if (!selectedFile) { runBtn.disabled = true; runBtn.removeAttribute('title'); return; }
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
  });

  // ---------------------------------------------------------------
  // Расширенные опции (KTX2, Draco, strip-colors, ...) — данные и описания
  // приходят от AI Assistant через /api/extensions; здесь только рендер.
  // ---------------------------------------------------------------

  async function loadExtensions(platformId) {
    extensions = [];
    extensionsList.innerHTML = '';
    extensionsPanel.classList.add('hidden');
    if (!platformId) return;

    try {
      const res = await fetch(`/api/extensions?platform=${encodeURIComponent(platformId)}`);
      const data = await res.json();
      extensions = (data && data.extensions) || [];
    } catch (e) {
      extensions = []; // расширенные опции недоступны — базовая обработка всё равно работает
    }

    if (!extensions.length) return;

    for (const ext of extensions) {
      extensionsList.appendChild(buildExtensionRow(ext));
    }
    extensionsPanel.classList.remove('hidden');
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
    checkbox.addEventListener('change', updateRunButtonState);

    const titleSpan = document.createElement('span');
    titleSpan.textContent = ext.title || ext.id;

    label.appendChild(checkbox);
    label.appendChild(titleSpan);

    const infoBtn = document.createElement('button');
    infoBtn.type = 'button';
    infoBtn.className = 'ext-info-btn';
    infoBtn.textContent = '📖';
    infoBtn.setAttribute('aria-label', `Details: ${ext.title || ext.id}`);
    if (ext.description) infoBtn.title = ext.description;

    head.appendChild(label);
    head.appendChild(infoBtn);

    const desc = document.createElement('div');
    desc.className = 'ext-description hidden';
    if (ext.description) {
      const descText = document.createElement('p');
      descText.textContent = ext.description;
      desc.appendChild(descText);
    }
    if (ext.impact) {
      const impactText = document.createElement('p');
      impactText.className = 'ext-impact';
      impactText.textContent = `Impact: ${ext.impact}`;
      desc.appendChild(impactText);
    }

    infoBtn.addEventListener('click', () => desc.classList.toggle('hidden'));

    row.appendChild(head);
    row.appendChild(desc);
    return row;
  }

  function getSelectedFeatures() {
    return Array.from(extensionsList.querySelectorAll('.ext-checkbox:checked')).map((cb) => cb.value);
  }

  // ---------------------------------------------------------------
  // Drag & drop / выбор файла
  // ---------------------------------------------------------------

  async function handleFile(file) {
    if (!file) return;
    if (!/\.glb$/i.test(file.name)) {
      chosenFileLabel.textContent = 'A file with a .glb extension is required';
      selectedFile = null;
      runBtn.disabled = true;
      return;
    }
    selectedFile = file;
    chosenFileLabel.textContent = '';
    runBtn.disabled = false;
    renderModelList(file);
    if (stageHint) stageHint.classList.add('hidden');
    // Новый файл → сбросить прежний результат и серверный исходник (будет перезалит).
    clearResults();
    // Сразу показать оригинал в левом вьюпорте + его базовые данные (ещё до сборки).
    if (window.OptiViewer) {
      const stats = await window.OptiViewer.loadOriginal(file);
      renderOriginalStats(file.size, stats);
    }
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
    downloadBtn.classList.add('hidden');
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
    } else if (e.type === 'rule') {
      setPhase(`Rule: ${e.title}`, 'busy');
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
    return `/api/optimize?platform=${encodeURIComponent(platformId)}&job=${encodeURIComponent(jobId)}${featuresParam}${sourceParam}`;
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

    renderComparison(result.metrics);
    renderSummary(explain);
    renderIssues(result.findings);
    renderBudgets(explain && explain.budgetChecks);
    renderWarnings(explain && explain.warnings);
    renderAppliedSkipped(result.applied, result.skipped);
    renderValidation(result.validation);

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
      downloadBtn.classList.remove('hidden');
      downloadBtn.href = freshUrl;
      const name = result.file && result.file.dst ? result.file.dst.split(/[\\/]/).pop() : 'model.glb';
      downloadBtn.setAttribute('download', name);
      renderIrreversibleWarning(result.applied);
    } else {
      downloadBtn.classList.add('hidden');
      irreversibleWarning.classList.add('hidden');
    }
  }

  // §4d ARCHITECTURE.md: перед скачиванием предупреждаем о применённых изменениях,
  // при которых данные потеряны безвозвратно (join структуры, strip раскрашенных цветов и т.п.)
  function renderIrreversibleWarning(applied) {
    const lossy = (applied || []).filter((a) => a.reversible === false && a.dataLoss === 'significant');
    irreversibleWarning.classList.toggle('hidden', !lossy.length);
    if (!lossy.length) return;
    irreversibleList.innerHTML = '';
    for (const a of lossy) {
      const li = document.createElement('li');
      li.textContent = a.text;
      irreversibleList.appendChild(li);
    }
  }

  function renderFail(result, explain) {
    setPhase('File failed validation', 'fail');
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

    downloadBtn.classList.add('hidden');
    irreversibleWarning.classList.add('hidden');
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

  function renderIssues(findings) {
    const list = (findings || []).filter((f) => f && f.severity !== 'info' || true); // показываем все находки
    analysisSection.classList.toggle('hidden', !findings || !findings.length);
    if (!findings || !findings.length) return;

    const notableCount = findings.filter((f) => f.severity === 'error' || f.severity === 'warn').length;
    issuesCount.textContent = notableCount ? `${notableCount} important` : `${findings.length}`;

    issuesList.innerHTML = '';
    for (const f of findings) {
      const card = document.createElement('div');
      const sev = f.severity === 'error' ? 'sev-error' : f.severity === 'warn' ? 'sev-warn' : 'sev-info';
      card.className = `issue-card ${sev}`;

      const title = document.createElement('p');
      title.className = 'issue-title';
      title.textContent = CATEGORY_LABELS[f.category] || f.category || 'Finding';

      const text = document.createElement('p');
      text.className = 'issue-text';
      text.textContent = f.text;

      card.appendChild(title);
      card.appendChild(text);
      issuesList.appendChild(card);
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

  function renderAppliedSkipped(applied, skipped) {
    appliedSection.classList.toggle('hidden', !applied || !applied.length);
    appliedList.innerHTML = '';
    if (applied && applied.length) {
      appliedCount.textContent = `(${applied.length})`;
      for (const a of applied) {
        const li = document.createElement('li');
        li.textContent = a.text;
        appliedList.appendChild(li);
      }
    }

    skippedSection.classList.toggle('hidden', !skipped || !skipped.length);
    skippedList.innerHTML = '';
    if (skipped && skipped.length) {
      skippedCount.textContent = `(${skipped.length})`;
      for (const s of skipped) {
        const li = document.createElement('li');
        li.textContent = (s.reason && s.reason !== s.text) ? `${s.text} — ${s.reason}` : s.text;
        li.classList.add('skip-reason');
        skippedList.appendChild(li);
      }
    }
  }

  function renderValidation(validation) {
    const has = validation && validation.length;
    validationSection.classList.toggle('hidden', !has);
    if (!has) return;
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
      if (e.target.closest('.window-close')) return;
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

  // Показать окно, вернув его в центр (сбросив позицию от прошлого перетаскивания).
  function showWindow(el) {
    el.style.left = '';
    el.style.top = '';
    el.style.transform = '';
    el.classList.remove('hidden');
  }

  setupWindow(failBanner);

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

  loadPlatforms();
})();
