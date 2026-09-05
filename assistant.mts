import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


import type { MessageCatalog, MessageData } from './core/types.mjs';

type Translate = (key: string, data?: MessageData) => string;

type ProfileJson = Record<string, any>;

type EngineJson = Record<string, any>;

type ExtensionEntry = Record<string, any> & { id: string };

type MetricsLike = Record<string, any>;

type RunResultLike = Record<string, any>;

interface BudgetEntry {
  warn?: number;
  limit?: number;
  source?: string;
  by?: string;
  [key: string]: unknown;
}

interface BudgetCheck {
  id: string;
  name: string;
  actualText: string;
  level: string;
  source?: string;
  by?: string;
  limitText?: string;
  warnText?: string;
  advice?: string;
}

interface BudgetSpec {
  nameKey: string;
  adviceKey: string;
  value: (after: MetricsLike) => number | undefined;
  unit: 'int' | 'mb' | 'px';
}

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(BASE_DIR, 'profiles');
const ENGINES_DIR = path.join(BASE_DIR, 'engines');


const DEFAULT_LANG = 'en';

const CATALOGS: Record<string, MessageCatalog> = {};
await (async () => {
  const dir = path.join(BASE_DIR, 'messages');
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch {  }
  for (const name of names.sort()) {
    const m = /^([a-z]{2}(?:-[a-z]{2})?)\.mjs$/i.exec(name);
    if (!m) continue;
    try {
      const mod = await import(pathToFileURL(path.join(dir, name)).href);
      if (mod.default && typeof mod.default === 'object') CATALOGS[m[1]!.toLowerCase()] = mod.default;
    } catch (e) {
      console.warn(`[i18n] каталог отчёта ${name} не загрузился: ${(e as Error).message}`);
    }
  }
})();

export function listLanguages() {
  return Object.keys(CATALOGS);
}

function messages(lang: string): Translate {
  const cat = CATALOGS[lang] || CATALOGS[DEFAULT_LANG]!;
  return (key: string, data?: MessageData) => {
    const fn = cat[key] || CATALOGS[DEFAULT_LANG]![key];
    return typeof fn === 'function' ? fn(data || {}) : key;
  };
}

function pick(value: unknown, lang: string): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return (value as Record<string, string>)[lang] ?? (value as Record<string, string>)[DEFAULT_LANG] ?? '';
  return String(value);
}



function userProfilesDir(): string {
  const override = process.env.TANYRA3D_PROFILES_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Tanyra3D', 'profiles');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Tanyra3D', 'profiles');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Tanyra3D', 'profiles');
}

function profileFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

function safeId(id: string): string {
  return String(id).replace(/[^a-z0-9_-]/gi, '');
}

const PROFILE_DIRS = () => [
  { dir: PROFILES_DIR, custom: false },
  { dir: userProfilesDir(), custom: true },
];

function profileEntries(dir: string): Array<{ id: string; file: string; profile: ProfileJson }> {
  const out = [];
  for (const f of profileFiles(dir)) {
    const file = path.join(dir, f);
    try {
      const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (profile && profile.id) out.push({ id: String(profile.id), file, profile });
    } catch {
    }
  }
  return out;
}

function profilePath(id: string): { file: string; custom: boolean } | null {
  const wanted = String(id);
  const name = `${safeId(wanted)}.json`;
  if (name !== '.json') {
    for (const { dir, custom } of PROFILE_DIRS()) {
      const direct = path.join(dir, name);
      if (fs.existsSync(direct)) return { file: direct, custom };
    }
  }
  for (const { dir, custom } of PROFILE_DIRS()) {
    const hit = profileEntries(dir).find((e) => e.id === wanted);
    if (hit) return { file: hit.file, custom };
  }
  return null;
}

export const NO_PLATFORM = '';

const NONE_DEFAULTS = '_none';

function noneDefaults() {
  try {
    const found = profilePath(NONE_DEFAULTS);
    if (found) return JSON.parse(fs.readFileSync(found.file, 'utf8'));
  } catch {
  }
  return {};
}

function syntheticProfile(engineId: string, lang: string = DEFAULT_LANG): ProfileJson {
  const id = engineId || DEFAULT_ENGINE;
  const engine = loadEngine(id);
  const defaults = noneDefaults();
  return {
    id: NO_PLATFORM,
    engine: id,
    title: null,
    description: pick(defaults.description, lang),
    budgets: defaults.budgets || {},
    baselineOpts: (engine && engine.baselineOpts) || defaults.baselineOpts || {},
    notes: defaults.notes || [],
  };
}

