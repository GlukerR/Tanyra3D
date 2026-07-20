// app.js — клиентская логика OptiMesh (v0.1.0). Без сборки, без CDN.
// Формат данных задают Core Engine (§4b ARCHITECTURE.md) и AI Assistant (assistant.mjs) —
// этот файл только форматирует байты/проценты и рисует то, что вернул сервер.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const dropzone = $('dropzone');
  const fileInput = $('file-input');
  const chooseFileBtn = $('choose-file-btn');
  const chosenFileLabel = $('chosen-file');

  const comparison = $('comparison');
  const statsBefore = $('stats-before');
  const statsAfter = $('stats-after');
  const deltaBadge = $('delta-badge');

  const failBanner = $('fail-banner');
  const failValidation = $('fail-validation');

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
  const resetBtn = $('reset-btn');

  const statusDot = $('status-dot');
  const phaseStatus = $('phase-status');
  const versionLabel = $('version-label');

  let selectedFile = null;
  let platforms = [];
  let extensions = [];

  // ---------------------------------------------------------------
  // Форматирование (байты → человекочитаемый вид) — зона web-interface
  // ---------------------------------------------------------------

  function fmtBytes(bytes) {
    if (bytes == null) return '—';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }

  function fmtInt(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('ru-RU');
  }

  function pctText(before, after) {
    if (!before) return '';
    const p = Math.round(((after - before) / before) * 100);
    if (p === 0) return 'без изменений';
    return p < 0 ? `−${Math.abs(p)}%` : `+${p}%`;
  }

  const CATEGORY_RU = {
    geometry: 'Геометрия',
    textures: 'Текстуры',
    materials: 'Материалы',
    uv: 'UV-развёртка',
    attributes: 'Атрибуты',
    scene: 'Сцена',
    performance: 'Производительность',
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
      versionLabel.textContent = data.engineVersion ? `ядро v${data.engineVersion}` : '';

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
      platformSelect.innerHTML = '<option value="web">Веб</option>';
      platforms = [{ id: 'web', title: 'Веб', description: '' }];
    }
  }

  function updatePlatformDescription() {
    const p = platforms.find((x) => x.id === platformSelect.value);
    platformDescription.textContent = p ? p.description || '' : '';
  }

  platformSelect.addEventListener('change', () => {
    updatePlatformDescription();
    loadExtensions(platformSelect.value);
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

    const titleSpan = document.createElement('span');
    titleSpan.textContent = ext.title || ext.id;

    label.appendChild(checkbox);
    label.appendChild(titleSpan);

    const infoBtn = document.createElement('button');
    infoBtn.type = 'button';
    infoBtn.className = 'ext-info-btn';
    infoBtn.textContent = '📖';
    infoBtn.setAttribute('aria-label', `Подробнее: ${ext.title || ext.id}`);
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
      impactText.textContent = `Влияние: ${ext.impact}`;
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

  function handleFile(file) {
    if (!file) return;
    if (!/\.glb$/i.test(file.name)) {
      chosenFileLabel.textContent = 'Нужен файл с расширением .glb';
      selectedFile = null;
      runBtn.disabled = true;
      return;
    }
    selectedFile = file;
    chosenFileLabel.textContent = `Выбран файл: ${file.name} (${fmtBytes(file.size)})`;
    runBtn.disabled = false;
  }

  chooseFileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

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
      setPhase(`Фаза ${e.phase}: ${e.name}`, 'busy');
    } else if (e.type === 'rule') {
      setPhase(`Правило: ${e.title}`, 'busy');
    }
  }

  // ---------------------------------------------------------------
  // Запуск обработки
  // ---------------------------------------------------------------

  runBtn.addEventListener('click', runOptimize);
  resetBtn.addEventListener('click', resetUI);

  function resetUI() {
    selectedFile = null;
    fileInput.value = '';
    chosenFileLabel.textContent = '';
    runBtn.disabled = true;
    runBtn.classList.remove('hidden');
    downloadBtn.classList.add('hidden');
    resetBtn.classList.add('hidden');
    dropzone.classList.remove('hidden');
    comparison.classList.add('hidden');
    failBanner.classList.add('hidden');
    [summarySection, analysisSection, budgetsSection, warningsSection,
      appliedSection, skippedSection, validationSection].forEach((s) => s.classList.add('hidden'));
    setPhase('Готово', null);
  }

  async function runOptimize() {
    if (!selectedFile) return;

    runBtn.disabled = true;
    setPhase('Загрузка файла…', 'busy');

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

    const platformId = platformSelect.value;
    const features = getSelectedFeatures();
    const featuresParam = features.length ? `&features=${encodeURIComponent(features.join(','))}` : '';
    const url = `/api/optimize?platform=${encodeURIComponent(platformId)}&job=${encodeURIComponent(jobId)}${featuresParam}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Filename': encodeURIComponent(selectedFile.name),
          'Content-Type': 'application/octet-stream',
        },
        body: selectedFile,
      });

      if (es) es.close();

      const data = await res.json();

      if (!res.ok) {
        showGenericError(data && data.error ? data.error : `Сервер ответил с ошибкой (${res.status}).`);
        return;
      }

      renderResult(data);
    } catch (e) {
      if (es) es.close();
      showGenericError('Не удалось связаться с сервером: ' + e.message);
    } finally {
      runBtn.disabled = false;
    }
  }

  function showGenericError(message) {
    setPhase('Ошибка', 'fail');
    dropzone.classList.add('hidden');
    comparison.classList.add('hidden');
    failBanner.classList.remove('hidden');
    failBanner.querySelector('.fail-title').textContent = 'Не удалось обработать файл';
    failBanner.querySelector('.fail-text').textContent = message;
    failValidation.innerHTML = '';
    runBtn.classList.add('hidden');
    resetBtn.classList.remove('hidden');
  }

  // ---------------------------------------------------------------
  // Рендер результата
  // ---------------------------------------------------------------

  function renderResult(data) {
    const { result, explain, downloadUrl } = data;
    dropzone.classList.add('hidden');

    if (!result || result.status === 'fail') {
      renderFail(result, explain);
      return;
    }

    setPhase('Готово', null);
    comparison.classList.remove('hidden');
    failBanner.classList.add('hidden');

    renderComparison(result.metrics);
    renderSummary(explain);
    renderIssues(result.findings);
    renderBudgets(explain && explain.budgetChecks);
    renderWarnings(explain && explain.warnings);
    renderAppliedSkipped(result.applied, result.skipped);
    renderValidation(result.validation);

    runBtn.classList.add('hidden');
    resetBtn.classList.remove('hidden');

    if (downloadUrl) {
      downloadBtn.classList.remove('hidden');
      downloadBtn.href = downloadUrl;
      const name = result.file && result.file.dst ? result.file.dst.split(/[\\/]/).pop() : 'model.glb';
      downloadBtn.setAttribute('download', name);
    } else {
      downloadBtn.classList.add('hidden');
    }
  }

  function renderFail(result, explain) {
    setPhase('Файл не прошёл проверку', 'fail');
    comparison.classList.add('hidden');
    failBanner.classList.remove('hidden');
    failBanner.querySelector('.fail-title').textContent = 'Файл не записан';
    failBanner.querySelector('.fail-text').textContent =
      (explain && explain.summary) || 'Модель не прошла проверку целостности — исходный файл не тронут.';

    failValidation.innerHTML = '';
    const items = (result && result.validation) || [];
    for (const v of items) {
      const row = document.createElement('div');
      row.textContent = `${VALIDATION_ICON[v.level] || '·'} ${v.text}`;
      failValidation.appendChild(row);
    }

    downloadBtn.classList.add('hidden');
    runBtn.classList.add('hidden');
    resetBtn.classList.remove('hidden');
  }

  function renderComparison(metrics) {
    if (!metrics || !metrics.before || !metrics.after) return;
    const { before, after } = metrics;

    statsBefore.innerHTML = '';
    statsAfter.innerHTML = '';

    const rows = [
      ['Файл', fmtBytes(before.fileBytes), fmtBytes(after.fileBytes)],
      ['Треугольники', fmtInt(before.triangles), fmtInt(after.triangles)],
      ['Элементов отрисовки', fmtInt(before.drawCalls), fmtInt(after.drawCalls)],
      ['Материалы', fmtInt(before.materials), fmtInt(after.materials)],
      ['Текстуры', fmtInt(before.textures), fmtInt(after.textures)],
      ['Видеопамять текстур', fmtBytes(before.gpuBytes), fmtBytes(after.gpuBytes)],
    ];

    for (const [label, beforeVal, afterVal] of rows) {
      statsBefore.appendChild(statRow(label, beforeVal));
      statsAfter.appendChild(statRow(label, afterVal));
    }

    const fileDelta = pctText(before.fileBytes, after.fileBytes);
    deltaBadge.textContent = fileDelta;
    deltaBadge.classList.remove('good', 'neutral');
    deltaBadge.classList.add(after.fileBytes <= before.fileBytes ? 'good' : 'neutral');
  }

  function statRow(label, value) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'stat-value';
    v.textContent = value;
    row.appendChild(l);
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
    issuesCount.textContent = notableCount ? `${notableCount} важных` : `${findings.length}`;

    issuesList.innerHTML = '';
    for (const f of findings) {
      const card = document.createElement('div');
      const sev = f.severity === 'error' ? 'sev-error' : f.severity === 'warn' ? 'sev-warn' : 'sev-info';
      card.className = `issue-card ${sev}`;

      const title = document.createElement('p');
      title.className = 'issue-title';
      title.textContent = CATEGORY_RU[f.category] || f.category || 'Находка';

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

  loadPlatforms();
})();
