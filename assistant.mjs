// assistant.mjs — слой ассистента (ai-assistant) поверх ядра optimize2.mjs.
//
// Роль: превратить выбор платформы в план обработки (engineOpts для ядра) и
// перевести результат работы ядра (RunResult из ARCHITECTURE.md §4b) на человеческий
// язык — для правой панели «Анализ» веб-интерфейса. Пользовательский текст — английский
// (продукт англоязычный); комментарии — рабочие заметки, остаются русскими.
//
// ВАЖНО: этот модуль НЕ импортирует optimize2.mjs. Ядро вызывает web-interface, не мы.
// Профили платформ — это ДАННЫЕ (profiles/*.json). Новая платформа = новый json-файл
// без правки этого кода.
//
// Экспорты — зафиксированный контракт с web-interface (ARCHITECTURE.md §4c):
//   listPlatforms()                     → [{ id, title, description }]
//   planFor(platformId)                 → { profileId, title, engineOpts, explanation: [string],
//                                           availableExtensions: [...] }  // engineOpts = БАЗОВЫЙ план (без KTX2/Draco)
//   getAvailableExtensions(platformId)  → [{ id, title, description, impact, opts }]
//   listExtensions(platformId)          → алиас getAvailableExtensions (имя, которое ждёт server.mjs)
//   explainResult(runResult, platformId)→ { summary, highlights, budgetChecks, warnings }
//
// v0.0.8: профиль разделён на baselineOpts (базовые оптимизации — всегда и везде,
// KTX2 ВЫКЛЮЧЕН: noKtx:true) и availableExtensions (опциональные расширения — KTX2,
// Draco, strip-colors; включает пользователь). web-interface передаёт выбранные id
// расширений в optimizeFile как advancedFeatures: ['ktx2', ...] — ядро само
// переводит их в опции; поле opts у расширения — эквивалент для legacy-пути.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import enMessages from './messages/en.mjs';
import ruMessages from './messages/ru.mjs';

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(BASE_DIR, 'profiles');

// ----------------------------------------------------------------------------
// Язык отчёта
//
// Английский — основа: на него откатывается любой каталог при нехватке ключа, и он
// же используется, когда язык не передан. Добавить язык = добавить messages/<код>.mjs
// и строку в CATALOGS.
// ----------------------------------------------------------------------------

const CATALOGS = { en: enMessages, ru: ruMessages };
const DEFAULT_LANG = 'en';

export function listLanguages() {
  return Object.keys(CATALOGS);
}

// Возвращает функцию t(key, data) для выбранного языка.
function messages(lang) {
  const cat = CATALOGS[lang] || CATALOGS[DEFAULT_LANG];
  return (key, data) => {
    const fn = cat[key] || CATALOGS[DEFAULT_LANG][key];
    // Отсутствующий ключ отдаём как есть — недоперевод должен быть виден, а не
    // превращаться в пустую строку посреди отчёта.
    return typeof fn === 'function' ? fn(data || {}) : key;
  };
}

// Поле профиля может быть строкой (тогда это английский) или объектом { en, ru, ... }.
// Профиль от стороннего автора с обычными строками работает без изменений — требовать
// от него перевода на все языки значит не получить сторонних профилей.
function pick(value, lang) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value[lang] ?? value[DEFAULT_LANG] ?? '';
  return String(value);
}

// ----------------------------------------------------------------------------
// Загрузка профилей (данные, не код)
// ----------------------------------------------------------------------------

function profilePath(id) {
  // защита от выхода за пределы папки профилей (id приходит из UI)
  const safe = String(id).replace(/[^a-z0-9_-]/gi, '');
  return path.join(PROFILES_DIR, `${safe}.json`);
}

function loadProfile(platformId) {
  if (!platformId) throw new Error('No platform specified.');
  const file = profilePath(platformId);
  if (!fs.existsSync(file)) {
    const known = listPlatforms().map((p) => p.id).join(', ');
    throw new Error(`Unknown platform "${platformId}". Available: ${known || '—'}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Profile "${platformId}" is corrupted: ${e.message}`);
  }
}