function loadProfile(platformId: string, engineId?: string, lang: string = DEFAULT_LANG): ProfileJson {
  if (!platformId) return syntheticProfile(engineId!, lang);
  const found = profilePath(platformId);
  if (!found) {
    const known = listPlatforms().map((p) => p.id).join(', ');
    throw new Error(`Unknown platform "${platformId}". Available: ${known || '—'}.`);
  }
  try {
    const profile = JSON.parse(fs.readFileSync(found.file, 'utf8'));
    profile.custom = found.custom;
    return profile;
  } catch (e) {
    throw new Error(`Profile "${platformId}" is corrupted: ${(e as Error).message}`, { cause: e });
  }
}


const DEFAULT_ENGINE = 'threejs';

function enginePath(id: string): string {
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  return path.join(ENGINES_DIR, `${safe}.json`);
}

function loadEngine(engineId: string): EngineJson | null {
  const id = engineId || DEFAULT_ENGINE;
  const file = enginePath(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Engine "${id}" is corrupted: ${(e as Error).message}`, { cause: e });
  }
}

function engineIdOf(profile: ProfileJson, asked?: string): string {
  return (profile && profile.engine) || asked || DEFAULT_ENGINE;
}

function dictatesEngine(profile: ProfileJson): boolean {
  return !!(profile && profile.engine);
}

export function listEngines(lang: string = DEFAULT_LANG) {
  let files;
  try {
    files = fs.readdirSync(ENGINES_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, f), 'utf8'));
      if (e && e.id && e.enabled !== false) {
        out.push({
          id: e.id,
          title: pick(e.title, lang) || e.id,
          description: pick(e.description, lang),
          viewer: e.viewer || e.id,
          primary: e.primary === true,
        });
      }
    } catch {
    }
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary));
}

export function noPlatformInfo(lang: string = DEFAULT_LANG) {
  const d = noneDefaults();
  return { description: pick(d.description, lang) };
}

export function platformsForEngine(engineId: string, lang: string = DEFAULT_LANG) {
  return listPlatforms(lang).filter((p) => {
    try {
      const profile = loadProfile(p.id);
      return !dictatesEngine(profile) || engineIdOf(profile) === engineId;
    } catch {
      return false;
    }
  });
}

export function enginesForPlatform(platformId: string, lang: string = DEFAULT_LANG) {
  let profile;
  try {
    profile = loadProfile(platformId);
  } catch {
    return [];
  }
  if (!dictatesEngine(profile)) return listEngines(lang);
  const wanted = engineIdOf(profile);
  return listEngines(lang).filter((e) => e.id === wanted);
}


const MB = (bytes: number) => bytes / (1024 * 1024);

const UNITS: Record<string, { kb: string; mb: string; locale: string }> = {
  en: { kb: 'KB', mb: 'MB', locale: 'en-US' },
  ru: { kb: 'КБ', mb: 'МБ', locale: 'ru-RU' },
};

function formatters(lang: string) {
  const u = UNITS[lang] || UNITS[DEFAULT_LANG]!;
  return {
    fmtMB: (bytes: number) => (bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} ${u.kb}`
      : `${MB(bytes).toFixed(1)} ${u.mb}`),
    fmtInt: (n: number) => Number(n).toLocaleString(u!.locale),
  };
}


function pctMagnitude(before: number, after: number) {
  if (!before) return '0';
  const abs = Math.abs(((after - before) / before) * 100);
  const shown = abs.toFixed(abs >= 1 ? 0 : abs >= 0.1 ? 1 : 2);
  return Number(shown) === 0 && abs > 0 ? '<0.01' : shown;
}

function pctText(before: number, after: number) {
  if (!before || after === before) return '0%';
  return (after < before ? '−' : '+') + pctMagnitude(before, after) + '%';
}

const HIGHLIGHT_MIN_PCT = 1;

