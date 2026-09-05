(() => {
  'use strict';

  const $ = (id: string) => document.getElementById(id)!;
  const t = (key: string, params?: UiParams) => window.I18n.t(key, params);
  const setText = (el: Element | null, key: string, params?: UiParams) => window.I18n.setText(el, key, params);
  const setRaw = (el: Element | null, text: string) => window.I18n.setRaw(el, text);
  const langParam = () => `lang=${encodeURIComponent(window.I18n.lang)}`;

  const dropzone = $('dropzone');
  const fileInput = $('file-input') as HTMLInputElement;
  const chooseFileBtn = $('choose-file-btn');
  const chosenFileLabel = $('chosen-file');
  const modelList = $('model-list');
  const batchBar = $('batch-bar');
  const batchCount = $('batch-count');
  const batchToggle = $('batch-toggle') as HTMLInputElement;
  const batchSummaryBtn = $('batch-summary') as HTMLButtonElement;
  const batchRemoveBtn = $('batch-remove') as HTMLButtonElement;
  const confirmRemove = $('confirm-remove');
  const confirmRemoveText = $('confirm-remove-text');
  const confirmRemoveYes = $('confirm-remove-yes') as HTMLButtonElement;
  const confirmRemoveNo = $('confirm-remove-no') as HTMLButtonElement;
  const summaryWindow = $('summary-window');
  const summaryBody = $('summary-body');
  const summarySaveBtn = $('summary-save') as HTMLButtonElement;
  const stageHint = $('stage-hint');

  const btnMetadata = $('btn-metadata') as HTMLButtonElement;
  const btnValidation = $('btn-validation') as HTMLButtonElement;
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
  const lodControls = $('lod-controls');
  const lodLabel = $('lod-label');
  const lodSel = $('lod-select') as HTMLSelectElement;
  const variantControls = $('variant-controls');
  const variantSel = $('variant-select') as HTMLSelectElement;
  const displayFileBtn = $('display-file');
  const displayClayBtn = $('display-clay');
  const displayWireBtn = $('display-wire');
  const displayTexdiffBtn = $('display-texdiff');
  const lightControls = $('light-controls');
  const lightMenu = $('light-menu');
  const interactivityBtn = $('interactivity-toggle') as HTMLButtonElement | null;
  const cameraControls = $('camera-controls');
  const cameraSel = $('camera-select') as HTMLSelectElement;
  const animPlayBtn = $('anim-play-btn');
  const animClipSel = $('anim-clip') as HTMLSelectElement;
  const animSeek = $('anim-seek') as HTMLInputElement;
  const animTimeEl = $('anim-time');
  const exposureSlider = $('exposure-slider') as HTMLInputElement;
  const exposureValue = $('exposure-value');

  const platformSelect = $('platform-select') as HTMLSelectElement;
  const platformInfo = $('platform-info');

  const engineSection = $('engine-section');
  const engineSelect = $('engine-select') as HTMLSelectElement;
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

  const runBtn = $('run-btn') as HTMLButtonElement;
  const downloadBtn = $('download-btn');
  const exportWindow = $('export-window');
  const exportName = $('export-name') as HTMLInputElement;
  const exportSave = $('export-save');
  const irreversibleWarning = $('irreversible-warning');
  const integrityWarning = $('integrity-warning');
  const downloadAlert = $('download-alert');
  const exportAlert = $('export-alert');
  const exportAlertDetails = $('export-alert-details');
  const exportBudget = $('export-budget');
  const exportBudgetDetails = $('export-budget-details');
  const validationCount = $('validation-count');

  const statusDot = $('status-dot');
  const phaseStatus = $('phase-status');
  const versionLabel = $('version-label');

  const profileWindow = $('profile-window');
  const profilePick = $('profile-pick') as HTMLSelectElement;
  const profileTitle = $('profile-title') as HTMLInputElement;
  const profileEngine = $('profile-engine') as HTMLSelectElement;
  const profileDescription = $('profile-description') as HTMLInputElement;
  const profileSource = $('profile-source') as HTMLInputElement;
  const profileBudgets = $('profile-budgets');
  const profileError = $('profile-error');
  const profileSave = $('profile-save') as HTMLButtonElement;
  const profileDelete = $('profile-delete') as HTMLButtonElement;
  const profileDir = $('profile-dir');
  const profileFeatures = $('profile-features');
  const profileFile = $('profile-file') as HTMLInputElement;
  const profileImport = $('profile-import') as HTMLButtonElement;
  const profileExport = $('profile-export') as HTMLButtonElement;

  const busyByPane = new Map();

  function initBusyIndicators() {
    const tpl = document.getElementById('vp-busy-template');
    if (!tpl) return;
    for (const id of ['preview-original', 'preview-optimized']) {
      const pane = document.getElementById(id);
      if (!pane) continue;
      const node = (tpl as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement;
      pane.appendChild(node);
      busyByPane.set(id, node);
    }
  }

  function setBusy(paneId: string, messageKey: string | null) {
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

  const PERF_TICK_MS = 500;
  let perfTimer: ReturnType<typeof setInterval> | null = null;

  function initPerfMeter() {
    if (!perfBefore || !perfAfter || perfTimer != null) return;
    perfTimer = setInterval(renderPerf, PERF_TICK_MS);
    renderPerf();
  }

  function renderPerf() {
    const perf = window.OptiViewer && typeof window.OptiViewer.getPerf === 'function'
      ? window.OptiViewer.getPerf()
      : null;
    if (!perf) {
      perfBefore.innerHTML = '';
      perfAfter.innerHTML = '';
      return;
    }
    setPerfLine(perfBefore, perf.leftMs, `${Math.round(perf.fps!)} ${t('perf.fps')}`);
    setPerfLine(perfAfter, perf.rightMs, deltaText(perf.leftMs, perf.rightMs));
  }

  const PERF_RATIO_FLOOR_MS = 1;

  function deltaText(leftMs: number | undefined, rightMs: number | undefined) {
    if (!(leftMs! > 0) || !(rightMs! > 0)) return '';
    if (leftMs! < PERF_RATIO_FLOOR_MS && rightMs! < PERF_RATIO_FLOOR_MS) return '';
    const ratio = leftMs! / rightMs!;
    if (ratio > 1.05) return `×${ratio.toFixed(1)} ${t('perf.faster')}`;
    if (ratio < 0.95) return `×${(1 / ratio).toFixed(1)} ${t('perf.slower')}`;
    return '';
  }

  function setPerfLine(host: HTMLElement, ms: number | undefined, note?: string | null) {
    host.innerHTML = '';
    const row = hudLine(t('perf.draw'), `${ms!.toFixed(1)} ${t('perf.ms')}`, null);
    row.title = t('perf.title');
    if (note) {
      const extra = document.createElement('span');
      extra.className = 'hud-val perf-note';
      extra.textContent = note;
      row.appendChild(extra);
    }
    host.appendChild(row);
  }

  const MODEL_RE = /\.(glb|gltf|stl|ply|fbx|obj)$/i;

  const COMFORT_BYTES = 100 * 1024 * 1024;

  const selectedFile = () => activeModel()?.file || null;
  let currentSourceId: string | null = null;
  let originalStats: Stats | null = null;
  let runToken = 0;
  let lastBuildSignature: string | null = null;

  let lastDetection: Detection | null = null;
  let lastResult: RunResultDto | null = null;
  let lastExplain: ExplainDto | null = null;
  let lastFail: { result: RunResultDto | null; explain: ExplainDto | null } | null = null;
  let buildInFlight = false;
  let startedSignature: string | null = null;
  let modelInspect: InspectDto | null = null;
  let resultInspect: InspectDto | null = null;
  let modelIssue: ModelIssue | null = null;
  let resultDownloadUrl: string | null = null;
  let resultExportBase = 'model';
  const KTX2_MODE_FALLBACK = 'uastc';
  let ktx2Mode = KTX2_MODE_FALLBACK;
  let platformDefaults: Record<string, any> = {};
  const defaultKtx2Mode = () => platformDefaults.texMode || KTX2_MODE_FALLBACK;
  const WEBP_QUALITY_DEFAULT = 100;
  let webpQuality = WEBP_QUALITY_DEFAULT;
  let geometryChoice = 'none';
  let textureSizeChoice = 'none';
  let platforms: PlatformDto[] = [];
  let noPlatform: PlatformDto | null = null;
  let engines: EngineDto[] = [];
  let extensions: ExtensionDto[] = [];
  let exclusiveGroups: Array<{ id: string; members: string[] }> = [];

  function geometryMembers(): string[] {
    return (exclusiveGroups.find((g) => g.id === 'geometry') || { members: [] }).members;
  }
  let selection: UiSelection | null = null;

  const PER_MODEL_STATE = [
    { key: 'currentSourceId', get: () => currentSourceId, set: (v: any) => { currentSourceId = v; } },
    { key: 'originalStats', get: () => originalStats, set: (v: any) => { originalStats = v; } },
    { key: 'lastBuildSignature', get: () => lastBuildSignature, set: (v: any) => { lastBuildSignature = v; } },
    { key: 'lastDetection', get: () => lastDetection, set: (v: any) => { lastDetection = v; } },
    { key: 'lastResult', get: () => lastResult, set: (v: any) => { lastResult = v; } },
    { key: 'lastExplain', get: () => lastExplain, set: (v: any) => { lastExplain = v; } },
    { key: 'lastFail', get: () => lastFail, set: (v: any) => { lastFail = v; } },
    { key: 'modelInspect', get: () => modelInspect, set: (v: any) => { modelInspect = v; } },
    { key: 'modelIssue', get: () => modelIssue, set: (v: any) => { modelIssue = v; } },
    { key: 'resultInspect', get: () => resultInspect, set: (v: any) => { resultInspect = v; } },
    { key: 'resultDownloadUrl', get: () => resultDownloadUrl, set: (v: any) => { resultDownloadUrl = v; } },
    { key: 'resultExportBase', get: () => resultExportBase, set: (v: any) => { resultExportBase = v; } },
  ];

  const models: ModelEntry[] = [];
  let activeModelId: string | null = null;
  let modelSeq = 0;

  let batchInFlight = false;
  let batchCancel = false;

  const activeModel = () => models.find((m) => m.id === activeModelId) || null;

  function captureActiveModel() {
    const rec = activeModel();
    if (!rec) return;
    for (const f of PER_MODEL_STATE) rec.state[f.key] = f.get();
  }

  function applyModelState(state: Record<string, any> | null) {
    for (const f of PER_MODEL_STATE) f.set(state ? state[f.key] ?? null : null);
  }

  function currentSettingsSignature() {
    const feats = getSelectedFeatures().slice().sort();
    const mode = feats.includes('ktx2') ? `|ktx2:${ktx2Mode}` : '';
    const quality = feats.includes('webp') ? `|webpq:${webpQuality}` : '';
    return platformSelect.value + '|' + feats.join(',') + mode + quality;
  }

  function onOptionChanged() {
    toggleUvSubRow();
    updateRunButtonState();
    rememberSelection();
    closeAllDetails();
    const feats = getSelectedFeatures();
    logMessage('debug', t('log.options', { list: feats.length ? feats.join(', ') : t('log.none') }));
  }

  function updateRunButtonState() {
    if (batchInFlight) {
      runBtn.disabled = false;
      setText(runBtn, 'btn.stop');
      runBtn.removeAttribute('title');
      return;
    }
    setText(runBtn, 'btn.build');

    if (batchMode()) {
      const n = pickedModels().length;
      if (!n) {
        runBtn.disabled = true;
        runBtn.title = t('btn.nothingPicked');
        return;
      }
      if (n > 1) {
        const todo = modelsToBuild().length;
        if (!todo) {
          setText(runBtn, 'btn.buildPicked', { n: 0 });
          runBtn.disabled = true;
          runBtn.title = t('btn.changeSetting');
          return;
        }
        setText(runBtn, 'btn.buildPicked', { n: todo });
        runBtn.disabled = !!buildInFlight;
        runBtn.removeAttribute('title');
        return;
      }
    }
    if (buildInFlight) {
      runBtn.disabled = true;
      runBtn.title = t('btn.building');
      return;
    }
    if (!selectedFile()) {
      runBtn.disabled = true;
      runBtn.title = '';
      return;
    }
    if (lastBuildSignature === null) { runBtn.disabled = false; runBtn.removeAttribute('title'); return; }
    const unchanged = currentSettingsSignature() === lastBuildSignature;
    runBtn.disabled = unchanged;
    if (unchanged) runBtn.title = t('btn.changeSetting');
    else runBtn.removeAttribute('title');
  }

  function fmtBytes(bytes: number) {
    if (bytes == null) return '—';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t('unit.kb')}`;
    if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} ${t('unit.mb')}`;
    return `${(bytes / 1024 ** 3).toFixed(1)} ${t('unit.gb')}`;
  }

  function fmtInt(n: number) {
    if (n == null) return '—';
    return Number(n).toLocaleString(t('unit.locale'));
  }

  function pctText(before: number, after: number) {
    if (!before) return '';
    if (after === before) return '0%';
    const abs = Math.abs(((after - before) / before) * 100);
    const shown = abs.toFixed(abs >= 1 ? 0 : abs >= 0.1 ? 1 : 2);
    const magnitude = Number(shown) === 0 ? '<0.01' : shown;
    return (after < before ? '−' : '+') + magnitude + '%';
  }

  const CATEGORY_KEYS: Record<string, string> = {
    geometry: 'cat.geometry',
    textures: 'cat.textures',
    materials: 'cat.materials',
    uv: 'cat.uv',
    attributes: 'cat.attributes',
    scene: 'cat.scene',
    performance: 'cat.performance',
  };

  const VALIDATION_ICON: Record<string, string> = { pass: '✓', info: 'i', fail: '✕' };

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
      if (!platforms.length) {
        showExtensionsUnavailable('opts.noPlatforms');
        return;
      }
      await loadEngines();
      loadExtensions(platformSelect.value);
    } catch (e) {
      platformSelect.innerHTML = '<option value="web">Web</option>';
      platforms = [{ id: 'web', title: 'Web', description: '' }];
      showExtensionsUnavailable('opts.noServer', { error: String(((e as Error) && (e as Error).message) || e) });
    }
  }

  function showExtensionsUnavailable(messageKey: string, params?: UiParams) {
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
      await loadEngines();
    } catch (e) {
    }
  }

  async function reexplain(result: RunResultDto | null) {
    if (!result) return null;
    try {
      const res = await fetch(
        `/api/explain?platform=${encodeURIComponent(platformSelect.value)}&${langParam()}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result }) },
      );
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function reexplainLastResult() {
    if (lastFail) {
      const data = await reexplain(lastFail.result);
      if (data) {
        lastFail = {
          result: data.result || lastFail.result,
          explain: data.explain || lastFail.explain,
        };
      }
      renderFail(lastFail.result, lastFail.explain, true);
      return;
    }
    if (!lastResult) return;
    const data = await reexplain(lastResult);
    if (data) {
      if (data.explain) lastExplain = data.explain;
      if (data.result) lastResult = data.result;
    }
    renderReport(lastResult, lastExplain);
    renderIntegrity(lastResult);
  }

  function renderFieldInfo(host: HTMLElement, item: Record<string, any> | null) {
    infoTip.hide();
    host.textContent = '';
    if (!item || !item.description) return;
    host.appendChild(infoButton(item as ExtensionDto));
  }

  function unknownMark(names: string[]) {
    const w = document.createElement('span');
    w.className = 'ext-decoder-warn icon-badge';
    w.textContent = '?';
    const note = t('platform.unknownFields', { list: names.join(', '), n: names.length });
    w.title = note;
    w.setAttribute('aria-label', note);
    return w;
  }

  function updatePlatformDescription() {
    if (!platformSelect.value) {
      renderFieldInfo(platformInfo, noPlatform
        ? { id: 'none', title: t('insp.platform.none'), description: noPlatform.description }
        : null);
      return;
    }
    const p = platforms.find((x) => x.id === platformSelect.value);
    renderFieldInfo(platformInfo, p || null);
    const unknown = (p && Array.isArray(p.unknown) ? p.unknown : []) as string[];
    if (unknown.length) platformInfo.appendChild(unknownMark(unknown));
  }

  async function loadEngines() {
    try {
      const res = await fetch(`/api/engines?${langParam()}`);
      const data = await res.json();
      engines = Array.isArray(data.engines) ? data.engines : [];
    } catch (e) {
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
    if (e && e.viewer && window.OptiViewer && window.OptiViewer.useViewer) {
      window.OptiViewer.useViewer(e.viewer);
    }
  }

  function syncEngineToPlatform() {
    if (!engines.length) return;
    const p = platforms.find((x) => x.id === platformSelect.value);
    const wanted = p && p.engine;
    if (wanted && [...engineSelect.options].some((o) => o.value === wanted)) engineSelect.value = wanted;
    updateEngineDescription();
  }

  function syncPlatformsToEngine() {
    if (!engines.length || !platforms.length) return;
    const engineId = engineSelect.value;
    const titleOfEngine = (id: string) => (engines.find((x) => x.id === id) || ({} as EngineDto)).title || id;
    const fits = (p: PlatformDto) => !p.engine || p.engine === engineId;
    const chosen = platformSelect.value;

    platformSelect.innerHTML = '';
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
    const текущая = platforms.find((x) => x.id === platformSelect.value);
    if (текущая && текущая.engine && текущая.engine !== engineSelect.value) {
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
    syncEngineToPlatform();
    syncPlatformsToEngine();
    await loadExtensions(platformSelect.value);
    applyPlatformChoice();
    updateRunButtonState();
    logMessage('info', t('log.platform', { id: platformSelect.value }));
  });

  const OPT_GROUPS: Array<{ titleKey: string; kind: string; ids?: string[]; when?: () => boolean }> = [
    { titleKey: 'group.cleanup', kind: 'checks', ids: ['safe', 'strip-colors'] },
    { titleKey: 'group.structural', kind: 'checks', ids: ['join', 'instance'] },
    { titleKey: 'group.geometry', kind: 'geometry' },
    { titleKey: 'group.textures', kind: 'checks', ids: ['ktx2', 'webp'] },
    { titleKey: 'group.textureSize', kind: 'textureSize', ids: ['resize-512', 'resize-1024', 'resize-2048', 'resize-4096'] },
    { titleKey: 'group.animation', kind: 'checks', ids: ['resample'] },
    {
      titleKey: 'group.interactivity',
      kind: 'checks',
      ids: ['strip-dead-interactivity'],
      when: () => deadInteractiveParts() > 0,
    },
  ];

  function uvWithoutTextures(): number {
    const m = modelInspect && (modelInspect.metrics as any);
    return m && typeof m.uvWithoutTextures === 'number' ? m.uvWithoutTextures : 0;
  }

  function deadInteractiveParts(): number {
    const info = modelInspect && (modelInspect as any).interactivity;
    return info && typeof info.silent === 'number' ? info.silent : 0;
  }
  let needsDecoder = new Set();
  const rememberDecoders = (list: ExtensionDto[] | null | undefined) => {
    needsDecoder = new Set((list || []).filter((e: ExtensionDto) => e && e.needsDecoder).map((e: ExtensionDto) => e.id));
  };

  function clearExclusivePartners(id: string) {
    for (const { members } of exclusiveGroups) {
      if (!members.includes(id)) continue;
      for (const other of members) {
        if (other === id) continue;
        const box = document.getElementById(`ext-${other}`) as HTMLInputElement | null;
        if (box && box.checked) {
          box.checked = false;
          box.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }
  }
  const DECODER_KEYS: Record<string, string> = {
    meshopt: 'decoder.meshopt',
    draco: 'decoder.draco',
    ktx2: 'decoder.ktx2',
    instance: 'decoder.instance',
  };
  const DECODER_NOTE_KEY = 'decoder.legend';

  async function loadExtensions(platformId: string, keep?: UiSelection) {
    extensions = [];
    extensionsList.innerHTML = '';
    infoTip.hide();
    extensionsPanel.classList.add('hidden');
    if (decoderLegend) decoderLegend.classList.add('hidden');
    if (!platformId && !engineSelect.value) return;

    let failure = null;
    let fetched = { extensions: [], exclusiveGroups: [], textureSlots: [], defaults: {} };
    try {
      const res = await fetch(
        `/api/extensions?platform=${encodeURIComponent(platformId)}`
        + `&engine=${encodeURIComponent(engineSelect.value || '')}&${langParam()}`,
      );
      const data = await res.json();
      fetched = {
        extensions: (data && data.extensions) || [],
        exclusiveGroups: (data && data.exclusiveGroups) || [],
        textureSlots: (data && data.textureSlots) || [],
        defaults: (data && data.defaults) || {},
      };
    } catch (e) {
      failure = String(((e as Error) && (e as Error).message) || e);
    }

    if (platformSelect.value !== platformId) return;

    extensions = fetched.extensions;
    exclusiveGroups = fetched.exclusiveGroups;
    setTextureSlots(fetched.textureSlots);
    platformDefaults = fetched.defaults;
    rememberDecoders(extensions);

    if (failure) {
      showExtensionsUnavailable('opts.noServer', { error: failure });
      return;
    }
    if (!extensions.length) {
      showExtensionsUnavailable('opts.empty', { platform: platformId });
      return;
    }

    renderExtensionsPanel(keep);
  }

  function renderExtensionsPanel(keep?: UiSelection) {
    extensionsList.innerHTML = '';
    infoTip.hide();
    const byId = Object.fromEntries(extensions.map((e) => [e.id, e]));
    for (const group of OPT_GROUPS) {
      if (group.when && !group.when()) continue;
      const section = group.kind === 'geometry'
        ? renderGeometryGroup(byId)
        : group.kind === 'textureSize'
          ? renderTextureSizeGroup(group, byId)
          : renderCheckGroup(group, byId);
      if (section) extensionsList.appendChild(section);
    }
    if (decoderLegend) decoderLegend.classList.toggle('hidden', !extensions.some((e) => needsDecoder.has(e.id)));
    extensionsPanel.classList.remove('hidden');
    applyDetection(keep);
    updateRunButtonState();
  }

  function optSection(title: string) {
    const sec = document.createElement('div');
    sec.className = 'opt-section';
    const h = document.createElement('div');
    h.className = 'opt-section-title';
    h.textContent = title;
    sec.appendChild(h);
    return sec;
  }

  const SOURCE_MARKERS: Record<string, string> = {
    meshopt: 'EXT_meshopt_compression',
    draco: 'KHR_draco_mesh_compression',
    quantize: 'KHR_mesh_quantization',
    ktx2: 'KHR_texture_basisu',
    webp: 'EXT_texture_webp',
    instance: 'EXT_mesh_gpu_instancing',
  };

  function sourceTechnologies() {
    const present = new Set((modelInspect && modelInspect.extensions) || []);
    return Object.entries(SOURCE_MARKERS)
      .filter(([id, ext]) => present.has(ext) || !!(lastDetection && lastDetection[id]))
      .map(([id]) => id);
  }

  function decoderWarning(id?: string) {
    const w = document.createElement('span');
    w.className = 'ext-decoder-warn icon-badge';
    w.textContent = '?';
    const note = t((id && DECODER_KEYS[id]) || DECODER_NOTE_KEY);
    w.title = note;
    w.setAttribute('aria-label', note);
    return w;
  }

  const infoTip = (() => {
    const SHOW_DELAY_MS = 220;
    const GAP = 6;
    const EDGE = 8;
    let el: HTMLElement | null = null;
    let owner: HTMLElement | null = null;
    let timer = 0;

    function node() {
      if (el) return el;
      el = document.createElement('div');
      el.className = 'ext-tip hidden';
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
      return el;
    }

    function fill(tip: HTMLElement, ext: ExtensionDto) {
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
      if (ext.source) {
        const p = document.createElement('p');
        p.className = 'ext-impact';
        p.textContent = t('ext.origin', { text: ext.source });
        tip.appendChild(p);
      }
      return tip.childNodes.length > 0;
    }

    function place(tip: HTMLElement, btn: HTMLElement) {
      const panel = btn.closest('.inspector') || document.documentElement;
      const p = panel.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      tip.style.maxWidth = `${Math.max(180, p.width - EDGE * 2)}px`;
      tip.classList.remove('hidden');
      const t = tip.getBoundingClientRect();
      const left = Math.min(Math.max(p.left + EDGE, b.right - t.width), p.right - t.width - EDGE);
      const below = b.bottom + GAP;
      const fitsBelow = below + t.height <= window.innerHeight - EDGE;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(fitsBelow ? below : Math.max(EDGE, b.top - t.height - GAP))}px`;
    }

    function show(btn: HTMLElement, ext: ExtensionDto) {
      const tip = node();
      if (!fill(tip, ext)) return;
      owner = btn;
      place(tip, btn);
    }

    return {
      isOpenFor: (btn: HTMLElement) => owner === btn,
      hide() {
        clearTimeout(timer);
        timer = 0;
        owner = null;
        if (el) el.classList.add('hidden');
      },
      showNow(btn: HTMLElement, ext: ExtensionDto) {
        clearTimeout(timer);
        timer = 0;
        show(btn, ext);
      },
      showDelayed(btn: HTMLElement, ext: ExtensionDto) {
        clearTimeout(timer);
        timer = setTimeout(() => show(btn, ext), SHOW_DELAY_MS);
      },
    };
  })();

  window.addEventListener('scroll', () => infoTip.hide(), true);
  window.addEventListener('resize', () => infoTip.hide());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') infoTip.hide(); });
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as Element).closest('.ext-info-btn')) infoTip.hide();
  });

  function infoButton(ext: ExtensionDto) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ext-info-btn';
    btn.textContent = '📖';
    btn.setAttribute('aria-label', t('ext.details', { name: ext.title || ext.id }));
    btn.addEventListener('mouseenter', () => infoTip.showDelayed(btn, ext));
    btn.addEventListener('mouseleave', () => infoTip.hide());
    btn.addEventListener('focus', () => infoTip.showNow(btn, ext));
    btn.addEventListener('blur', () => infoTip.hide());
    btn.addEventListener('click', () => {
      if (infoTip.isOpenFor(btn)) infoTip.hide();
      else infoTip.showNow(btn, ext);
    });
    return btn;
  }

  function renderGeometryGroup(byId: Record<string, ExtensionDto>) {
    const members = geometryMembers();
    const opts = members
      .filter((v) => byId[v])
      .map((v) => ({ v, ext: byId[v]!, label: byId[v]!.title }));
    if (!opts.length) return null;
    const sec = optSection(t('group.geometry'));
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
        if (checkbox.checked) geometryChoice = o.v;
        else if (geometryChoice === o.v) geometryChoice = 'none';
        syncGeometryRadio();
        onOptionChanged();
      });
      const text = document.createElement('span');
      text.className = 'opt-radio-text';
      text.textContent = o.label!;
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

  function sourceTextureSide(): number | null {
    const px = modelInspect && modelInspect.metrics && (modelInspect.metrics as any).textureMaxSize;
    return typeof px === 'number' ? px : null;
  }

  function resizeTargetOf(id: string): number {
    const m = /^resize-(\d+)$/.exec(id);
    return m ? Number(m[1]) : 0;
  }

  function renderTextureSizeGroup(
    group: { ids?: string[]; titleKey: string; [key: string]: any },
    byId: Record<string, ExtensionDto>,
  ) {
    let opts = (group.ids || []).map((id) => byId[id]).filter(Boolean) as ExtensionDto[];
    if (!opts.length) return null;

    const side = sourceTextureSide();
    if (side !== null) {
      if (side === 0) return null;
      opts = opts.filter((ext) => resizeTargetOf(ext.id) < side);
      if (!opts.length) return null;
    }
    const sec = optSection(t(group.titleKey));

    const wrap = document.createElement('div');
    wrap.className = 'select-wrap';

    const select = document.createElement('select');
    select.id = 'texture-size-select';
    const none = document.createElement('option');
    none.value = 'none';
    none.textContent = t('textureSize.none');
    select.appendChild(none);
    for (const ext of opts) {
      const option = document.createElement('option');
      option.value = ext.id;
      option.textContent = ext.title || ext.id;
      select.appendChild(option);
    }
    select.value = textureSizeChoice;

    const info = document.createElement('span');
    info.className = 'section-info';
    const refreshInfo = () => {
      info.textContent = '';
      const ext = opts.find((o) => o.id === select.value);
      if (ext && (ext.description || ext.impact)) info.appendChild(infoButton(ext));
    };
    refreshInfo();

    select.addEventListener('change', () => {
      textureSizeChoice = select.value;
      refreshInfo();
      onOptionChanged();
    });

    wrap.appendChild(select);
    wrap.appendChild(info);
    sec.appendChild(wrap);
    return sec;
  }

  function renderCheckGroup(group: { ids?: string[]; [key: string]: any }, byId: Record<string, ExtensionDto>) {
    const items = group.ids!.map((id: string) => byId[id]).filter(Boolean) as ExtensionDto[];
    if (!items.length) return null;
    const sec = optSection(t(group.titleKey));
    for (const ext of items) sec.appendChild(buildExtensionRow(ext));
    return sec;
  }

  function buildExtensionRow(ext: ExtensionDto) {
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
      if (checkbox.checked) clearExclusivePartners(ext.id);
      toggleKtx2Mode(!!((document.getElementById('ext-ktx2') || {}) as HTMLInputElement).checked);
      toggleWebpQuality(!!((document.getElementById('ext-webp') || {}) as HTMLInputElement).checked);
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

    if (ext.id === 'safe' && uvWithoutTextures() > 0) {
      const sub = extensions.find((e) => e.id === 'keep-unused-uv');
      if (sub) {
        const box = document.createElement('div');
        box.className = 'ext-suboption';
        box.classList.toggle('hidden', !checkbox.checked);

        const subLabel = document.createElement('label');
        subLabel.className = 'ext-label';
        const keep = document.createElement('input');
        keep.type = 'checkbox';
        keep.className = 'ext-subcheck';
        keep.id = SUB_UV_ID;
        keep.checked = true;
        keep.addEventListener('change', () => { rememberSelection(); onOptionChanged(); });
        const text = document.createElement('span');
        text.textContent = sub.title || sub.id;
        subLabel.append(keep, text);

        box.appendChild(subLabel);
        box.appendChild(infoButton(sub));
        row.appendChild(box);
        checkbox.addEventListener('change', toggleUvSubRow);
      }
    }

    if (ext.id === 'ktx2') {
      const mode = document.createElement('details');
      mode.className = 'ktx2-mode hidden';
      const summary = document.createElement('summary');
      summary.textContent = `${t('ktx2.mode')} `;
      const modeCurrent = document.createElement('span');
      modeCurrent.className = 'ktx2-mode-current';
      summary.appendChild(modeCurrent);
      mode.appendChild(summary);
      const modeOpts = [
        { v: 'uastc', labelKey: 'ktx2.mode.uastc', short: 'UASTC' },
        { v: 'mixed', labelKey: 'ktx2.mode.etc1s', short: 'ETC1S' },
      ];
      modeCurrent.textContent = (modeOpts.find((o) => o.v === ktx2Mode) || modeOpts[0]!).short;
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
          summary.querySelector('.ktx2-mode-current')!.textContent = o.short;
          updateRunButtonState();
          rememberSelection();
          logMessage('debug', t('log.ktx2mode', { mode: o.short }));
        });
        optLabel.appendChild(radio);
        optLabel.appendChild(document.createTextNode(' ' + t(o.labelKey)));
        mode.appendChild(optLabel);
      }
      row.appendChild(mode);
      checkbox.addEventListener('change', () => mode.classList.toggle('hidden', !checkbox.checked));
    }

    if (ext.id === 'webp') {
      const box = document.createElement('details');
      box.className = 'webp-quality hidden';
      const summary = document.createElement('summary');
      summary.textContent = `${t('opt.webpQuality')} `;
      const current = document.createElement('span');
      current.className = 'webp-quality-current';
      summary.appendChild(current);
      box.appendChild(summary);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'webp-quality-slider';
      slider.min = '0';
      slider.max = '100';
      slider.step = '5';
      slider.value = String(webpQuality);
      const label = (v: number) => t('opt.webpQuality.share', { share: v });
      current.textContent = label(webpQuality);
      slider.addEventListener('input', () => {
        webpQuality = Number(slider.value);
        current.textContent = label(webpQuality);
      });
      slider.addEventListener('change', () => {
        updateRunButtonState();
        rememberSelection();
        logMessage('debug', t('log.webpQuality', { share: webpQuality }));
      });
      box.appendChild(slider);
      row.appendChild(box);
      checkbox.addEventListener('change', () => box.classList.toggle('hidden', !checkbox.checked));
    }

    return row;
  }

  function чисткаБудет(): boolean {
    return !!(document.getElementById('ext-safe') as HTMLInputElement | null)?.checked
      || !!(document.getElementById('ext-join') as HTMLInputElement | null)?.checked
      || geometryChoice !== 'none';
  }

  function toggleUvSubRow() {
    const box = subUvBox()?.closest('.ext-suboption');
    if (box) box.classList.toggle('hidden', !чисткаБудет());
  }

  function toggleKtx2Mode(show: boolean) {
    const cb = document.getElementById('ext-ktx2');
    const row = cb && cb.closest('.ext-row');
    const mode = row && row.querySelector('.ktx2-mode');
    if (mode) mode.classList.toggle('hidden', !show);
  }

  function toggleWebpQuality(show: boolean) {
    const cb = document.getElementById('ext-webp');
    const row = cb && cb.closest('.ext-row');
    const box = row && row.querySelector('.webp-quality');
    if (box) box.classList.toggle('hidden', !show);
  }

  const SUB_UV_ID = 'ext-keep-unused-uv';
  const SUB_UV_FEATURE = 'keep-unused-uv';
  const subUvBox = () => document.getElementById(SUB_UV_ID) as HTMLInputElement | null;
  const keepingUnusedUv = () => {
    const b = subUvBox();
    if (!b || b.checked) return false;
    return !b.closest('.ext-suboption')?.classList.contains('hidden');
  };

  function getSelectedFeatures() {
    const feats = [];
    if (keepingUnusedUv()) feats.push(SUB_UV_FEATURE);
    if (geometryChoice === 'meshopt') feats.push('meshopt');
    else if (geometryChoice === 'draco') feats.push('draco');
    else if (geometryChoice === 'quantize') feats.push('quantize');
    if (textureSizeChoice !== 'none') feats.push(textureSizeChoice);
    for (const cb of extensionsList.querySelectorAll<HTMLInputElement>('.ext-checkbox:checked')) feats.push(cb.value);
    return feats;
  }

  function setCheck(id: string, val: boolean) {
    const cb = document.getElementById(`ext-${id}`);
    if (cb) (cb as HTMLInputElement).checked = val;
  }

  function dirOf(p: string) {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i + 1);
  }

  function groupPacks(items: DroppedFile[]) {
    const models = items.filter((it) => MODEL_RE.test(it.path));
    const assets = items.filter((it) => !MODEL_RE.test(it.path));
    const claimed = new Set<DroppedFile>();
    const packs = models.map((m) => {
      if (!/\.(gltf|fbx|obj)$/i.test(m.path)) return { file: m.file, pack: [] as PackFile[] };
      const dir = dirOf(m.path);
      const pack: PackFile[] = [];
      for (const a of assets) {
        if (!a.path.startsWith(dir)) continue;
        claimed.add(a);
        pack.push({ path: a.path.slice(dir.length), file: a.file });
      }
      return { file: m.file, pack };
    });
    return { packs, orphans: assets.filter((a) => !claimed.has(a)) };
  }

  const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

  let TEXTURE_SLOTS: Array<{ slot: string; re: RegExp }> = [];

  function setTextureSlots(wire: Array<{ slot: string; pattern: string; flags: string }>) {
    const built = [];
    for (const s of wire || []) {
      try {
        built.push({ slot: s.slot, re: new RegExp(s.pattern, s.flags) });
      } catch {
        console.warn('[textures] негодный признак имени для слота', s && s.slot);
      }
    }
    TEXTURE_SLOTS = built;
  }

  function slotOf(filePath: string): string | null {
    const base = String(filePath).slice(String(filePath).lastIndexOf('/') + 1);
    for (const { slot, re } of TEXTURE_SLOTS) if (re.test(base)) return slot;
    return null;
  }

  function attachTextures(rec: ModelEntry, images: DroppedFile[]) {
    const have = new Set(rec.pack.map((a) => String(a.path).toLowerCase()));
    let added = 0;
    const replacing = new Set<string>();
    for (const img of images) {
      const key = String(img.path).toLowerCase();
      if (have.has(key)) continue;
      have.add(key);
      const slot = slotOf(img.path);
      if (slot) replacing.add(slot);
      rec.pack.push({ path: img.path, file: img.file });
      added++;
    }
    if (!added) {
      logMessage('info', t('log.texturesAlready', { name: rec.file.name }));
      return;
    }

    let dropped = 0;
    if (replacing.size) {
      const fresh = new Set(images.map((i) => String(i.path).toLowerCase()));
      rec.pack = rec.pack.filter((a) => {
        const p = String(a.path);
        if (fresh.has(p.toLowerCase()) || !IMAGE_RE.test(p)) return true;
        const slot = slotOf(p);
        if (!slot || !replacing.has(slot)) return true;
        dropped++;
        return false;
      });
    }

    rec.packSourceId = null;
    rec.packChecked = false;
    rec.packMissing = 0;
    if (rec.id === activeModelId) clearResults(); else rec.state = {};

    chosenFileLabel.textContent = '';
    logMessage('info', t('log.texturesAttached', { n: added, name: rec.file.name }));
    if (dropped) logMessage('info', t('log.texturesReplaced', { n: dropped }));
    renderModelList();
    if (rec.id === activeModelId) void loadActive(rec);
  }

  async function handleFiles(list: DroppedFile[]) {
    const items = Array.from(list || []);
    if (!items.length) return;
    const files = items.map((it) => it.file);

    const { packs, orphans } = groupPacks(items);

    if (!packs.length && orphans.length) {
      const rec = activeModel();
      const images = orphans.filter((o) => IMAGE_RE.test(o.path));
      if (rec && images.length) {
        const rest = orphans.length - images.length;
        attachTextures(rec, images);
        if (rest) logMessage('warn', t('log.rejectedMany', { n: rest }));
        return;
      }
    }

    const badCount = orphans.length;
    if (badCount) {
      chosenFileLabel.textContent = t('dropzone.rejected');
      logMessage('warn', badCount === 1 && files.length === 1
        ? t('log.rejected', { name: files[0]!.name })
        : t('log.rejectedMany', { n: badCount }));
    }
    if (!packs.length) {
      if (!models.length) runBtn.disabled = true;
      return;
    }

    const added = packs.map((p) => addModel(p.file, p.pack));
    const first = added[0]!;
    activeModelId = first.id;
    applyModelState(first.state);
    renderModelList();
    if (packs.length > 1) logMessage('info', t('log.loadedMany', { n: packs.length }));
    const packTotal = packs.reduce((sum, p) => sum + p.pack.length, 0);
    if (packTotal) logMessage('info', t('log.packAssets', { n: packTotal }));
    await loadActive(first);
  }

  async function loadActive(rec: ModelEntry) {
    const file = rec.file;
    chosenFileLabel.textContent = '';
    runBtn.disabled = false;
    await checkPackComplete(rec);
    warnIfHeavy(rec);
    logMessage('info', t('log.loaded', { name: file.name, size: fmtBytes(sourceBytesOf(rec)) }));
    if (stageHint) stageHint.classList.add('hidden');
    clearResults();
    if (window.OptiViewer) {
      setBusy('preview-original', 'busy.loading');
      try {
        const info = await window.OptiViewer.loadOriginal(file, rec.pack);
        if (selectedFile() !== file) return;
        originalStats = ((info as any) && (info as any).stats) || null;
        renderSourceStats(sourceBytesOf(rec));
        lastDetection = ((info as any) && (info as any).detected) || null;
        const found = Object.keys(lastDetection || {}).filter((k) => lastDetection![k]);
        if (found.length) logMessage('info', t('log.foundCompression', { list: found.join(', ') }));
        applyDetection();
      } finally {
        setBusy('preview-original', null);
      }
    }
    inspectModel(file);
  }

  function warnIfHeavy(rec: ModelEntry | null) {
    if (!rec || rec.heavyWarned) return;
    const bytes = sourceBytesOf(rec);
    if (bytes <= COMFORT_BYTES) return;
    rec.heavyWarned = true;
    logMessage('warn', t('log.tooHeavy', { size: fmtBytes(bytes), limit: fmtBytes(COMFORT_BYTES) }));
  }

  async function checkPackComplete(rec: ModelEntry | null) {
    if (!rec || rec.packChecked || !/\.gltf$/i.test(rec.file.name)) return;
    rec.packChecked = true;
    let json: any;
    try {
      json = JSON.parse(await rec.file.text());
    } catch (e) {
      return;
    }
    const key = (p: string) => (window.OptiViewer ? window.OptiViewer.assetKey(p) : String(p).toLowerCase());
    const have = new Set(rec.pack.map((a) => key(a.path)));
    const missing: string[] = [];
    for (const item of [...(json.buffers || []), ...(json.images || [])]) {
      const uri = item && item.uri;
      if (!uri || typeof uri !== 'string' || /^data:/i.test(uri)) continue;
      const k = key(uri);
      if (!have.has(k) && !missing.includes(uri)) missing.push(uri);
    }
    if (!missing.length) return;
    rec.packMissing = missing.length;
    logMessage('warn', missing.length === 1
      ? t('log.packMissing', { name: missing[0]! })
      : t('log.packMissingMany', { n: missing.length }));
  }

  async function uploadPack(rec: ModelEntry | null): Promise<string | null> {
    if (!rec || !rec.pack || !rec.pack.length) return null;
    if (rec.packSourceId) return rec.packSourceId;
    let sourceId: string | null = null;
    for (const item of rec.pack) {
      const q = sourceId ? `?source=${encodeURIComponent(sourceId)}` : '';
      const res = await fetch(`/api/asset${q}`, {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(item.path), 'Content-Type': 'application/octet-stream' },
        body: item.file,
      });
      if (!res.ok) {
        let detail = '';
        try { detail = ((await res.json()) || {}).error || ''; } catch (e) {  }
        logMessage('warn', t('log.packUploadFailed', { name: item.path, error: detail || String(res.status) }));
        break;
      }
      const data = await res.json();
      if (data && data.sourceId) sourceId = data.sourceId;
    }
    rec.packSourceId = sourceId;
    return sourceId;
  }

  async function inspectModel(file: File) {
    modelInspect = null;
    setModelIssue(null);
    updateInspectButtons();
    try {
      const rec = models.find((m) => m.file === file) || null;
      const packId = await uploadPack(rec);
      if (selectedFile() !== file) return;
      const q = `?${langParam()}${packId ? `&source=${encodeURIComponent(packId)}` : ''}`;
      const res = await fetch(`/api/inspect${q}`, {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (selectedFile() !== file) return;
      if (!res.ok) {
        let detail = '';
        try { detail = ((await res.json()) || {}).error || ''; } catch (e) {  }
        setModelIssue(rec && rec.packMissing
          ? { kind: 'incomplete', count: rec.packMissing }
          : { kind: 'unreadable', detail });
        logMessage('warn', t('log.inspectFailed', { status: res.status }));
        return;
      }
      const data = await res.json();
      if (selectedFile() !== file) return;
      modelInspect = data;
      if (!lastResult) renderSourceStats(sourceBytesOf(rec));
      if (extensions.length) renderExtensionsPanel(currentSelection());
      if (data.sourceId) currentSourceId = data.sourceId;
      if (!metadataWindow.classList.contains('hidden')) renderMetadataWindow();
      if (!validationWindow.classList.contains('hidden')) renderValidationWindow();
      const n = (data.validation || []).filter((m: any) => !m.explainedBy).length;
      const errors = (data.validation || []).filter((m: any) => !m.explainedBy && m.severity === 0).length;
      setModelIssue(errors ? { kind: 'validation', count: errors } : null);
      updateInspectButtons();
      logMessage('info', data.sourceFormat
        ? t('log.sourceNotValidated', { format: data.sourceFormat })
        : t('log.sourceInspected', { n }));
      logBlindSpots(data.validation);
    } catch (e) {
      setModelIssue({ kind: 'unreadable', detail: (e as Error).message });
      logMessage('warn', t('log.inspectUnavailable', { error: (e as Error).message }));
    }
  }

  function setModelIssue(issue: ModelIssue | null) {
    modelIssue = issue || null;
    renderModelList();
  }

  function issueTitle(issue: ModelIssue) {
    if (!issue) return '';
    if (issue.kind === 'incomplete') return t('issue.incomplete', { n: issue.count });
    if (issue.kind === 'unreadable') {
      return issue.detail
        ? t('issue.unreadable.reason', { detail: issue.detail })
        : t('issue.unreadable');
    }
    return t('issue.validation', { n: issue.count });
  }

  function updateInspectButtons() {
    btnMetadata.disabled = !modelInspect;
    btnValidation.disabled = !modelInspect;
    if (!modelInspect) { setText(btnValidation, 'outliner.validation'); return; }
    const real = (data: InspectDto) => (data.validation || []).filter((m: any) => !m.explainedBy).length;
    const src = real(modelInspect);
    const dst = resultInspect ? real(resultInspect) : null;
    if (!src && !dst) { setText(btnValidation, 'outliner.validation'); return; }
    if (dst === null) setText(btnValidation, 'outliner.validation.count', { n: src });
    else setText(btnValidation, 'outliner.validation.range', { from: src, to: dst });
  }

  async function inspectResult(downloadUrl: string) {
    resultInspect = null;
    updateInspectButtons();
    if (!downloadUrl) return;
    const token = runToken;
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
      const n = (data.validation || []).filter((m: any) => !m.explainedBy).length;
      logMessage('info', n
        ? t('log.resultInspected', { n })
        : t('log.resultInspected', { n: 0 }));
      logBlindSpots(data.validation);
    } catch (e) {
      logMessage('warn', t('log.resultInspectError', { error: (e as Error).message }));
    }
  }

  function applyDetection(keep?: UiSelection) {
    extensionsList.querySelectorAll('.ext-source-badge, .ext-advised-badge, .ext-cost-badge').forEach((b) => b.remove());

    if (keep) restoreSelection(keep);
    else if (selection) restoreSelection(selection);
    else { seedSelection(); selection = currentSelection(); }

    showDetectionBadges();
    if (lastResult) renderCostBadges(lastResult.skipped);
    syncGeometryRadio();
    syncTextureSizeRadio();
    syncKtx2ModeUI();
    toggleKtx2Mode(!!(document.getElementById('ext-ktx2') && (document.getElementById('ext-ktx2') as HTMLInputElement).checked));
    syncWebpQualityUI();
    toggleWebpQuality(!!(document.getElementById('ext-webp') && (document.getElementById('ext-webp') as HTMLInputElement).checked));
    toggleUvSubRow();
    freezeSettings(buildInFlight);
    updateRunButtonState();
  }

  function seedSelection() {
    setCheck('safe', true);
    setCheck('join', true);
    setCheck('strip-colors', false);
    setCheck('ktx2', false);
    ktx2Mode = defaultKtx2Mode();
    webpQuality = WEBP_QUALITY_DEFAULT;
    geometryChoice = 'none';
    textureSizeChoice = 'none';
    const codec = platformCodec();
    if (codec && document.getElementById(`geom-${codec}`)) geometryChoice = codec;
    if (lastDetection) {
      if (!codec && lastDetection.draco) geometryChoice = 'draco';
      else if (!codec && lastDetection.meshopt) geometryChoice = 'meshopt';
      if (lastDetection.ktx2) setCheck('ktx2', true);
      if (hasSharedGeometry()) setCheck('instance', true);
    }
  }

  function hasSharedGeometry() {
    const opp = lastDetection && lastDetection.opportunity;
    return !!(opp && opp.sharedMeshes > 0);
  }

  function applyPlatformChoice() {
    const codec = platformCodec();
    if (!codec || !document.getElementById(`geom-${codec}`) || geometryChoice === codec) return;
    geometryChoice = codec;
    syncGeometryRadio();
    rememberSelection();
  }

  function platformCodec(): string | null {
    if (!platformSelect.value) return null;
    const c = platformDefaults && (platformDefaults as { codec?: string }).codec;
    return c && geometryMembers().includes(c) ? c : null;
  }

  function restoreSelection(saved: UiSelection | null | undefined) {
    geometryChoice = saved!.geometryChoice || 'none';
    if (geometryChoice !== 'none' && !document.getElementById(`geom-${geometryChoice}`)) geometryChoice = 'none';
    textureSizeChoice = saved!.textureSizeChoice || 'none';
    syncTextureSizeRadio();
    ktx2Mode = saved!.ktx2Mode || defaultKtx2Mode();
    webpQuality = saved!.webpQuality === undefined ? WEBP_QUALITY_DEFAULT : saved!.webpQuality;
    for (const cb of extensionsList.querySelectorAll('.ext-checkbox')) {
      (cb as HTMLInputElement).checked = saved!.checked.includes((cb as HTMLInputElement).value);
    }
    const sub = subUvBox();
    if (sub) sub.checked = !saved!.keepUnusedUv;
  }

  function currentSelection() {
    return {
      geometryChoice,
      textureSizeChoice,
      ktx2Mode,
      webpQuality,
      checked: [...extensionsList.querySelectorAll<HTMLInputElement>('.ext-checkbox:checked')].map((cb) => cb.value),
      keepUnusedUv: keepingUnusedUv(),
    };
  }

  function rememberSelection() {
    selection = currentSelection();
  }

  async function relabelExtensions() {
    const keep = extensionsList.querySelector('.ext-checkbox') ? currentSelection() : undefined;
    await loadExtensions(platformSelect.value, keep);
  }

  function showDetectionBadges() {
    for (const id of sourceTechnologies()) badgeOption(id);
    if (lastDetection && !sourceTechnologies().includes('instance') && hasSharedGeometry()) {
      badgeAdvised('instance', lastDetection.opportunity);
    }
  }

  function renderCostBadges(skipped: ReportEntryDto[] | null | undefined) {
    extensionsList.querySelectorAll('.ext-cost-badge').forEach((b) => b.remove());
    for (const s of skipped || []) {
      if (!s || s.kind !== 'cost' || !s.feature) continue;
      const cb = document.getElementById(`ext-${s.feature}`);
      const container = (cb && cb.closest('.ext-row'))
        || document.querySelector(`.opt-radio-row[data-geom="${s.feature}"]`);
      if (!container || container.querySelector('.ext-cost-badge')) continue;
      const anchor = container.querySelector('.ext-label') || container.querySelector('.opt-radio-text') || container;
      const badge = document.createElement('span');
      badge.className = 'ext-cost-badge';
      badge.textContent = '!';
      badge.title = s.text;
      badge.setAttribute('aria-label', s.text);
      anchor.appendChild(badge);
    }
  }

  function badgeAdvised(id: string, opp?: unknown) {
    const cb = document.getElementById(`ext-${id}`);
    const container = cb && cb.closest('.ext-row');
    if (!container || container.querySelector('.ext-advised-badge')) return;
    const anchor = container.querySelector('.ext-label') || container;
    const badge = document.createElement('span');
    badge.className = 'ext-advised-badge';
    badge.textContent = t('ext.advised');
    badge.title = t('ext.advised.shared', { meshes: (opp as any).sharedMeshes, nodes: (opp as any).sharedNodes });
    anchor.appendChild(badge);
  }

  function syncGeometryRadio() {
    for (const row of extensionsList.querySelectorAll('.opt-radio-row[data-geom]')) {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) (cb as HTMLInputElement).checked = ((row as HTMLElement).dataset.geom === geometryChoice);
    }
  }

  function syncTextureSizeRadio() {
    const select = document.getElementById('texture-size-select') as HTMLSelectElement | null;
    if (!select) return;
    if (![...select.options].some((o) => o.value === textureSizeChoice)) textureSizeChoice = 'none';
    select.value = textureSizeChoice;
  }

  function syncKtx2ModeUI() {
    const radio = document.querySelector(`input[name="ktx2mode"][value="${ktx2Mode}"]`);
    if (radio) (radio as HTMLInputElement).checked = true;
    const cur = document.querySelector('.ktx2-mode-current');
    if (cur) cur.textContent = ktx2Mode === 'mixed' ? 'ETC1S' : 'UASTC';
  }

  function syncWebpQualityUI() {
    const slider = document.querySelector('.webp-quality-slider');
    if (slider) (slider as HTMLInputElement).value = String(webpQuality);
    const cur = document.querySelector('.webp-quality-current');
    if (cur) cur.textContent = t('opt.webpQuality.share', { share: webpQuality });
  }

  function badgeOption(id: string) {
    const cb = document.getElementById(`ext-${id}`);
    const container = (cb && cb.closest('.ext-row'))
      || document.querySelector(`.opt-radio-row[data-geom="${id}"]`);
    if (!container) return;
    addSourceBadge(container as HTMLElement);
  }

  function addSourceBadge(container: HTMLElement) {
    if (!container || container.querySelector('.ext-source-badge')) return;
    const anchor = container.querySelector('.ext-label') || container.querySelector('.opt-radio-text') || container;
    const badge = document.createElement('span');
    badge.className = 'ext-source-badge';
    badge.textContent = t('ext.source');
    badge.title = t('ext.source.title');
    anchor.appendChild(badge);
  }

  function sourceBytesOf(rec: ModelEntry | null) {
    if (!rec) return 0;
    return rec.pack.reduce((sum, a) => sum + a.file.size, rec.file.size);
  }

  function renderSourceStats(fileSize: number) {
    statsBefore.innerHTML = '';
    const m = modelInspect && modelInspect.metrics;
    const rows = m
      ? [
        ['FILE', fmtBytes(fileSize || (m.fileBytes != null ? m.fileBytes : 0))],
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
    for (const [k, v] of rows) statsBefore.appendChild(hudLine(k!, v!, null));
  }

  async function resultAlive(url: string | null | undefined): Promise<boolean> {
    if (!url) return true;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  function forgetResult(rec: ModelEntry) {
    if (rec.id === activeModelId) { clearResults(); return; }
    for (const key of ['lastResult', 'lastExplain', 'lastFail', 'currentSourceId',
      'lastBuildSignature', 'resultInspect', 'resultDownloadUrl', 'resultExportBase']) {
      rec.state[key] = null;
    }
  }

  async function dropVanishedResults(): Promise<number> {
    const gone: ModelEntry[] = [];
    for (const rec of models) {
      const url = rec.id === activeModelId ? resultDownloadUrl : rec.state.resultDownloadUrl;
      if (!url) continue;
      if (await resultAlive(url)) continue;
      gone.push(rec);
    }
    if (!gone.length) return 0;
    for (const rec of gone) forgetResult(rec);
    exportWindow.classList.add('hidden');
    renderModelList();
    updateSummaryButton();
    updateRunButtonState();
    logMessage('warn', gone.length === 1
      ? t('log.resultGone', { name: gone[0]!.file.name })
      : t('log.resultGoneMany', { n: gone.length }));
    return gone.length;
  }

  function clearResults() {
    lastResult = null;
    lastExplain = null;
    lastFail = null;
    currentSourceId = null;
    lastBuildSignature = null;
    resultInspect = null;
    runToken++;
    updateInspectButtons();
    resultDownloadUrl = null;
    downloadBtn.classList.add('hidden');
    exportWindow.classList.add('hidden');
    irreversibleWarning.classList.add('hidden');
    renderIntegrity(null);
    failBanner.classList.add('hidden');
    setText(runBtn, 'btn.build');
    statsAfter.innerHTML = '';
    [summarySection, analysisSection, budgetsSection, warningsSection,
      appliedSection, skippedSection, validationSection].forEach((s) => s.classList.add('hidden'));
  }

  function syncDropzone() {
    dropzone.classList.toggle('hidden', modelList.children.length > 0);
  }

  const pickedModels = () => models.filter((m) => m.picked);

  const batchMode = () => models.length > 1;

  function needsBuild(rec: ModelEntry) {
    const signature = rec.id === activeModelId ? lastBuildSignature : rec.state.lastBuildSignature;
    return signature == null || signature !== currentSettingsSignature();
  }

  const modelsToBuild = () => pickedModels().filter(needsBuild);

  function renderBatchBar() {
    batchBar.classList.toggle('hidden', !batchMode());
    if (!batchMode()) return;
    const n = pickedModels().length;
    setText(batchCount, 'batch.count', { n, total: models.length });
    batchToggle.checked = n === models.length;
    batchToggle.indeterminate = n > 0 && n < models.length;
    batchToggle.title = t('batch.toggle');
    batchToggle.setAttribute('aria-label', t('batch.toggle'));
    batchRemoveBtn.disabled = n === 0;
  }

  function renderModelList() {
    modelList.innerHTML = '';
    for (const rec of models) {
      const li = document.createElement('li');
      li.className = 'model-item' + (rec.id === activeModelId ? ' selected' : '');
      li.dataset.modelId = rec.id;

      if (batchMode()) {
        const pick = document.createElement('input');
        pick.type = 'checkbox';
        pick.className = 'model-pick';
        pick.checked = rec.picked;
        pick.title = t('batch.pick');
        pick.setAttribute('aria-label', `${t('batch.pick')}: ${rec.file.name}`);
        pick.addEventListener('click', (e) => e.stopPropagation());
        pick.addEventListener('change', () => {
          rec.picked = pick.checked;
          renderBatchBar();
          updateRunButtonState();
        });
        li.appendChild(pick);
      }
      const icon = document.createElement('span');
      icon.className = 'model-icon';
      const result = rec.id === activeModelId ? lastResult : rec.state.lastResult;
      const built = !!result && result.status !== 'fail';
      icon.textContent = built ? '✓' : '▣';
      if (built) icon.title = t('models.built');
      const name = document.createElement('span');
      name.className = 'model-name';
      name.textContent = rec.file.name;
      name.title = rec.file.name;
      const size = document.createElement('span');
      size.className = 'model-size';
      const bytes = sourceBytesOf(rec);
      size.textContent = fmtBytes(bytes);
      if (rec.pack.length) size.title = t('models.packSize', { n: rec.pack.length });
      if (bytes > COMFORT_BYTES) {
        size.classList.add('is-heavy');
        size.title = t('models.tooHeavy', { limit: fmtBytes(COMFORT_BYTES) });
      }

      const remove = document.createElement('button');
      remove.className = 'model-remove';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = t('models.remove');
      remove.setAttribute('aria-label', t('models.remove'));
      remove.addEventListener('click', (e) => { e.stopPropagation(); removeModel(rec.id); });

      li.appendChild(icon);
      li.appendChild(name);
      const issue = rec.id === activeModelId ? modelIssue : rec.state.modelIssue;
      if (issue) {
        const alert = document.createElement('span');
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
    renderBatchBar();
    updateSummaryButton();
    if (!summaryWindow.classList.contains('hidden')) renderSummaryWindow();
    syncDropzone();
    updateRunButtonState();
  }

  batchRemoveBtn.addEventListener('click', () => {
    const n = pickedModels().length;
    if (!n) return;
    setText(confirmRemoveText, 'batch.remove.text', { n });
    showWindow(confirmRemove);
  });

  confirmRemoveNo.addEventListener('click', () => confirmRemove.classList.add('hidden'));

  confirmRemoveYes.addEventListener('click', () => {
    confirmRemove.classList.add('hidden');
    const doomed = pickedModels().map((m) => m.id);
    for (const id of doomed) removeModel(id);
    logMessage('info', t('log.batchRemoved', { n: doomed.length }));
  });

  batchToggle.addEventListener('change', () => setAllPicked(batchToggle.checked));

  function setAllPicked(picked: boolean) {
    for (const rec of models) rec.picked = picked;
    renderModelList();
  }

  function summaryRows() {
    const rows = [];
    for (const rec of models) {
      const live = rec.id === activeModelId;
      const res = live ? lastResult : rec.state.lastResult;
      const explain = live ? lastExplain : rec.state.lastExplain;
      const fail = live ? lastFail : rec.state.lastFail;
      if (!res) {
        if (!fail) continue;
        rows.push({
          name: rec.file.name,
          failed: true,
          fileBefore: null, fileAfter: null, vramBefore: null, vramAfter: null,
          triangles: null, budget: 'none',
        });
        continue;
      }
      const before = (res.metrics && res.metrics.before) || null;
      const after = (res.metrics && res.metrics.after) || null;
      let budget = 'none';
      for (const c of (explain && explain.budgetChecks) || []) {
        if (c.level === 'over') { budget = 'over'; break; }
        if (c.level === 'warn') budget = 'warn';
        else if (c.level === 'ok' && budget === 'none') budget = 'ok';
      }
      rows.push({
        name: rec.file.name,
        failed: res.status === 'fail',
        fileBefore: sourceBytesOf(rec) || (before ? before.fileBytes : null),
        fileAfter: after ? after.fileBytes : null,
        vramBefore: before ? before.gpuBytes : null,
        vramAfter: after ? after.gpuBytes : null,
        triangles: after ? after.triangles : null,
        budget,
      });
    }
    return rows;
  }

  function summaryTotal(rows: ReturnType<typeof summaryRows>) {
    let before = 0;
    let after = 0;
    let counted = 0;
    for (const r of rows) {
      if (r.fileBefore == null || r.fileAfter == null) continue;
      before += r.fileBefore;
      after += r.fileAfter;
      counted += 1;
    }
    return { before, after, counted, failed: rows.filter((r) => r.failed).length };
  }

  function updateSummaryButton() {
    batchSummaryBtn.disabled = summaryRows().length === 0;
  }

  batchSummaryBtn.addEventListener('click', () => {
    if (batchSummaryBtn.disabled) return;
    renderSummaryWindow();
    showWindow(summaryWindow);
  });

  function renderSummaryWindow() {
    const rows = summaryRows();
    summaryBody.innerHTML = '';
    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'summary-empty';
      setText(p, 'summary.empty');
      summaryBody.appendChild(p);
      return;
    }

    const table = document.createElement('table');
    table.className = 'summary-table';
    const head = document.createElement('tr');
    for (const key of ['summary.col.model', 'summary.col.before', 'summary.col.after',
      'summary.col.pct', 'summary.col.vram', 'summary.col.tris', 'summary.col.budget']) {
      const th = document.createElement('th');
      setText(th, key);
      head.appendChild(th);
    }
    table.appendChild(head);

    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.failed) tr.className = 'is-failed';
      const cell = (text: string, cls?: string) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        tr.appendChild(td);
        return td;
      };
      cell(r.name, 'summary-name').title = r.name;
      if (r.failed) {
        const td = document.createElement('td');
        td.colSpan = 6;
        setText(td, 'summary.failed');
        tr.appendChild(td);
        table.appendChild(tr);
        continue;
      }
      cell(r.fileBefore != null ? fmtBytes(r.fileBefore) : '—');
      cell(r.fileAfter != null ? fmtBytes(r.fileAfter) : '—');
      cell(r.fileBefore && r.fileAfter ? pctText(r.fileBefore, r.fileAfter) : '—', 'summary-pct');
      cell(r.vramBefore != null && r.vramAfter != null
        ? `${fmtBytes(r.vramBefore)} → ${fmtBytes(r.vramAfter)}` : '—');
      cell(r.triangles != null ? fmtInt(r.triangles) : '—');
      const budget = cell('', `summary-budget is-${r.budget}`);
      setText(budget, `summary.budget.${r.budget}`);
      table.appendChild(tr);
    }
    summaryBody.appendChild(table);

    const total = summaryTotal(rows);
    const foot = document.createElement('p');
    foot.className = 'summary-total';
    setText(foot, 'summary.total', {
      n: total.counted,
      before: fmtBytes(total.before),
      after: fmtBytes(total.after),
      pct: total.before ? pctText(total.before, total.after) : '—',
    });
    summaryBody.appendChild(foot);

    if (total.failed) {
      const bad = document.createElement('p');
      bad.className = 'summary-total is-failed';
      setText(bad, 'summary.totalFailed', { n: total.failed });
      summaryBody.appendChild(bad);
    }
  }

  summarySaveBtn.addEventListener('click', () => {
    const rows = summaryRows();
    if (!rows.length) return;
    const esc = (v: string) => `"${String(v).split('"').join('""')}"`;
    const lines = [[
      t('summary.col.model'), t('summary.col.before'), t('summary.col.after'),
      t('summary.col.pct'), t('summary.col.vram'), t('summary.col.tris'),
      t('summary.col.budget'),
    ].map(esc).join(';')];
    for (const r of rows) {
      lines.push([
        r.name,
        r.fileBefore != null ? String(r.fileBefore) : '',
        r.fileAfter != null ? String(r.fileAfter) : '',
        r.fileBefore && r.fileAfter ? pctText(r.fileBefore, r.fileAfter) : '',
        r.vramBefore != null ? String(r.vramBefore) : '',
        r.triangles != null ? String(r.triangles) : '',
        r.failed ? t('summary.failed') : t(`summary.budget.${r.budget}`),
      ].map(esc).join(';'));
    }
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = t('summary.fileName');
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    logMessage('info', t('log.summarySaved', { n: rows.length }));
  });

  function addModel(file: File, pack: PackFile[] = []) {
    captureActiveModel();
    const rec = { id: `m${++modelSeq}`, file, pack, packSourceId: null, packChecked: false, packMissing: 0, heavyWarned: false, state: {}, picked: true };
    models.push(rec);
    activeModelId = rec.id;
    applyModelState(null);
    return rec;
  }

  async function selectModel(id: string) {
    if (id === activeModelId) return;
    const rec = models.find((m) => m.id === id);
    if (!rec) return;
    captureActiveModel();
    activeModelId = id;
    applyModelState(rec.state);
    renderModelList();
    await showActiveModel();
  }

  function removeModel(id: string) {
    const i = models.findIndex((m) => m.id === id);
    if (i === -1) return;
    const [rec] = models.splice(i, 1);
    releaseSource(rec!.state.currentSourceId
      || (rec!.id === activeModelId ? currentSourceId : null)
      || rec!.packSourceId
      || null);

    if (rec!.id !== activeModelId) { renderModelList(); return; }

    const next = models[i] || models[i - 1] || null;
    activeModelId = next ? next.id : null;
    applyModelState(next ? next.state : null);
    renderModelList();
    if (next) showActiveModel();
    else resetToEmpty();
  }

  function releaseSource(sourceId: string | null) {
    if (!sourceId) return;
    fetch(`/api/source/${encodeURIComponent(sourceId)}`, { method: 'DELETE' })
      .catch(() => {  });
  }

  async function showActiveModel() {
    const rec = activeModel();
    if (!rec) return;

    clearResultPanels();
    await checkPackComplete(rec);
    if (window.OptiViewer) {
      setBusy('preview-original', 'busy.loading');
      try {
        await window.OptiViewer.loadOriginal(rec.file, rec.pack);
      } finally {
        setBusy('preview-original', null);
      }
    }
    renderSourceStats(sourceBytesOf(rec));
    applyDetection();

    updateInspectButtons();
    if (!modelInspect && !modelIssue && !batchInFlight) inspectModel(rec.file);

    await dropVanishedResults();

    if (lastFail) renderFail(lastFail.result, lastFail.explain, true);

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
    if (!metadataWindow.classList.contains('hidden')) renderMetadataWindow();
    if (!validationWindow.classList.contains('hidden')) renderValidationWindow();
  }

  function clearResultPanels() {
    statsAfter.innerHTML = '';
    downloadBtn.classList.add('hidden');
    exportWindow.classList.add('hidden');
    irreversibleWarning.classList.add('hidden');
    renderIntegrity(null);
    failBanner.classList.add('hidden');
    [summarySection, analysisSection, budgetsSection, warningsSection,
      appliedSection, skippedSection, validationSection].forEach((s) => s.classList.add('hidden'));
  }

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

  let profileFields: BudgetFieldDto[] = [];
  let profileFail: { code: string; field: string } | null = null;
  let deleteArmed = false;

  function revealDir(what: string) {
    fetch(`/api/open?what=${what}`, { method: 'POST' }).catch(() => {});
  }

  async function fetchProfileTemplate() {
    const res = await fetch(`/api/profiles?${langParam()}`);
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as { dir: string; fields: BudgetFieldDto[] };
  }

  function renderProfileFields(values: Record<string, unknown>, kinds: Record<string, unknown> = {}) {
    profileBudgets.innerHTML = '';
    for (const f of profileFields) {
      const row = document.createElement('label');
      row.className = 'profile-field';
      const name = document.createElement('span');
      name.className = 'profile-label';
      name.textContent = f.name;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.className = 'profile-number';
      input.dataset.budget = f.id;
      const v = values[f.id];
      input.value = v == null ? '' : String(v);
      row.append(name, input);
      if (f.unit) {
        const unit = document.createElement('span');
        unit.className = 'profile-unit';
        unit.textContent = f.unit;
        row.appendChild(unit);
      }
      const kind = document.createElement('select');
      kind.className = 'profile-kind';
      kind.dataset.budgetKind = f.id;
      for (const value of ['warn', 'limit']) {
        const opt = document.createElement('option');
        opt.value = value;
        window.I18n.setText(opt, value === 'limit' ? 'profile.kind.limit' : 'profile.kind.warn');
        kind.appendChild(opt);
      }
      kind.value = kinds[f.id] === 'limit' ? 'limit' : 'warn';
      row.appendChild(kind);
      profileBudgets.appendChild(row);
    }
  }

  function currentBudgetValues(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const el of profileBudgets.querySelectorAll('input[data-budget]')) {
      const input = el as HTMLInputElement;
      out[input.dataset.budget!] = input.value.trim();
    }
    return out;
  }

  function currentBudgetKinds(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const el of profileBudgets.querySelectorAll('select[data-budget-kind]')) {
      const sel = el as HTMLSelectElement;
      out[sel.dataset.budgetKind!] = sel.value;
    }
    return out;
  }

  function currentExcluded(): string[] {
    const out: string[] = [];
    for (const el of profileFeatures.querySelectorAll('input[data-feature]')) {
      const cb = el as HTMLInputElement;
      if (!cb.checked) out.push(cb.dataset.feature!);
    }
    return out;
  }

  async function renderProfileFeatures(engineId: string, excluded: string[]) {
    profileFeatures.innerHTML = '';
    let list: ExtensionDto[] = [];
    try {
      const res = await fetch(`/api/extensions?platform=&engine=${encodeURIComponent(engineId)}&${langParam()}`);
      const data = await res.json();
      list = (data && data.extensions) || [];
    } catch (e) {
      const note = document.createElement('p');
      note.className = 'profile-hint';
      note.textContent = t('opts.noServer', { error: String(((e as Error) && (e as Error).message) || e) });
      profileFeatures.appendChild(note);
      return;
    }
    const off = new Set(excluded);
    for (const ext of list) {
      const row = document.createElement('label');
      row.className = 'profile-feature';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.feature = ext.id;
      cb.checked = !off.has(ext.id);
      cb.addEventListener('change', disarmDelete);
      const name = document.createElement('span');
      name.textContent = ext.title || ext.id;
      row.append(cb, name);
      profileFeatures.appendChild(row);
    }
  }

  const PROFILE_ERRORS = [
    'title_required', 'engine_unknown', 'builtin_id', 'bad_number',
    'unknown_profile', 'id_taken', 'write_failed', 'no_assistant', 'bad_file', 'too_long',
  ];

  function showProfileError(code: string | null, field = '') {
    profileFail = code ? { code, field } : null;
    if (!code) {
      profileError.classList.add('hidden');
      profileError.textContent = '';
      return;
    }
    const key = PROFILE_ERRORS.includes(code) ? `profile.err.${code}` : 'profile.err.unknown';
    const named = profileFields.find((f) => f.id === field);
    setText(profileError, key, { field: named ? named.name : field });
    profileError.classList.remove('hidden');
  }

  function disarmDelete() {
    deleteArmed = false;
    profileDelete.classList.remove('is-armed');
    setText(profileDelete, 'profile.delete');
  }

  function renderProfilePick(selected: string) {
    profilePick.innerHTML = '';
    const fresh = document.createElement('option');
    fresh.value = '';
    setText(fresh, 'profile.new');
    profilePick.appendChild(fresh);
    for (const p of platforms.filter((x) => x.custom)) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.title || p.id;
      profilePick.appendChild(opt);
    }
    profilePick.value = [...profilePick.options].some((o) => o.value === selected) ? selected : '';
  }

  function renderProfileEngines(selected: string) {
    profileEngine.innerHTML = '';
    for (const e of engines) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.title || e.id;
      profileEngine.appendChild(opt);
    }
    if (selected && [...profileEngine.options].some((o) => o.value === selected)) profileEngine.value = selected;
  }

  function fillProfileForm(form: Record<string, any>) {
    profileTitle.value = form.title || '';
    profileDescription.value = form.description || '';
    profileSource.value = form.source || '';
    renderProfileEngines(form.engine || '');
    renderProfileFields(form.budgets || {}, form.budgetKinds || {});
    renderProfileFeatures(profileEngine.value, form.excludeExtensions || []);
    profileDelete.classList.toggle('hidden', !form.id);
    profileExport.classList.toggle('hidden', !form.id);
    updateProfileCounters();
    disarmDelete();
    showProfileError(null);
  }

  function updateProfileCounters() {
    for (const [input, host] of [
      [profileDescription, document.getElementById('profile-description-count')],
      [profileSource, document.getElementById('profile-source-count')],
    ] as const) {
      if (host) setText(host, 'profile.count', { n: input.value.length, max: input.maxLength });
    }
  }

  async function loadProfileForEdit(id: string) {
    if (!id) { fillProfileForm({}); return; }
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(id)}?${langParam()}`);
      const data = await res.json();
      if (!res.ok) { showProfileError(data && data.error); return; }
      fillProfileForm(data);
    } catch (e) {
      showProfileError('write_failed');
    }
  }

  async function openProfileWindow() {
    let failed = false;
    try {
      const tpl = await fetchProfileTemplate();
      profileFields = Array.isArray(tpl.fields) ? tpl.fields : [];
      setText(profileDir, 'profile.dir', { path: tpl.dir });
    } catch (e) {
      profileFields = [];
      setText(profileDir, 'profile.dir', { path: '—' });
      failed = true;
    }
    const выбрана = platforms.find((p) => p.id === platformSelect.value && p.custom);
    renderProfilePick(выбрана ? выбрана.id : '');
    if (выбрана) await loadProfileForEdit(выбрана.id);
    else fillProfileForm({});
    if (failed) showProfileError('no_assistant');
    showWindow(profileWindow);
    profileTitle.focus();
  }

  async function relabelProfileForm() {
    const typed = currentBudgetValues();
    const kinds = currentBudgetKinds();
    const fail = profileFail;
    const excluded = currentExcluded();
    try {
      const tpl = await fetchProfileTemplate();
      profileFields = Array.isArray(tpl.fields) ? tpl.fields : [];
      setText(profileDir, 'profile.dir', { path: tpl.dir });
    } catch (e) {
      return;
    }
    renderProfileFields(typed, kinds);
    await renderProfileFeatures(profileEngine.value, excluded);
    renderProfilePick(profilePick.value);
    if (fail) showProfileError(fail.code, fail.field);
  }

  async function refreshPlatforms(preferId: string) {
    const keep = platformSelect.value;
    await loadPlatforms();
    const has = (id: string) => Boolean(id) && [...platformSelect.options].some((o) => o.value === id);
    const wanted = has(preferId) ? preferId : (has(keep) ? keep : '');
    if (platformSelect.value !== wanted) {
      platformSelect.value = wanted;
      platformSelect.dispatchEvent(new Event('change'));
    }
  }

  async function saveProfile() {
    const payload = {
      id: profilePick.value,
      title: profileTitle.value,
      engine: profileEngine.value,
      description: profileDescription.value,
      source: profileSource.value,
      budgets: currentBudgetValues(),
      budgetKinds: currentBudgetKinds(),
      excludeExtensions: currentExcluded(),
    };
    profileSave.disabled = true;
    try {
      const res = await fetch(`/api/profiles?${langParam()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { showProfileError(data && data.error, (data && data.field) || ''); return; }
      showProfileError(null);
      logMessage('info', t('log.profile.saved', { name: payload.title.trim() }));
      await refreshPlatforms(data.id);
      renderProfilePick(data.id);
      profileDelete.classList.remove('hidden');
    } catch (e) {
      showProfileError('write_failed');
    } finally {
      profileSave.disabled = false;
    }
  }

  async function deleteProfile() {
    const id = profilePick.value;
    if (!id) return;
    if (!deleteArmed) {
      deleteArmed = true;
      profileDelete.classList.add('is-armed');
      setText(profileDelete, 'profile.delete.confirm');
      return;
    }
    const name = profilePick.options[profilePick.selectedIndex]!.textContent || id;
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(id)}?${langParam()}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { showProfileError(data && data.error); disarmDelete(); return; }
      logMessage('info', t('log.profile.deleted', { name }));
      await refreshPlatforms('');
      renderProfilePick('');
      fillProfileForm({});
    } catch (e) {
      showProfileError('write_failed');
      disarmDelete();
    }
  }

  function exportProfile() {
    const id = profilePick.value;
    if (!id) return;
    const a = document.createElement('a');
    a.href = `/api/profiles/${encodeURIComponent(id)}?download=1`;
    a.download = `${id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    logMessage('info', t('log.profile.exported', { name: `${id}.json` }));
  }

  async function importProfile(file: File) {
    disarmDelete();
    let text;
    try {
      text = await file.text();
    } catch (e) {
      showProfileError('bad_file');
      return;
    }
    try {
      const res = await fetch(`/api/profiles?import=1&${langParam()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      const data = await res.json();
      if (!res.ok) { showProfileError(data && data.error, (data && data.field) || ''); return; }
      showProfileError(null);
      logMessage('info', t(data.replaced ? 'log.profile.replaced' : 'log.profile.imported', { name: data.id }));
      await refreshPlatforms(data.id);
      renderProfilePick(data.id);
      await loadProfileForEdit(data.id);
    } catch (e) {
      showProfileError('write_failed');
    }
  }

  profilePick.addEventListener('change', () => loadProfileForEdit(profilePick.value));
  profileSave.addEventListener('click', () => saveProfile());
  profileDelete.addEventListener('click', () => deleteProfile());
  profileDir.addEventListener('click', () => revealDir('profiles'));
  profileExport.addEventListener('click', () => exportProfile());
  profileImport.addEventListener('click', () => profileFile.click());
  profileFile.addEventListener('change', () => {
    const file = profileFile.files && profileFile.files[0];
    if (file) importProfile(file);
    profileFile.value = '';
  });
  for (const el of [profileTitle, profileDescription, profileSource, profileEngine, profilePick]) {
    el.addEventListener('input', disarmDelete);
  }
  for (const el of [profileDescription, profileSource]) {
    el.addEventListener('input', updateProfileCounters);
  }
  profileEngine.addEventListener('change', () => renderProfileFeatures(profileEngine.value, []));

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
        const name = (btn as HTMLElement).dataset.menu;
        const panel = menubar.querySelector(`[data-menu-panel="${name}"]`);
        const wasOpen = panel && !panel.classList.contains('hidden');
        closeAll();
        if (panel && !wasOpen) { panel.classList.remove('hidden'); btn.classList.add('open'); }
      });
    }
    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
    for (const p of panels) p.addEventListener('click', (e) => e.stopPropagation());

    const openItem = document.getElementById('menu-open');
    if (openItem) openItem.addEventListener('click', () => { closeAll(); fileInput.click(); });

    const dlItem = document.getElementById('menu-download');
    if (dlItem) {
      dlItem.addEventListener('click', () => { closeAll(); downloadBtn.click(); });
      const syncDownload = () => { (dlItem as HTMLButtonElement).disabled = !resultDownloadUrl; };
      for (const btn of titles) btn.addEventListener('click', syncDownload);
      syncDownload();
    }

    for (const btn of titles) btn.addEventListener('click', () => refreshRenderUI());

    const renderLight = document.getElementById('render-light') as HTMLSelectElement | null;
    const renderLightNote = document.getElementById('render-light-note');
    const renderSize = document.getElementById('render-size') as HTMLSelectElement | null;
    const renderBg = document.getElementById('render-background') as HTMLSelectElement | null;
    const renderGo = document.getElementById('render-go') as HTMLButtonElement | null;

    function viewportPixels() {
      const cv = document.querySelector<HTMLCanvasElement>('#preview-optimized .viewer-canvas');
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round((cv?.clientWidth || 0) * ratio);
      const h = Math.round((cv?.clientHeight || 0) * ratio);
      return { w, h };
    }

    const RENDER_SCALES = [1, 2, 4];
    const RENDER_BACKGROUNDS = [
      ['none', null],
      ['white', '#ffffff'],
      ['black', '#000000'],
    ] as const;

    function refreshRenderUI() {
      if (renderGo) renderGo.disabled = !window.OptiViewer?.canSnapshot?.();

      const info = window.OptiViewer?.getLight?.();
      const own = (info?.count ?? 0) > 0;
      if (renderLightNote) renderLightNote.classList.toggle('hidden', own);
      if (renderLight) {
        fillLightSelect(renderLight, own);
        if (info?.mode && renderLight.value !== info.mode) renderLight.value = info.mode;
      }

      if (renderSize) {
        const { w, h } = viewportPixels();
        renderSize.textContent = '';
        for (const times of RENDER_SCALES) {
          const opt = document.createElement('option');
          opt.value = String(times);
          if (times === 1) setText(opt, 'menu.render.size.screen');
          else setText(opt, 'menu.render.size.multiple', { times, w: w * times, h: h * times });
          renderSize.appendChild(opt);
        }
        renderSize.value = renderSize.dataset.want || '2';
      }

      if (renderBg && !renderBg.dataset.filled) {
        renderBg.dataset.filled = '1';
        for (const [id] of RENDER_BACKGROUNDS) {
          const opt = document.createElement('option');
          opt.value = id;
          setText(opt, 'menu.render.background.' + id);
          renderBg.appendChild(opt);
        }
      }
    }

    if (renderLight) {
      renderLight.addEventListener('change', () => {
        window.OptiViewer?.selectLightMode?.(renderLight.value as 'studio' | 'file' | 'none');
        refreshLightUI();
      });
    }
    if (renderSize) renderSize.addEventListener('change', () => { renderSize.dataset.want = renderSize.value; });

    if (renderGo) {
      renderGo.addEventListener('click', async () => {
        if (!window.OptiViewer?.snapshot) return;
        const { w, h } = viewportPixels();
        const times = Number(renderSize?.value || 2) || 1;
        const bg = RENDER_BACKGROUNDS.find(([id]) => id === (renderBg?.value || 'none'))?.[1] ?? null;

        renderGo.disabled = true;
        setText(renderGo, 'menu.render.working');
        try {
          const shot = await window.OptiViewer.snapshot({ width: w * times, height: h * times, background: bg });
          if (!shot) { logMessage('warn', t('menu.render.failed')); return; }
          if (shot.width !== w * times || shot.height !== h * times) {
            logMessage('warn', t('menu.render.clamped', { w: shot.width, h: shot.height }));
          }
          const base = (activeModel()?.file?.name || 'model').replace(/\.[^.]+$/, '');
          const name = base + '_render.png';
          const url = URL.createObjectURL(shot.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
          logMessage('info', t('menu.render.done', { name, w: shot.width, h: shot.height }));
        } finally {
          setText(renderGo, 'menu.render.go');
          renderGo.disabled = false;
          closeAll();
        }
      });
    }

    const profileItem = document.getElementById('menu-profile');
    if (profileItem) profileItem.addEventListener('click', () => { closeAll(); openProfileWindow(); });

    const workdirNote = document.getElementById('workdir-note');
    const workdirOpen = document.getElementById('workdir-open');
    const workdirClear = document.getElementById('workdir-clear');
    if (workdirNote) {
      const syncWorkdir = async () => {
        try {
          const info = await fetch('/api/workdir').then((r) => r.json());
          setText(workdirNote, 'menu.settings.workdir.note', {
            size: fmtBytes(info.bytes),
            limit: fmtBytes(info.limit),
          });
        } catch (e) {
        }
      };
      for (const btn of titles) {
        if ((btn as HTMLElement).dataset.menu === 'settings') btn.addEventListener('click', syncWorkdir);
      }
      if (workdirClear) {
        workdirClear.addEventListener('click', async () => {
          try {
            await fetch('/api/workdir', { method: 'DELETE' });
            setText(workdirNote, 'menu.settings.workdir.cleared');
            await dropVanishedResults();
          } catch (e) {
            await syncWorkdir();
          }
        });
      }
    }
    if (workdirOpen) workdirOpen.addEventListener('click', () => revealDir('work'));
  }

  chooseFileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    handleFiles(Array.from(input.files!).map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
    input.value = '';
  });

  dropzone.addEventListener('click', () => fileInput.click());

  let dragDepth = 0;

  function isFileDrag(e: DragEvent) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.includes.call(types, 'Files');
  }

  function showDropOverlay(on: boolean) {
    if (dropOverlay) dropOverlay.classList.toggle('hidden', !on);
    document.body.classList.toggle('drag-active', on);
  }

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth++;
    showDropOverlay(true);
  });

  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDropOverlay(false);
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    showDropOverlay(false);
    if (!isFileDrag(e)) return;
    const dt = e.dataTransfer!;
    const entries: any[] = [];
    if (dt.items && (dt.items as any)[0] && typeof (dt.items as any)[0].webkitGetAsEntry === 'function') {
      for (const item of Array.from(dt.items)) {
        const entry = (item as any).webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }
    const plain = Array.from(dt.files || []).map((f) => ({ file: f, path: f.name }));
    (async () => {
      const fromEntries = entries.length ? await filesFromEntries(entries) : [];
      handleFiles(fromEntries.length || entries.length ? fromEntries : plain);
    })();
  });

  async function filesFromEntries(entries: any[]): Promise<DroppedFile[]> {
    const out: DroppedFile[] = [];
    const walk = async (entry: any, prefix: string): Promise<void> => {
      if (!entry) return;
      if (entry.isFile) {
        const file = await new Promise<File | null>((resolve) => {
          entry.file((f: File) => resolve(f), () => resolve(null));
        });
        if (file) out.push({ file, path: prefix + (entry.name || file.name) });
        return;
      }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      const inner = prefix + (entry.name || '') + '/';
      for (;;) {
        const batch: any[] = await new Promise((resolve) => {
          reader.readEntries((items: any[]) => resolve(items || []), () => resolve([]));
        });
        if (!batch.length) return;
        for (const child of batch) await walk(child, inner);
      }
    };
    for (const entry of entries) await walk(entry, '');
    return out;
  }

  function setPhase(key: string, mode?: string | null, params?: UiParams) {
    setText(phaseStatus, key, params);
    statusDot.classList.remove('busy', 'fail');
    if (mode === 'busy') statusDot.classList.add('busy');
    if (mode === 'fail') statusDot.classList.add('fail');
  }

  function onProgressEvent(e: Record<string, any>) {
    if (e.type === 'phase') {
      setPhase('status.phase', 'busy', { n: e.phase, name: e.name });
      logMessage('debug', `Phase ${e.phase}: ${e.name}`);
    } else if (e.type === 'rule') {
      setPhase('status.rule', 'busy', { title: e.title });
      logMessage('debug', `Rule: ${e.title}`);
    }
  }

  runBtn.addEventListener('click', onRunClick);

  async function onRunClick() {
    if (batchInFlight) {
      batchCancel = true;
      setText(runBtn, 'btn.stopping');
      runBtn.disabled = true;
      return;
    }
    const picked = pickedModels();
    if (batchMode() && picked.length > 1) return runBatch(picked);
    if (batchMode() && picked.length === 1 && picked[0]!.id !== activeModelId) return runBatch(picked);
    return runOptimize();
  }

  async function runBatch(picked: ModelEntry[]) {
    const list = picked.filter(needsBuild);
    const alreadyBuilt = picked.length - list.length;
    if (alreadyBuilt) logMessage('info', t('log.batchAlreadyBuilt', { n: alreadyBuilt }));
    if (!list.length) return;

    batchInFlight = true;
    batchCancel = false;
    let ok = 0;
    let failed = 0;
    let left = list.length;
    logMessage('info', t('log.batchStarted', { n: list.length }));
    try {
      for (let i = 0; i < list.length; i++) {
        if (batchCancel) break;
        const rec = list[i]!;
        if (!models.includes(rec)) { left -= 1; continue; }
        await selectModel(rec.id);
        updateRunButtonState();
        setPhase('status.batch', 'busy', { i: i + 1, total: list.length, name: rec.file.name });
        await runOptimize();
        if (lastResult && lastResult.status !== 'fail') ok += 1; else failed += 1;
        left -= 1;
      }
    } finally {
      const stopped = batchCancel;
      batchInFlight = false;
      batchCancel = false;
      logMessage(failed ? 'warn' : 'info', stopped
        ? t('log.batchStopped', { ok, failed, left })
        : t('log.batchDone', { ok, failed }));
      setPhase(stopped ? 'status.batchStopped' : 'status.batchDone', failed ? 'fail' : null,
        { ok, failed });
      updateRunButtonState();
      renderModelList();
    }
  }

  function buildOptimizeUrl(jobId: string, sourceId: string | null) {
    const platformId = platformSelect.value;
    const features = getSelectedFeatures();
    const featuresParam = features.length ? `&features=${encodeURIComponent(features.join(','))}` : '';
    const sourceParam = sourceId ? `&source=${encodeURIComponent(sourceId)}` : '';
    const texParam = features.includes('ktx2') ? `&texMode=${encodeURIComponent(ktx2Mode)}` : '';
    const qualityParam = features.includes('webp') ? `&webpQuality=${encodeURIComponent(String(webpQuality))}` : '';
    const engineParam = `&engine=${encodeURIComponent(engineSelect.value || '')}`;
    return `/api/optimize?platform=${encodeURIComponent(platformId)}${engineParam}&job=${encodeURIComponent(jobId)}&${langParam()}${featuresParam}${sourceParam}${texParam}${qualityParam}`;
  }

  async function sendOptimize(jobId: string) {
    const doFetch = (sourceId: string | null, withBody: boolean) => fetch(buildOptimizeUrl(jobId, sourceId), {
      method: 'POST',
      headers: {
        'X-Filename': encodeURIComponent(selectedFile()!.name),
        'Content-Type': 'application/octet-stream',
      },
      body: withBody ? selectedFile() : null,
    });

    const rec = activeModel();
    if (!currentSourceId) await uploadPack(rec);
    const packId = rec ? rec.packSourceId || null : null;

    const useSource = !!currentSourceId;
    let res = await doFetch(useSource ? currentSourceId : packId, !useSource);
    if (res.status === 410 && useSource) {
      currentSourceId = null;
      if (rec) rec.packSourceId = null;
      res = await doFetch(await uploadPack(rec), true);
    }
    return res;
  }

  function freezeSettings(frozen: boolean) {
    platformSelect.disabled = frozen;
    for (const el of extensionsList.querySelectorAll<HTMLInputElement>('input, select, button')) el.disabled = frozen;
    extensionsPanel.classList.toggle('is-frozen', frozen);
  }

  async function runOptimize() {
    if (!selectedFile() || buildInFlight) return;

    buildInFlight = true;
    startedSignature = currentSettingsSignature();
    freezeSettings(true);
    if (!batchInFlight) runBtn.disabled = true;
    if (!batchInFlight) setPhase(currentSourceId ? 'status.optimizing' : 'status.uploading', 'busy');
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
        try { onProgressEvent(JSON.parse(msg.data)); } catch (e2) {  }
      };
      es.onerror = () => {  };
    } catch (e) {
    }

    try {
      const res = await sendOptimize(jobId);

      if (es) es.close();

      const data = await res.json();

      if (!res.ok) {
        showGenericError(data && data.error ? data.error : t('log.serverError', { status: res.status }));
        return;
      }

      const shown = renderResult(data);
      if (shown) await shown.catch(() => {});
    } catch (e) {
      if (es) es.close();
      showGenericError(t('log.noServer', { error: (e as Error).message }));
    } finally {
      buildInFlight = false;
      freezeSettings(false);
      setBusy('preview-optimized', null);
      updateRunButtonState();
      captureActiveModel();
      renderModelList();
    }
  }

  function showGenericError(message: string) {
    setPhase('status.error', 'fail');
    logMessage('error', message);
    showWindow(failBanner);
    setText(failBanner.querySelector('.fail-title'), 'fail.generic');
    setRaw(failBanner.querySelector('.fail-text'), message);
    failValidation.innerHTML = '';
    lastBuildSignature = null;
    irreversibleWarning.classList.add('hidden');
    renderIntegrity(null);
  }

  function renderReport(result: RunResultDto | null, explain: ExplainDto | null) {
    lastResult = result;
    lastExplain = explain;
    renderComparison(result!.metrics);
    renderSummary(explain);
    renderValidation(result!.validation);
    renderIssues(result!.findings, result!.applied);
    renderBudgets(explain! && explain!.budgetChecks);
    renderWarnings(explain && explain.warnings);
    renderAppliedSkipped(result!.applied, result!.skipped);
    renderCostBadges(result!.skipped);
  }

  function renderResult(data: Record<string, any>) {
    const { result, explain, downloadUrl } = data;

    if (data.sourceId) currentSourceId = data.sourceId;

    const written = !!(result && result.file && result.file.written);
    if (!result || (result.status === 'fail' && !written)) {
      renderFail(result, explain);
      return;
    }

    const integrityFailed = result.status === 'fail';
    setPhase(integrityFailed ? 'status.doneWithIssue' : 'status.ready', integrityFailed ? 'fail' : null);
    lastFail = null;
    failBanner.classList.add('hidden');

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
    if (integrityFailed) logMessage('warn', t('log.integrityFailed'));

    setText(runBtn, 'btn.rebuild');
    lastBuildSignature = startedSignature ?? currentSettingsSignature();

    const bust = (u: string | null) => (u ? u + (u.includes('?') ? '&' : '?') + 't=' + (++runToken) : u);
    const freshUrl = bust(downloadUrl);

    let optimizedShown = null;
    if (window.OptiViewer) optimizedShown = Promise.resolve(window.OptiViewer.loadOptimized(freshUrl!));

    if (downloadUrl) {
      resultDownloadUrl = freshUrl;
      const dstName = result.file && result.file.dst ? result.file.dst.split(/[\\/]/).pop() : 'model.glb';
      resultExportBase = dstName.replace(/\.[^.]+$/, '') || 'model';
      downloadBtn.classList.remove('hidden');
      renderIrreversibleWarning(result.applied);
      inspectResult(freshUrl!);
    } else {
      resultDownloadUrl = null;
      downloadBtn.classList.add('hidden');
      irreversibleWarning.classList.add('hidden');
      renderIntegrity(null);
      resultInspect = null;
      runToken++;
      updateInspectButtons();
    }
    return optimizedShown;
  }

  function renderIrreversibleWarning(applied: ReportEntryDto[] | null | undefined) {
    const lossy = (applied || []).filter((a: ReportEntryDto) => a.reversible === false && a.dataLoss === 'significant');
    irreversibleWarning.classList.toggle('hidden', !lossy.length);
  }

  function renderIntegrity(result: RunResultDto | null) {
    const failed = (result && result.status === 'fail')
      ? (result.validation || []).filter((v: ReportEntryDto) => v.level === 'fail')
      : [];
    const show = failed.length > 0;

    integrityWarning.classList.toggle('hidden', !show);
    downloadAlert.classList.toggle('hidden', !show);
    exportAlert.classList.toggle('hidden', !show);
    if (show) {
      window.I18n.setTitle(downloadBtn, 'btn.download.alert');
    } else {
      downloadBtn.removeAttribute('data-i18n-title');
      downloadBtn.removeAttribute('title');
    }

    renderExportBudget(result && lastExplain ? lastExplain.budgetChecks : null);

    exportAlertDetails.innerHTML = '';
    if (!show) return;
    for (const v of failed) {
      const li = document.createElement('li');
      li.textContent = v.text;
      exportAlertDetails.appendChild(li);
    }
  }

  function renderFail(result: RunResultDto | null, explain: ExplainDto | null, silent = false) {
    lastFail = { result, explain };
    setPhase('status.failed', 'fail');
    const reason = (explain && explain.summary) || (result && result.error) || '';
    if (!silent) {
      logMessage('error', reason
        ? t('log.notProcessed', { reason })
        : t('log.notWritten'));
    }
    showWindow(failBanner);
    setText(failBanner.querySelector('.fail-title'), 'fail.notWritten');
    if (reason) setRaw(failBanner.querySelector('.fail-text'), reason);
    else setText(failBanner.querySelector('.fail-text'), 'fail.text');

    failValidation.innerHTML = '';
    const items = (result && result.validation) || [];
    for (const v of items) {
      const row = document.createElement('div');
      row.textContent = `${VALIDATION_ICON[v.level!] || '·'} ${v.text}`;
      failValidation.appendChild(row);
    }

    resultDownloadUrl = null;
    downloadBtn.classList.add('hidden');
    exportWindow.classList.add('hidden');
    irreversibleWarning.classList.add('hidden');
    renderIntegrity(null);
    resultInspect = null;
    runToken++;
    updateInspectButtons();
    lastBuildSignature = null;
  }

  function renderComparison(metrics: Record<string, any> | null) {
    if (!metrics || !metrics.before || !metrics.after) return;
    const { before, after } = metrics;

    statsBefore.innerHTML = '';
    statsAfter.innerHTML = '';

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
  }

  function hudLine(label: string, value: string, valClass?: string | null) {
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

  function renderSummary(explain: ExplainDto | null) {
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

  function renderIssues(findings: ReportEntryDto[] | null | undefined, applied: ReportEntryDto[] | null | undefined) {
    const lossy = (applied || []).filter((a) => a.reversible === false && a.dataLoss === 'significant');
    const lossyLines = condense(lossy);

    const hasAny = (findings && findings.length) || lossyLines.length;
    analysisSection.classList.toggle('hidden', !hasAny);
    if (!hasAny) return;

    const notableCount = (findings || []).filter((f) => f.severity === 'error' || f.severity === 'warn').length;
    if (notableCount) setText(issuesCount, 'issues.countImportant', { n: notableCount });
    else setText(issuesCount, 'issues.countPlain', { n: (findings || []).length });

    issuesList.innerHTML = '';

    if (lossyLines.length) {
      const card = document.createElement('div');
      card.className = 'issue-card sev-info issue-card--lossy';
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

    const buckets = new Map();
    for (const f of findings || []) {
      const key = `${f.category}|${f.severity}`;
      if (!buckets.has(key)) buckets.set(key, { category: f.category, severity: f.severity, items: [] });
      buckets.get(key).items.push({ ruleId: f.ruleId, text: f.text, i18n: f.i18n });
    }

    for (const b of buckets.values()) {
      const lines = condense(b.items);
      if (!lines.length) continue;
      const sev = b.severity === 'error' ? 'sev-error' : b.severity === 'warn' ? 'sev-warn' : 'sev-info';

      const card = document.createElement('div');
      card.className = `issue-card ${sev}`;

      const title = document.createElement('p');
      title.className = 'issue-title';
      title.textContent = CATEGORY_KEYS[b.category] ? t(CATEGORY_KEYS[b.category]!) : (b.category || t('cat.other'));
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

  function renderExportBudget(budgetChecks: ExplainDto['budgetChecks'] | null) {
    const over = (budgetChecks || []).filter((b) => b.level === 'over');
    exportBudget.classList.toggle('hidden', !over.length);
    exportBudgetDetails.innerHTML = '';
    for (const b of over) {
      const li = document.createElement('li');
      li.textContent = b.advice || b.name;
      exportBudgetDetails.appendChild(li);
    }
  }

  function renderBudgets(budgetChecks: ExplainDto['budgetChecks']) {
    const has = budgetChecks && budgetChecks.length;
    budgetsSection.classList.toggle('hidden', !has);
    if (!has) return;

    budgetsList.innerHTML = '';
    const ICON: Record<string, string> = { ok: '✓', warn: '⚠', over: '✕', none: '·' };
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
      icon.textContent = ICON[b.level] || ICON.none!;
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

      if (b.source) {
        const url = /^https?:\/\//i.test(b.source) ? b.source : '';
        const src = document.createElement(url ? 'a' : 'span');
        src.className = 'budget-source';
        if (url) {
          (src as HTMLAnchorElement).href = url;
          (src as HTMLAnchorElement).target = '_blank';
          (src as HTMLAnchorElement).rel = 'noopener noreferrer';
          src.textContent = t('budget.source');
        } else {
          src.textContent = b.source;
        }
        row.appendChild(src);
      }
      if (b.by === 'project' || b.by === 'user') {
        const own = document.createElement('span');
        own.className = 'budget-source budget-source--own';
        own.textContent = t(b.by === 'user' ? 'budget.yourChoice' : 'budget.ourChoice');
        row.appendChild(own);
      }

      budgetsList.appendChild(row);
    }
  }

  function renderWarnings(warnings: string[] | null | undefined) {
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

  const NAME_SLOT = ' ';
  const MAX_NAMES = 4;

  function condense(items: Array<{ text: string; [key: string]: any }>) {
    const groups = new Map();
    for (const it of items) {
      const text = String(it.text || '');
      const names: string[] = [];
      const template = text.replace(/"([^"]*)"/g, (_, n) => { names.push(n); return NAME_SLOT; });
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
        let i = 0;
        out.push(g.template.replace(new RegExp(NAME_SLOT, 'g'), () => `"${g.names[i++] ?? '—'}"`));
        continue;
      }
      const shown = g.names.slice(0, MAX_NAMES).join(', ');
      const rest = g.names.length - MAX_NAMES;
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

  function renderAppliedSkipped(applied: ReportEntryDto[] | null | undefined, skipped: ReportEntryDto[] | null | undefined) {
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

    const meaningful = (skipped || []).filter((s: ReportEntryDto) => s && (s.kind === 'unsafe' || s.kind === 'policy'));
    const skippedLines = condense(meaningful.map((s: ReportEntryDto) => ({
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

  function renderValidation(validation: ReportEntryDto[] | null | undefined) {
    const has = validation && validation.length;
    validationSection.classList.toggle('hidden', !has);
    if (!has) return;

    const failed = validation.filter((v: ReportEntryDto) => v.level === 'fail').length;
    if (validationCount) {
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

  function setupWindow(el: HTMLElement) {
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

    bar.addEventListener('pointerdown', ((e: PointerEvent) => {
      if ((e.target as Element).closest('.window-close, .window-action')) return;
      dragging = true;
      bar.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      const parent = el.offsetParent ? el.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
      baseLeft = rect.left - parent.left;
      baseTop = rect.top - parent.top;
      el.style.left = `${baseLeft}px`;
      el.style.top = `${baseTop}px`;
      el.style.transform = 'none';
      startX = e.clientX;
      startY = e.clientY;
      e.preventDefault();
    }) as EventListener);

    bar.addEventListener('pointermove', ((e: PointerEvent) => {
      if (!dragging) return;
      el.style.left = `${baseLeft + e.clientX - startX}px`;
      el.style.top = `${baseTop + e.clientY - startY}px`;
    }) as EventListener);

    const stop = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { bar.releasePointerCapture(e.pointerId); } catch (_) {  }
    };
    bar.addEventListener('pointerup', stop as EventListener);
    bar.addEventListener('pointercancel', stop as EventListener);
  }

  function closeAllWindows(except?: HTMLElement | null) {
    for (const w of document.querySelectorAll('.window')) {
      if (w !== except) w.classList.add('hidden');
    }
  }

  function showWindow(el: HTMLElement) {
    closeAllWindows(el);
    el.style.left = '';
    el.style.top = '';
    el.style.transform = '';
    el.classList.remove('hidden');
  }

  document.addEventListener('pointerdown', (e) => {
    if (!document.querySelector('.window:not(.hidden)')) return;
    if ((e.target as Element).closest('.window')) return;
    if ((e.target as Element).closest('[data-window-trigger]')) return;
    closeAllWindows(null);
  });

  const LOG_LIMIT = 500;
  const logs: Array<{ level: string; text: string; time: Date }> = [];

  function logMessage(level: string, text: string) {
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
    for (const entry of [...logs].reverse()) {
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

  downloadBtn.addEventListener('click', () => {
    if (!resultDownloadUrl) return;
    exportName.value = resultExportBase;
    showWindow(exportWindow);
    exportName.focus();
    exportName.select();
  });

  const EXPORT_FORMATS: Record<string, { ext: string; url: (base: string) => string }> = {
    glb: { ext: '.glb', url: (base: string) => base },
    json: { ext: '.gltf', url: (base: string) => base.replace('/api/download', '/api/export-json') },
  };

  function currentExportFormat() {
    const r = exportWindow.querySelector('input[name="export-format"]:checked');
    return ((r as HTMLInputElement) && (r as HTMLInputElement).value) || 'glb';
  }

  exportSave.addEventListener('click', async () => {
    if (!resultDownloadUrl) return;
    if (!(await resultAlive(resultDownloadUrl))) { await dropVanishedResults(); return; }
    const fmt = EXPORT_FORMATS[currentExportFormat()] || EXPORT_FORMATS.glb!;
    const base = (exportName.value || resultExportBase).trim() || 'model';
    const fileName = base.replace(/\.[^.]+$/, '') + fmt.ext;
    const url = fmt.url(resultDownloadUrl!) + '&name=' + encodeURIComponent(fileName);
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
  setupWindow(profileWindow);

  btnMetadata.addEventListener('click', () => {
    renderMetadataWindow();
    showWindow(metadataWindow);
  });
  btnValidation.addEventListener('click', () => {
    renderValidationWindow();
    showWindow(validationWindow);
  });

  const severityName = (code: number | string) => t(`sev.${code}`);

  function fmtCell(v: unknown) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'number') return Number.isInteger(v) ? fmtInt(v) : v.toFixed(2);
    if (typeof v === 'boolean') return v ? '✓' : '';
    return String(v);
  }

  function buildTable(rows: Array<Record<string, any>>, sizeKeys: string[] = []) {
    const table = document.createElement('table');
    table.className = 'meta-table';
    if (!rows.length) return table;
    const keys = Object.keys(rows[0]!);
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const h of ['id', ...keys]) {
      const th = document.createElement('th');
      const label = t(`col.${h}`);
      th.textContent = label === `col.${h}` ? h.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase() : label;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach((row: Record<string, any>, i: number) => {
      const tr = document.createElement('tr');
      const idTd = document.createElement('td');
      idTd.textContent = i as unknown as string;
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

  function metaSection(title: string, rows: Array<Record<string, any>>, sizeKeys?: string[]) {
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

  function splitPanes(buildPane: (col: HTMLElement, data: any) => void) {
    const wrap = document.createElement('div');
    wrap.className = 'window-split';
    wrap.appendChild(inspectColumn(t('inspect.original'), modelInspect, buildPane, t('inspect.noModel')));
    wrap.appendChild(inspectColumn(t('inspect.optimized'), resultInspect, buildPane,
      t('inspect.noResult')));
    return wrap;
  }

  function inspectColumn(title: string, data: InspectDto | null, buildPane: (col: HTMLElement, data: any) => void, emptyText: string) {
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

  function buildMetadataPane(col: HTMLElement, data: InspectDto) {
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
      row.querySelector('.meta-v')!.textContent = v!;
      head.appendChild(row);
    }
    col.appendChild(head);

    const sections = [
      metaSection('Scenes', metadata!.scenes && metadata!.scenes.properties),
      metaSection('Meshes', metadata!.meshes && metadata!.meshes.properties, ['size']),
      metaSection('Materials', metadata!.materials && metadata!.materials.properties),
      metaSection('Textures', metadata!.textures && metadata!.textures.properties, ['size', 'gpuSize']),
      metaSection('Animations', metadata!.animations && metadata!.animations.properties, ['size']),
    ].filter(Boolean);
    for (const s of sections) col.appendChild(s!);
    if (!sections.length) {
      const p = document.createElement('p');
      p.className = 'meta-empty';
      p.textContent = t('inspect.noScene');
      col.appendChild(p);
    }
  }

  function translateValidatorMessage(code: string, originalMessage: string) {
    const key = 'validator.' + code;
    const translated = t(key);
    return translated === key ? originalMessage : translated;
  }

  function issuesTable(issues: Array<Record<string, any>>) {
    const rows = issues.map((m: Record<string, any>) => ({
      code: m.code,
      count: fmtInt(m.count || 1),
      message: translateValidatorMessage(m.code, m.message),
      severity: severityName(m.severity),
      pointer: (m.pointer || '') + ((m.count || 1) > 1 ? ' …' : ''),
    }));
    const scroll = document.createElement('div');
    scroll.className = 'meta-table-scroll';
    const table = buildTable(rows);
    const trs = table.querySelectorAll('tbody tr');
    issues.forEach((m: Record<string, any>, i: number) => { if (trs[i]) trs[i]!.classList.add(`sev-${m.severity}`); });
    scroll.appendChild(table);
    return scroll;
  }

  function logBlindSpots(validation: Array<Record<string, any>> | null | undefined) {
    const explained = (validation || []).filter((m: Record<string, any>) => m.explainedBy);
    if (!explained.length) return;
    const names = [...new Set(explained.map((m: Record<string, any>) => m.explainedBy))].sort().join(', ');
    logMessage('debug', t('log.blindSpots', { n: explained.length, names }));
  }

  function buildValidationPane(col: HTMLElement, data: InspectDto) {
    const issues = (data.validation || []).filter((m: Record<string, any>) => !m.explainedBy);

    if (issues.length) {
      col.appendChild(issuesTable(issues));
      return;
    }
    const p = document.createElement('p');
    p.className = 'meta-empty';
    if (data.sourceFormat) setText(p, 'inspect.noValidation', { format: data.sourceFormat });
    else p.textContent = t('inspect.clean');
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

    const stop = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { viewportSplitter.releasePointerCapture(e.pointerId); } catch (_) {  }
      document.body.classList.remove('resizing');
    };
    viewportSplitter.addEventListener('pointerup', stop);
    viewportSplitter.addEventListener('pointercancel', stop);
  })();

  const inspectorDetails = () => Array.from(document.querySelectorAll('details.report-accordion'));

  function closeOtherDetails(except?: Element | null) {
    for (const d of inspectorDetails()) if (d !== except) (d as HTMLDetailsElement).open = false;
  }

  function closeAllDetails() {
    closeOtherDetails(null);
  }

  for (const d of inspectorDetails()) {
    d.addEventListener('toggle', () => { if ((d as HTMLDetailsElement).open) closeOtherDetails(d); });
  }

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

  const SEEK_STEPS = 1000;
  let animPollId: ReturnType<typeof setInterval> | null = null;
  let seekDragging = false;

  function fmtTime(sec: number) {
    return `${(Number(sec) || 0).toFixed(1)}s`;
  }

  function refreshAnimUI() {
    if (!animControls || !window.OptiViewer || !window.OptiViewer.getAnimation) return;
    const info = window.OptiViewer.getAnimation();
    const has = info.count > 0;
    animControls.classList.toggle('hidden', !has);
    if (!has) return;

    const signature = info.names.join(' ');
    if (animClipSel && animClipSel.dataset.signature !== signature) {
      animClipSel.dataset.signature = signature;
      animClipSel.innerHTML = '';
      info.names.forEach((name: string, i: number) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        if (name) opt.textContent = name;
        else setText(opt, 'viewer.clip.unnamed', { n: i + 1 });
        animClipSel.appendChild(opt);
      });
      animClipSel.classList.toggle('hidden', info.count < 2);
    }
    if (animClipSel && Number(animClipSel.value) !== info.index) {
      animClipSel.value = String(info.index);
    }
  }

  function refreshLodUI() {
    if (!lodControls || !window.OptiViewer || !window.OptiViewer.getLods) return;
    const info = window.OptiViewer.getLods();
    const has = info.count > 0;
    lodControls.classList.toggle('hidden', !has);
    if (!has || !lodSel) return;

    setText(lodLabel, info.source === 'extension' ? 'vp.lod' : 'vp.lod.guess');

    const signature = info.source + ':' + info.names.join(' ');
    if (lodSel.dataset.signature !== signature) {
      lodSel.dataset.signature = signature;
      lodSel.innerHTML = '';
      const base = document.createElement('option');
      base.value = '';
      setText(base, 'viewer.lod.asFile');
      lodSel.appendChild(base);
      const all = document.createElement('option');
      all.value = 'all';
      setText(all, 'viewer.lod.all');
      lodSel.appendChild(all);
      info.names.forEach((name: string, i: number) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        setText(opt, 'viewer.lod.item', { n: i + 1, tri: info.triangles[i] ?? 0 });
        if (name) opt.title = name;
        lodSel.appendChild(opt);
      });
    }
    const selected = info.selected === null ? '' : String(info.selected);
    if (lodSel.value !== selected) lodSel.value = selected;
  }

  if (lodSel) {
    lodSel.addEventListener('change', () => {
      if (!window.OptiViewer) return;
      const v = lodSel.value;
      window.OptiViewer.selectLod(v === '' ? null : v === 'all' ? 'all' : Number(v));
    });
  }

  function refreshVariantUI() {
    if (!variantControls || !window.OptiViewer || !window.OptiViewer.getVariants) return;
    const info = window.OptiViewer.getVariants();
    const has = info.count > 0;
    variantControls.classList.toggle('hidden', !has);
    if (!has || !variantSel) return;

    const signature = info.names.join(' ');
    if (variantSel.dataset.signature !== signature) {
      variantSel.dataset.signature = signature;
      variantSel.innerHTML = '';
      const base = document.createElement('option');
      base.value = '';
      setText(base, 'viewer.variant.original');
      variantSel.appendChild(base);
      for (const name of info.names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        variantSel.appendChild(opt);
      }
    }
    const selected = info.selected ?? '';
    if (variantSel.value !== selected) variantSel.value = selected;
  }

  if (variantSel) {
    variantSel.addEventListener('change', () => {
      if (!window.OptiViewer) return;
      void window.OptiViewer.selectVariant(variantSel.value || null);
    });
  }

  function refreshInteractivityUI() {
    if (!interactivityBtn) return;
    const info = window.OptiViewer?.getInteractivity?.();
    const has = (info?.count ?? 0) > 0;
    interactivityBtn.classList.toggle('hidden', !has);
    if (!has) return;
    window.I18n.setTitle(
      interactivityBtn,
      info.playable ? 'vp.interactivity.count' : 'vp.interactivity.shownOnly',
      { n: info.count },
    );
    interactivityBtn.classList.toggle('is-on', !!info.shown);
    interactivityBtn.setAttribute('aria-pressed', String(!!info.shown));
  }

  function подписатьсяНаВьюпорт() {
    window.OptiViewer?.setOnBusy?.((busy: boolean) => {
      setBusy('preview-optimized', busy ? 'busy.comparing' : null);
      if (!busy) refreshDiffScale();
    });

    window.OptiViewer?.setOnInteractivePick?.(({ name, responded }) => {
      logMessage(
        responded ? 'info' : 'warn',
        t(responded ? 'log.interactivity.hit' : 'log.interactivity.silent', { name: name || '—' }),
      );
    });
  }

  window.onOptiViewerReady = подписатьсяНаВьюпорт;
  if (window.OptiViewer) подписатьсяНаВьюпорт();

  if (interactivityBtn) {
    interactivityBtn.addEventListener('click', () => {
      window.OptiViewer?.toggleInteractivity?.();
      refreshInteractivityUI();
    });
  }

  const LIGHT_LABEL: Record<string, string> = {
    studio: 'viewer.light.studio',
    none: 'viewer.light.none',
    file: 'viewer.light.file',
  };

  const lightModes = (own: boolean) => (own ? ['studio', 'none', 'file'] : ['studio', 'none']);

  function fillLightSelect(sel: HTMLSelectElement, own: boolean) {
    const signature = own ? 'own' : 'plain';
    if (sel.dataset.filled === signature) return;
    sel.dataset.filled = signature;
    sel.textContent = '';
    for (const mode of lightModes(own)) {
      const opt = document.createElement('option');
      opt.value = mode;
      setText(opt, LIGHT_LABEL[mode] ?? 'viewer.light.studio');
      sel.appendChild(opt);
    }
  }

  function closeLightMenu() {
    lightControls?.classList.remove('is-open');
    lightControls?.querySelector('.vp-group-btn')?.setAttribute('aria-expanded', 'false');
  }

  function refreshLightUI() {
    if (!lightControls || !lightMenu) return;
    const info = window.OptiViewer?.getLight?.();
    const modes = lightModes((info?.count ?? 0) > 0);
    const current = info?.mode ?? 'studio';

    const signature = modes.join(',');
    if (lightMenu.dataset.filled !== signature) {
      lightMenu.dataset.filled = signature;
      lightMenu.textContent = '';
      for (const mode of modes) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'vp-pop-item';
        item.dataset.mode = mode;
        item.setAttribute('role', 'menuitemradio');
        setText(item, LIGHT_LABEL[mode] ?? 'viewer.light.studio');
        item.addEventListener('click', () => {
          window.OptiViewer?.selectLightMode?.(mode as 'studio' | 'file' | 'none');
          refreshLightUI();
          closeLightMenu();
        });
        lightMenu.appendChild(item);
      }
    }
    for (const item of lightMenu.querySelectorAll('.vp-pop-item')) {
      const on = (item as HTMLElement).dataset.mode === current;
      item.classList.toggle('is-on', on);
      item.setAttribute('aria-checked', String(on));
    }
  }

  const SHADING = [
    [displayWireBtn, 'wire'],
    [displayClayBtn, 'clay'],
    [displayFileBtn, 'file'],
    [displayTexdiffBtn, 'texdiff'],
  ] as const;

  function refreshDisplayUI() {
    if (!window.OptiViewer || !window.OptiViewer.getDisplayMaterial) return;
    const now = window.OptiViewer.getDisplayMaterial();
    for (const [btn, mode] of SHADING) {
      if (!btn) continue;
      const on = now === mode;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  for (const [btn, mode] of SHADING) {
    if (!btn) continue;
    btn.addEventListener('click', () => {
      if (!window.OptiViewer) return;
      window.OptiViewer.setDisplayMaterial(mode);
      refreshDisplayUI();
      refreshDiffScale();
    });
  }

  const ТЯЖЁЛЫЙ_РЕЖИМ = 'tanyra.texdiff';
  const texdiffSetting = $('setting-texdiff') as HTMLInputElement | null;

  function texdiffРазрешён() {
    try { return localStorage.getItem(ТЯЖЁЛЫЙ_РЕЖИМ) === '1'; } catch (e) { return false; }
  }

  function применитьTexdiff(on: boolean) {
    displayTexdiffBtn?.classList.toggle('hidden', !on);
    if (texdiffSetting) texdiffSetting.checked = on;
    if (!on && window.OptiViewer?.getDisplayMaterial?.() === 'texdiff') {
      window.OptiViewer.setDisplayMaterial('file');
      refreshDisplayUI();
      refreshDiffScale();
    }
  }

  if (texdiffSetting) {
    texdiffSetting.addEventListener('change', () => {
      const on = texdiffSetting.checked;
      try { localStorage.setItem(ТЯЖЁЛЫЙ_РЕЖИМ, on ? '1' : '0'); } catch (e) {  }
      применитьTexdiff(on);
    });
  }
  применитьTexdiff(texdiffРазрешён());

  const diffScaleEl = $('diff-scale');
  function refreshDiffScale() {
    if (!diffScaleEl) return;
    const режим = window.OptiViewer?.getDisplayMaterial?.();
    const доля = режим === 'texdiff' ? window.OptiViewer?.diffScale?.() ?? null : null;
    if (доля === null) {
      diffScaleEl.classList.add('hidden');
      diffScaleEl.textContent = '';
      return;
    }
    diffScaleEl.classList.remove('hidden');
    if (доля >= 0.9995) setText(diffScaleEl, 'vp.diffScale.none');
    else setText(diffScaleEl, 'vp.diffScale', { n: (доля * 100).toFixed(1) });
  }

  function refreshCameraUI() {
    if (!cameraControls || !window.OptiViewer || !window.OptiViewer.getCameras) return;
    const info = window.OptiViewer.getCameras();
    const has = info.count > 0;
    cameraControls.classList.toggle('hidden', !has);
    if (!has || !cameraSel) return;

    const signature = info.names.join(' ');
    if (cameraSel.dataset.signature !== signature) {
      cameraSel.dataset.signature = signature;
      cameraSel.innerHTML = '';
      const free = document.createElement('option');
      free.value = '';
      setText(free, 'viewer.camera.free');
      cameraSel.appendChild(free);
      info.names.forEach((name: string, i: number) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        if (name) opt.textContent = name;
        else setText(opt, 'viewer.camera.unnamed', { n: i + 1 });
        cameraSel.appendChild(opt);
      });
    }
    const selected = info.current === null ? '' : String(info.current);
    if (cameraSel.value !== selected) cameraSel.value = selected;
  }

  if (cameraSel) {
    cameraSel.addEventListener('change', () => {
      if (!window.OptiViewer) return;
      window.OptiViewer.selectCamera(cameraSel.value === '' ? null : Number(cameraSel.value));
    });
  }

  function syncAnimProgress() {
    if (!window.OptiViewer || !window.OptiViewer.getAnimation) return;
    const info = window.OptiViewer.getAnimation();
    if (!info.count) return;
    const dur = info.duration || 0;
    const t = dur > 0 ? (info.time % dur) : 0;
    if (animTimeEl) animTimeEl.textContent = fmtTime(t);
    if (animSeek && !seekDragging && dur > 0) {
      animSeek.value = String(Math.round((t / dur) * SEEK_STEPS));
    }
  }

  function startAnimPolling() {
    if (animPollId != null) return;
    const tick = () => {
      syncAnimProgress();
      animPollId = requestAnimationFrame(tick);
    };
    animPollId = requestAnimationFrame(tick);
  }

  function refreshAnimLabels() {
    if (!animPlayBtn) return;
    const playing = animPlayBtn.classList.contains('is-on');
    window.I18n.setTitle(animPlayBtn, playing ? 'vp.pause' : 'vp.play');
    window.I18n.setAria(animPlayBtn, playing ? 'vp.pause' : 'vp.play');
  }

  function toggleAnimation() {
    if (!animPlayBtn) return;
    const playing = !animPlayBtn.classList.contains('is-on');
    animPlayBtn.classList.toggle('is-on', playing);
    animPlayBtn.setAttribute('aria-pressed', String(playing));
    animPlayBtn.textContent = playing ? '⏸' : '▶';
    refreshAnimLabels();
    if (window.OptiViewer) window.OptiViewer.setAnimationPlaying(playing);
  }

  if (animPlayBtn) animPlayBtn.addEventListener('click', toggleAnimation);

  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const el = document.activeElement as HTMLElement | null;
    if (el) {
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      if (el.isContentEditable) return;
    }
    if (!animControls || animControls.classList.contains('hidden')) return;
    e.preventDefault();
    toggleAnimation();
  });

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

  const groupHosts = Array.from(document.querySelectorAll('.vp-rail, .vp-toolbar'));

  const closeGroups = () => {
    for (const g of document.querySelectorAll('.vp-group.is-open')) {
      g.classList.remove('is-open');
      g.querySelector('.vp-group-btn')?.setAttribute('aria-expanded', 'false');
    }
  };

  for (const host of groupHosts) {
    host.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest('.vp-group-btn');
      if (!btn) return;
      const group = btn.closest('.vp-group');
      if (!group) return;
      const wasOpen = group.classList.contains('is-open');
      closeGroups();
      if (!wasOpen) {
        group.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (groupHosts.some((h) => h.contains(e.target as Node))) return;
    closeGroups();
  });

  function closeHiddenGroups() {
    for (const g of document.querySelectorAll('.vp-group.hidden.is-open')) {
      g.classList.remove('is-open');
      g.querySelector('.vp-group-btn')?.setAttribute('aria-expanded', 'false');
    }
  }

  window.onOptiViewerModelLoaded = () => {
    refreshAnimUI(); refreshVariantUI(); refreshLodUI();
    refreshLightUI(); refreshCameraUI(); refreshDisplayUI(); refreshInteractivityUI(); closeHiddenGroups();
    refreshDiffScale();
  };
  refreshAnimUI();
  refreshVariantUI();
  refreshLodUI();
  refreshLightUI();
  refreshCameraUI();
  refreshDisplayUI();
  startAnimPolling();

  if (exposureSlider) {
    const applyExposure = () => {
      const v = Number(exposureSlider.value) / 100;
      if (exposureValue) exposureValue.textContent = v.toFixed(1);
      if (window.OptiViewer && window.OptiViewer.setExposure) window.OptiViewer.setExposure(v);
    };
    exposureSlider.addEventListener('input', applyExposure);
    exposureSlider.addEventListener('dblclick', () => {
      exposureSlider.value = '100';
      applyExposure();
    });
  }

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

  window.I18n.onChange(async () => {
    renderLangSwitch();
    updateRunButtonState();
    updateLogsBar();
    renderDecoderLegend();
    refreshBusyLabels();
    refreshAnimLabels();
    renderModelList();
    if (!logsWindow.classList.contains('hidden')) renderLogsWindow();
    await reloadPlatformTitles();
    await relabelExtensions();
    await reexplainLastResult();
    if (!validationWindow.classList.contains('hidden')) renderValidationWindow();
    if (!metadataWindow.classList.contains('hidden')) renderMetadataWindow();
    if (!summaryWindow.classList.contains('hidden')) renderSummaryWindow();
    if (!profileWindow.classList.contains('hidden')) await relabelProfileForm();
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