// ----------------------------------------------------------------------------
// Форматирование чисел для человеческих текстов (байты → МБ здесь, не в ядре)
// ----------------------------------------------------------------------------

const MB = (bytes) => bytes / (1024 * 1024);

// Единицы и разделитель разрядов — часть языка, а не константа. «11.4 MB» и «500,000»
// посреди русского текста читаются как недоделка, потому что это она и есть.
const UNITS = {
  en: { kb: 'KB', mb: 'MB', locale: 'en-US' },
  ru: { kb: 'КБ', mb: 'МБ', locale: 'ru-RU' },
};

// Возвращает форматтеры под язык. Внутри exported-функций результат кладётся в
// одноимённые const — они перекрывают модульные, поэтому вызовы не переписываются.
function formatters(lang) {
  const u = UNITS[lang] || UNITS[DEFAULT_LANG];
  return {
    // Человеческий размер: до 1 МБ показываем в КБ, иначе в МБ — крошечные модели
    // не должны выглядеть как «0.0 МБ».
    fmtMB: (bytes) => (bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} ${u.kb}`
      : `${MB(bytes).toFixed(1)} ${u.mb}`),
    fmtInt: (n) => Number(n).toLocaleString(u.locale),
  };
}

const { fmtMB, fmtInt } = formatters(DEFAULT_LANG);

function deltaPct(before, after) {
  if (!before) return 0;
  return Math.round(((after - before) / before) * 100);
}

// «−18%» / «+220%» / «no change»
function pctText(before, after) {
  const p = deltaPct(before, after);
  if (p === 0) return 'no change';
  return p < 0 ? `−${Math.abs(p)}%` : `+${p}%`;
}

// «4×» / «4.5×» — множитель для нейтрального объяснения падения VRAM
function timesLess(before, after) {
  if (!after) return null;
  const ratio = before / after;
  if (ratio < 1.15) return null;
  return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`;
}

// ----------------------------------------------------------------------------
// listPlatforms()
// ----------------------------------------------------------------------------

export function listPlatforms(lang = DEFAULT_LANG) {
  let files;
  try {
    files = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
      // v0.1.0: показываем только включённые платформы (enabled: true или не указано = true)
      if (p && p.id && p.enabled !== false) {
        out.push({ id: p.id, title: pick(p.title, lang) || p.id, description: pick(p.description, lang) });
      }
    } catch {
      /* повреждённый профиль просто не показываем в списке */
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// planFor(platformId) — план обработки + объяснение выбора настроек
// ----------------------------------------------------------------------------

export function planFor(platformId, lang = DEFAULT_LANG) {
  const t = messages(lang);
  const { fmtInt } = formatters(lang);
  const profile = loadProfile(platformId);
  // v0.0.8: базовый план строится из baselineOpts (KTX2/Draco выключены);
  // engineOpts — legacy-поле старых профилей, оставлено как фолбэк
  const opts = profile.baselineOpts || profile.engineOpts || {};
  const b = profile.budgets || {};

  const explanation = [];

  // геометрия
  explanation.push(t(opts.codec === 'draco' ? 'plan.geometry.draco' : 'plan.geometry.meshopt'));

  // чистка структуры — базовая часть плана, происходит всегда
  explanation.push(t('plan.cleanup'));

  // текстуры
  if (opts.noKtx) explanation.push(t('plan.textures.keep'));
  else if (opts.texMode === 'uastc') explanation.push(t('plan.textures.uastc'));
  else explanation.push(t('plan.textures.mixed'));

  // сборка деталей
  explanation.push(t(opts.keepParts ? 'plan.parts.keep' : 'plan.parts.join'));

  // цвета вершин
  if (opts.stripColors) explanation.push(t('plan.stripColors'));

  // цель по бюджету платформы
  const targetBits = [];
  if (b.triangles) targetBits.push(t('plan.goal.triangles', { n: fmtInt(b.triangles) }));
  if (b.textureMaxSize) targetBits.push(t('plan.goal.textureSize', { px: b.textureMaxSize }));
  if (b.vramMB) targetBits.push(t('plan.goal.vram', { mb: b.vramMB }));
  if (targetBits.length) {
    explanation.push(t('plan.goal', { title: pick(profile.title, lang), bits: targetBits.join(', ') }));
  }

  return {
    profileId: profile.id,
    title: pick(profile.title, lang),
    engineOpts: { ...opts },
    explanation,
    // аддитивное поле (в рамках правил стабильности §4c): web-interface может взять
    // список расширений прямо из плана, не делая второй вызов
    availableExtensions: extensionsOf(profile, lang),
  };
}

// ----------------------------------------------------------------------------
// getAvailableExtensions(platformId) — расширенные опции платформы (opt-in)
// ----------------------------------------------------------------------------

function extensionsOf(profile, lang = DEFAULT_LANG) {
  const list = Array.isArray(profile.availableExtensions) ? profile.availableExtensions : [];
  // копии: мутации у потребителя не должны влиять на закешированные профили
  return list.map((e) => ({
    ...e,
    title: pick(e.title, lang),
    description: pick(e.description, lang),
    impact: pick(e.impact, lang),
    opts: { ...(e.opts || {}) },
  }));
}

export function getAvailableExtensions(platformId, lang = DEFAULT_LANG) {
  return extensionsOf(loadProfile(platformId), lang);
}

// Алиас под имя, которое web-interface (server.mjs) уже ищет у ассистента.
export const listExtensions = getAvailableExtensions;

// ----------------------------------------------------------------------------
// explainResult(runResult, platformId)
// ----------------------------------------------------------------------------

export function explainResult(runResult, platformId, lang = DEFAULT_LANG) {
  const t = messages(lang);
  const { fmtMB, fmtInt } = formatters(lang);
  loadProfile(platformId); // валидирует platformId (throws на неизвестном) — контракт §4c; budgets больше не нужны здесь

  const rr = runResult || {};
  const before = rr.metrics && rr.metrics.before;
  const after = rr.metrics && rr.metrics.after;

  // --- нештатные статусы ---
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

  // --- summary: файл + видеопамять ---
  const fileGrew = after.fileBytes > before.fileBytes;
  const vramDropped = after.gpuBytes < before.gpuBytes;

  let summary = t('summary.done', {
    fileBefore: fmtMB(before.fileBytes),
    fileAfter: fmtMB(after.fileBytes),
    filePct: pctText(before.fileBytes, after.fileBytes),
    vramBefore: fmtMB(before.gpuBytes),
    vramAfter: fmtMB(after.gpuBytes),
    vramPct: pctText(before.gpuBytes, after.gpuBytes),
  });
  if (rr.status === 'fail') {
    summary = t('summary.failPrefix') + summary;
  } else if (fileGrew && vramDropped) {
    // рост файла при падении VRAM — не ошибка, объясняем нейтрально
    summary += t('summary.fileGrewVramDropped');
  }

  // --- highlights: главные улучшения человеческим языком ---
  const highlights = [];

  if (after.fileBytes < before.fileBytes) {
    highlights.push(t('hi.fileLighter', { pct: Math.abs(deltaPct(before.fileBytes, after.fileBytes)) }));
  } else if (fileGrew && vramDropped) {
    const tl = timesLess(before.gpuBytes, after.gpuBytes);
    highlights.push(tl ? t('hi.vramTimesLess', { times: tl }) : t('hi.vramDropped'));
  }

  if (vramDropped && !(fileGrew)) {
    highlights.push(t('hi.vramPct', { pct: Math.abs(deltaPct(before.gpuBytes, after.gpuBytes)) }));
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

  // Budget check убран из выдачи (решение Александра): без точных целей пользователя
  // сверять «после» с абстрактными бюджетами платформы бессмысленно. Данные бюджетов
  // остаются в профилях как задел под будущий отдельный аддон, управляемый пользовательским
  // пресетом (тогда цифры цели заданы явно). buildBudgetChecks сохранён, но не вызывается.
  return {
    summary,
    highlights: highlights.slice(0, 6),
    budgetChecks: [],
    warnings: collectWarnings(rr, t),
  };
}

// ----------------------------------------------------------------------------
// budgetChecks — сверяем измеримые метрики after с бюджетами
// (textureMaxSize не проверяем: ядро не отдаёт размерность текстур в metrics)
// ----------------------------------------------------------------------------

function buildBudgetChecks(budgets, after) {
  const checks = [];

  // Треугольники
  if (budgets.triangles != null) {
    const actual = after.triangles;
    const ok = actual <= budgets.triangles;
    const c = {
      name: 'Triangles',
      limitText: `up to ${fmtInt(budgets.triangles)}`,
      actualText: fmtInt(actual),
      ok,
    };
    if (!ok) {
      const over = actual - budgets.triangles;
      c.advice = `${fmtInt(actual)} triangles against a budget of ${fmtInt(budgets.triangles)} — ${fmtInt(over)} over. Simplify the model (decimation) on export or lower the source detail.`;
    }
    checks.push(c);
  }

  // Draw calls
  if (budgets.drawCalls != null) {
    const actual = after.drawCalls;
    const ok = actual <= budgets.drawCalls;
    const c = {
      name: 'Draw calls',
      limitText: `up to ${fmtInt(budgets.drawCalls)}`,
      actualText: fmtInt(actual),
      ok,
    };
    if (!ok) {
      const over = actual - budgets.drawCalls;
      c.advice = `${fmtInt(actual)} draw calls against a budget of ${fmtInt(budgets.drawCalls)} — ${fmtInt(over)} over. Join parts and reduce the number of materials on export.`;
    }
    checks.push(c);
  }

  // Видеопамять под текстуры (gpuBytes vs vramMB)
  if (budgets.vramMB != null) {
    const limitBytes = budgets.vramMB * 1024 * 1024;
    const actual = after.gpuBytes;
    const ok = actual <= limitBytes;
    const c = {
      name: 'Texture video memory',
      limitText: `up to ${budgets.vramMB} MB`,
      actualText: fmtMB(actual),
      ok,
    };
    if (!ok) {
      c.advice = `Textures take ${fmtMB(actual)} of video memory against a recommended ${budgets.vramMB} MB — ${Math.round((MB(actual) - budgets.vramMB))} MB over. Lower the texture resolution on export or use fewer texture maps.`;
    }
    checks.push(c);
  }

  // Размер файла (fileBytes vs fileMB)
  if (budgets.fileMB != null) {
    const limitBytes = budgets.fileMB * 1024 * 1024;
    const actual = after.fileBytes;
    const ok = actual <= limitBytes;
    const c = {
      name: 'File size',
      limitText: `up to ${budgets.fileMB} MB`,
      actualText: fmtMB(actual),
      ok,
    };
    if (!ok) {
      c.advice = `The ${fmtMB(actual)} file exceeds the recommended ${budgets.fileMB} MB by ${(MB(actual) - budgets.fileMB).toFixed(1)} MB. Lower the texture resolution or simplify the geometry on export.`;
    }
    checks.push(c);
  }

  return checks;
}

// ----------------------------------------------------------------------------
// warnings — из skipped и validation (info|fail)
// ----------------------------------------------------------------------------

function collectWarnings(rr, t = messages(DEFAULT_LANG)) {
  const warnings = [];

  if (Array.isArray(rr.skipped)) {
    for (const s of rr.skipped) {
      if (!s || !s.text) continue;
      // Предупреждение — это когда мы ХОТЕЛИ сделать, но не стали. «Фича не включена»
      // и «делать было нечего» предупреждениями не являются: первое — выбор
      // пользователя, второе — нормальный исход. Раньше они шли сюда наравне с
      // настоящими отказами, и панель заполнялась строками вида «Not applied: no
      // animations to resample» — перечислением того, чего в модели нет. Настоящий
      // отказ («небезопасно на этой модели») тонул среди них.
      if (s.kind === 'disabled' || s.kind === 'nothing') continue;
      // Причина часто уже вписана в текст («Правило — потому что…»), и приклеивать
      // её вторым хвостом значило печатать одно и то же дважды в одной строке.
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