function timesLess(before: number, after: number) {
  if (!after) return null;
  const ratio = before / after;
  if (ratio < 1.15) return null;
  return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`;
}


function profileUnknowns(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  const budgets = (p && (p as { budgets?: Record<string, unknown> }).budgets) || {};
  for (const [key, raw] of Object.entries(budgets)) {
    if (!(key in BUDGET_SPEC)) { out.push(key); continue; }
    const by = raw && typeof raw === 'object' ? (raw as { by?: unknown }).by : undefined;
    if (by !== undefined && by !== 'project' && by !== 'user') out.push(`${key}.by`);
  }
  return out.sort();
}

export function listPlatforms(lang: string = DEFAULT_LANG) {
  const out = [];
  const seen = new Set<string>();
  for (const { dir, custom } of PROFILE_DIRS()) {
    for (const { id, profile: p } of profileEntries(dir)) {
      if (p.enabled === false) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title: pick(p.title, lang) || id,
        description: pick(p.description, lang),
        source: pick(p.source, lang),
        engine: dictatesEngine(p) ? engineIdOf(p) : null,
        custom,
        unknown: profileUnknowns(p as Record<string, unknown>),
      });
    }
  }
  return out;
}

export function customProfilesDir(): string {
  return userProfilesDir();
}


export function planFor(platformId: string, lang: string = DEFAULT_LANG, engineId?: string) {
  const t = messages(lang);
  const { fmtInt } = formatters(lang);
  const profile = loadProfile(platformId, engineId, lang);
  const opts = profile.baselineOpts || profile.engineOpts
    || (loadEngine(engineIdOf(profile, engineId)) || {}).baselineOpts || {};
  const b = profile.budgets || {};

  const explanation = [];

  explanation.push(t(opts.codec === 'draco' ? 'plan.geometry.draco' : 'plan.geometry.meshopt'));

  explanation.push(t('plan.cleanup'));

  if (opts.noKtx) explanation.push(t('plan.textures.keep'));
  else if (opts.texMode === 'uastc') explanation.push(t('plan.textures.uastc'));
  else explanation.push(t('plan.textures.mixed'));

  explanation.push(t(opts.keepParts ? 'plan.parts.keep' : 'plan.parts.join'));

  if (opts.stripColors) explanation.push(t('plan.stripColors'));

  const warnOf = (id: string) => (budgetEntry(b[id]) || {}).warn;
  const targetBits = [];
  if (warnOf('triangles')) targetBits.push(t('plan.goal.triangles', { n: fmtInt(warnOf('triangles')!) }));
  if (warnOf('textureMaxSize')) targetBits.push(t('plan.goal.textureSize', { px: warnOf('textureMaxSize') }));
  if (warnOf('vramMB')) targetBits.push(t('plan.goal.vram', { mb: warnOf('vramMB') }));
  if (targetBits.length) {
    explanation.push(t('plan.goal', { title: pick(profile.title, lang), bits: targetBits.join(', ') }));
  }

  return {
    profileId: profile.id,
    title: pick(profile.title, lang),
    engine: engineIdOf(profile, engineId),
    engineInfo: (() => {
      const e = loadEngine(engineIdOf(profile, engineId));
      return e ? { id: e.id, title: pick(e.title, lang) || e.id, description: pick(e.description, lang), viewer: e.viewer || e.id } : null;
    })(),
    engineOpts: { ...opts },
    advises: profile.advises || {},
    explanation,
    availableExtensions: extensionsOf(profile, lang),
  };
}


function optionText(id: string, field: string, lang: string, override?: unknown) {
  if (override != null && override !== '') return pick(override, lang);
  const t = messages(lang);
  const key = `option.${id}.${field}`;
  const text = t(key);
  return text === key ? '' : text;
}

export function narrowToPlatform(list: ExtensionEntry[], profile: ProfileJson): ExtensionEntry[] {
  const drop = new Set(Array.isArray(profile && profile.excludeExtensions) ? profile.excludeExtensions : []);
  return drop.size ? list.filter((e) => !drop.has(e.id)) : list;
}

function extensionsOf(profile: ProfileJson, lang: string = DEFAULT_LANG, engineId?: string): ExtensionEntry[] {
  const engine = loadEngine(engineIdOf(profile, engineId));
  const all = engine && Array.isArray(engine.availableExtensions) ? engine.availableExtensions : [];
  const list = narrowToPlatform(all, profile);
  return list.map((e) => ({
    ...e,
    title: optionText(e.id, 'title', lang, e.title),
    description: optionText(e.id, 'description', lang, e.description),
    impact: optionText(e.id, 'impact', lang, e.impact),
    opts: { ...(e.opts || {}) },
  }));
}

export function getAvailableExtensions(platformId: string, lang: string = DEFAULT_LANG, engineId?: string) {
  return extensionsOf(loadProfile(platformId, engineId, lang), lang, engineId);
}

export const listExtensions = getAvailableExtensions;


export function explainResult(runResult: RunResultLike, platformId: string, lang: string = DEFAULT_LANG) {
  const t = messages(lang);
  const { fmtMB, fmtInt } = formatters(lang);
  const profile = loadProfile(platformId);

  const rr = runResult || {};
  const before = rr.metrics && rr.metrics.before;
  const after = rr.metrics && rr.metrics.after;

  if (rr.error) {
    return {
      summary: t('status.error', { error: rr.error }),
      highlights: [],
      budgetChecks: [],
      warnings: [],
    };
  }
  if (rr.status === 'skip') {
    return {
      summary: t('status.skip'),
      highlights: [],
      budgetChecks: [],
      warnings: [],
    };
  }
  if (!before || !after) {
    return {
      summary: t('status.noMetrics'),
      highlights: [],
      budgetChecks: [],
      warnings: collectWarnings(rr, t),
    };
  }

  const fileGrew = after.fileBytes > before.fileBytes;
  const vramDropped = after.gpuBytes < before.gpuBytes;

  const sizes = {
    fileBefore: fmtMB(before.fileBytes),
    fileAfter: fmtMB(after.fileBytes),
    filePct: pctText(before.fileBytes, after.fileBytes),
    vramBefore: fmtMB(before.gpuBytes),
    vramAfter: fmtMB(after.gpuBytes),
    vramPct: pctText(before.gpuBytes, after.gpuBytes),
  };
  let summary = t(rr.status === 'fail' ? 'summary.doneWithIssue' : 'summary.done', sizes);
  if (rr.status !== 'fail' && fileGrew && vramDropped) {
    summary += t('summary.fileGrewVramDropped');
  }

  const highlights = [];
  const gainPct = (b: number, a: number) => (b ? ((b - a) / b) * 100 : 0);

  if (gainPct(before.fileBytes, after.fileBytes) >= HIGHLIGHT_MIN_PCT) {
    highlights.push(t('hi.fileLighter', { pct: Math.round(gainPct(before.fileBytes, after.fileBytes)) }));
  } else if (fileGrew && vramDropped) {
    const tl = timesLess(before.gpuBytes, after.gpuBytes);
    highlights.push(tl ? t('hi.vramTimesLess', { times: tl }) : t('hi.vramDropped'));
  }

  if (!fileGrew && gainPct(before.gpuBytes, after.gpuBytes) >= HIGHLIGHT_MIN_PCT) {
    highlights.push(t('hi.vramPct', { pct: Math.round(gainPct(before.gpuBytes, after.gpuBytes)) }));
  }

  if (after.drawCalls < before.drawCalls) {
    highlights.push(t('hi.drawCalls', { before: fmtInt(before.drawCalls), after: fmtInt(after.drawCalls) }));
  }

  if (before.triangles > 0 && after.triangles === before.triangles) {
    highlights.push(t('hi.shapeKept', { n: fmtInt(after.triangles) }));
  } else if (before.triangles > 0 && after.triangles < before.triangles) {
    highlights.push(t('hi.trianglesRemoved', { before: fmtInt(before.triangles), after: fmtInt(after.triangles) }));
  }

  if (Array.isArray(rr.applied) && rr.applied.length) {
    highlights.push(t('hi.applied', { n: rr.applied.length }));
  }

  return {
    summary,
    highlights: highlights.slice(0, 6),
    budgetChecks: buildBudgetChecks(
      profile.budgets || {}, after, lang, profile.custom === true, pick(profile.source, lang),
    ),
    warnings: collectWarnings(rr, t),
  };
}


const BUDGET_SPEC: Record<string, BudgetSpec> = {
  triangles: { nameKey: 'budget.triangles', adviceKey: 'advice.triangles', value: (a) => a.triangles, unit: 'int' },
  materials: { nameKey: 'budget.materials', adviceKey: 'advice.materials', value: (a) => a.materials, unit: 'int' },
  drawCalls: { nameKey: 'budget.drawCalls', adviceKey: 'advice.drawCalls', value: (a) => a.drawCalls, unit: 'int' },
  vramMB: { nameKey: 'budget.vram', adviceKey: 'advice.vram', value: (a) => a.gpuBytes, unit: 'mb' },
  fileMB: { nameKey: 'budget.file', adviceKey: 'advice.file', value: (a) => a.fileBytes, unit: 'mb' },
  textureMaxSize: {
    nameKey: 'budget.textureSize', adviceKey: 'advice.textureSize',
    value: (a) => a.textureMaxSize, unit: 'px',
  },
};

function budgetEntry(raw: unknown): BudgetEntry | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return { warn: raw };
  if (typeof raw === 'object') return raw as BudgetEntry;
  return null;
}

function buildBudgetChecks(
  budgets: Record<string, unknown>,
  after: MetricsLike,
  lang: string = DEFAULT_LANG,
  custom = false,
  defaultSource = '',
) {
  const t = messages(lang);
  const { fmtMB, fmtInt } = formatters(lang);
  const checks = [];

  for (const [id, spec] of Object.entries(BUDGET_SPEC)) {
    const entry = budgetEntry(budgets[id]);
    if (!entry) continue;
    const raw = spec.value(after);
    if (raw == null) continue;
    if (spec.unit === 'px' && raw === 0) continue;

    const actual = spec.unit === 'mb' ? MB(raw) : raw;
    const show = spec.unit === 'mb' ? fmtMB(raw)
      : spec.unit === 'px' ? t('unit.pxValue', { v: fmtInt(raw) })
        : fmtInt(raw);
    const fmt = (v: number) => (
      spec.unit === 'mb' ? `${v} ${t('unit.mb')}`
        : spec.unit === 'px' ? t('unit.pxValue', { v: fmtInt(v) })
          : fmtInt(v)
    );

    const check: BudgetCheck = { id, name: t(spec.nameKey), actualText: show, level: 'none' };
    if (entry.source || defaultSource) check.source = entry.source || defaultSource;
    if (!check.source && entry.by) check.by = entry.by;
    if (custom) check.by = 'user';

    if (entry.limit != null) check.limitText = t('budget.limit', { v: fmt(entry.limit) });
    if (entry.warn != null) check.warnText = t('budget.recommended', { v: fmt(entry.warn) });

    if (entry.limit != null && actual > entry.limit) {
      check.level = 'over';
      check.advice = t('advice.overLimit', { name: check.name, actual: show, limit: fmt(entry.limit) });
    } else if (entry.warn != null && actual > entry.warn) {
      check.level = 'warn';
      check.advice = t(spec.adviceKey, { actual: show, warn: fmt(entry.warn) });
    } else if (entry.warn != null || entry.limit != null) {
      check.level = 'ok';
    }

    checks.push(check);
  }

  return checks;
}


export class ProfileError extends Error {
  code: string;
  field: string;
  constructor(code: string, field = '') {
    super(code);
    this.name = 'ProfileError';
    this.code = code;
    this.field = field;
  }
}

const MAX_TEXT = 150;

export interface CustomProfileInput {
  id?: string;
  title?: string;
  engine?: string | null;
  description?: string;
  source?: string;
  budgets?: Record<string, unknown>;
  budgetKinds?: Record<string, unknown>;
  excludeExtensions?: unknown;
}

export function profileTemplate(lang: string = DEFAULT_LANG) {
  const t = messages(lang);
  const fields = Object.entries(BUDGET_SPEC).map(([id, spec]) => ({
    id,
    name: t(spec.nameKey),
    unit: spec.unit === 'mb' ? t('unit.mb') : spec.unit === 'px' ? t('unit.px') : '',
  }));
  return { dir: userProfilesDir(), fields };
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

function slugFrom(title: string): string {
  const latin = [...String(title).toLowerCase()]
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join('');
  return safeId(latin.replace(/\s+/g, '-'))
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const FALLBACK_PROFILE_ID = 'platform';

function freeProfileId(base: string): string {
  const root = base || FALLBACK_PROFILE_ID;
  if (!profilePath(root)) return root;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${root}-${n}`;
    if (!profilePath(candidate)) return candidate;
  }
  throw new ProfileError('id_taken');
}

export function saveCustomProfile(input: CustomProfileInput) {
  const title = String((input && input.title) || '').trim();
  if (!title) throw new ProfileError('title_required');

  const engine = String((input && input.engine) || DEFAULT_ENGINE);
  if (!loadEngine(engine)) throw new ProfileError('engine_unknown', 'engine');

  let id = safeId(String((input && input.id) || ''));
  if (id) {
    const found = profilePath(id);
    if (found && !found.custom) throw new ProfileError('builtin_id', 'title');
  } else {
    id = freeProfileId(slugFrom(title));
  }

  const budgets: Record<string, { warn: number } | { limit: number }> = {};
  for (const key of Object.keys(BUDGET_SPEC)) {
    const raw = input && input.budgets ? input.budgets[key] : undefined;
    if (raw == null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new ProfileError('bad_number', key);
    const kind = input && input.budgetKinds ? input.budgetKinds[key] : undefined;
    budgets[key] = kind === 'limit' ? { limit: n } : { warn: n };
  }

  const raw = input && input.excludeExtensions;
  const exclude = Array.isArray(raw)
    ? [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))]
    : [];

  const description = String((input && input.description) || '').trim();
  if (description.length > MAX_TEXT) throw new ProfileError('too_long', 'description');
  const source = String((input && input.source) || '').trim();
  if (source.length > MAX_TEXT) throw new ProfileError('too_long', 'source');

  const profile: ProfileJson = {
    id,
    engine,
    enabled: true,
    title,
    ...(description ? { description } : {}),
    ...(source ? { source } : {}),
    budgets,
    ...(exclude.length ? { excludeExtensions: exclude } : {}),
    createdAt: new Date().toISOString(),
  };

  const dir = userProfilesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return { id, file };
}

export function readCustomProfile(id: string, lang: string = DEFAULT_LANG): CustomProfileInput {
  const found = profilePath(safeId(String(id || '')));
  if (!found) throw new ProfileError('unknown_profile');
  if (!found.custom) throw new ProfileError('builtin_id');
  const p = JSON.parse(fs.readFileSync(found.file, 'utf8'));
  const budgets: Record<string, number> = {};
  const budgetKinds: Record<string, 'warn' | 'limit'> = {};
  for (const key of Object.keys(BUDGET_SPEC)) {
    const entry = budgetEntry((p.budgets || {})[key]);
    if (!entry) continue;
    if (entry.limit != null) { budgets[key] = entry.limit; budgetKinds[key] = 'limit'; }
    else if (entry.warn != null) { budgets[key] = entry.warn; budgetKinds[key] = 'warn'; }
  }
  return {
    id: p.id,
    title: pick(p.title, lang) || p.id,
    engine: dictatesEngine(p) ? engineIdOf(p) : null,
    description: pick(p.description, lang),
    source: pick(p.source, lang),
    budgets,
    budgetKinds,
    excludeExtensions: Array.isArray(p.excludeExtensions) ? p.excludeExtensions : [],
  };
}


export function exportCustomProfile(id: string) {
  const found = profilePath(safeId(String(id || '')));
  if (!found) throw new ProfileError('unknown_profile');
  if (!found.custom) throw new ProfileError('builtin_id');
  return { id: safeId(String(id)), json: fs.readFileSync(found.file, 'utf8') };
}

export function importCustomProfile(text: string) {
  let raw: ProfileJson;
  try {
    raw = JSON.parse(String(text));
  } catch {
    throw new ProfileError('bad_file');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileError('bad_file');
  const title = pick(raw.title, DEFAULT_LANG)
    || (raw.title && typeof raw.title === 'object' ? Object.values(raw.title as Record<string, string>).find(Boolean) || '' : '');
  if (!title) throw new ProfileError('title_required');

  const wanted = safeId(String(raw.id || '')) || slugFrom(title);
  const found = wanted ? profilePath(wanted) : null;
  const id = found && !found.custom ? freeProfileId(wanted) : (wanted || freeProfileId(''));
  const replaced = Boolean(found && found.custom);

  const profile: ProfileJson = {
    ...raw,
    id,
    enabled: true,
  };
  delete profile.custom;

  const dir = userProfilesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return { id, replaced };
}

export function deleteCustomProfile(id: string) {
  const found = profilePath(safeId(String(id || '')));
  if (!found) throw new ProfileError('unknown_profile');
  if (!found.custom) throw new ProfileError('builtin_id');
  fs.unlinkSync(found.file);
  return { id: safeId(String(id)) };
}


function collectWarnings(rr: RunResultLike, t: Translate = messages(DEFAULT_LANG)) {
  const warnings: string[] = [];

  if (Array.isArray(rr.skipped)) {
    for (const s of rr.skipped) {
      if (!s || !s.text) continue;
      if (s.kind === 'disabled' || s.kind === 'nothing') continue;
      if (s.kind === 'cost') { warnings.push(s.text); continue; }
      const reason = s.reason && s.reason !== s.text && !s.text.includes(s.reason) ? ` — ${s.reason}` : '';
      warnings.push(t('warn.notApplied', { text: s.text, reason }));
    }
  }

  if (Array.isArray(rr.validation)) {
    for (const v of rr.validation) {
      if (!v || !v.text) continue;
      if (v.level === 'info' || v.level === 'fail') warnings.push(v.text);
    }
  }

  return warnings;
}
