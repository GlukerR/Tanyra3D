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

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(BASE_DIR, 'profiles');

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
// Человеческий размер: до 1 МБ показываем в КБ, иначе в МБ — крошечные модели
// не должны выглядеть как «0.0 МБ».
const fmtMB = (bytes) => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${MB(bytes).toFixed(1)} MB`;
};
const fmtInt = (n) => Number(n).toLocaleString('en-US');

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

export function listPlatforms() {
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
      if (p && p.id && p.enabled !== false) out.push({ id: p.id, title: p.title || p.id, description: p.description || '' });
    } catch {
      /* повреждённый профиль просто не показываем в списке */
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// planFor(platformId) — план обработки + объяснение выбора настроек
// ----------------------------------------------------------------------------

export function planFor(platformId) {
  const profile = loadProfile(platformId);
  // v0.0.8: базовый план строится из baselineOpts (KTX2/Draco выключены);
  // engineOpts — legacy-поле старых профилей, оставлено как фолбэк
  const opts = profile.baselineOpts || profile.engineOpts || {};
  const b = profile.budgets || {};

  const explanation = [];

  // геометрия
  if (opts.codec === 'draco') {
    explanation.push('Geometry will be compressed with a proven method (Draco) — the file gets noticeably lighter and the model unpacks in the browser.');
  } else {
    explanation.push('Geometry will be compressed with a modern method (meshopt) — a smaller file that unpacks quickly right on the GPU.');
  }

  // чистка структуры — базовая часть плана, происходит всегда
  explanation.push('We remove junk without changing the picture: duplicate materials and textures, unused data, invisible triangles and orphan vertices.');

  // текстуры
  if (opts.noKtx) {
    explanation.push('Textures stay in a universal form (PNG/WebP) — they open in any browser without extra loaders. GPU KTX2 compression is available as an advanced option.');
  } else if (opts.texMode === 'uastc') {
    explanation.push('Textures are converted to a high-quality GPU format — the picture stays sharp while needing less video memory.');
  } else {
    explanation.push('Color textures are compressed into a light format for fast loading, and detail maps into a more precise one. This saves both traffic and video memory.');
  }

  // сборка деталей
  if (!opts.keepParts) {
    explanation.push('Small parts are joined into a single model — the GPU needs fewer separate draw calls.');
  } else {
    explanation.push('Individual model parts are kept as they are — not joined.');
  }

  // цвета вершин
  if (opts.stripColors) {
    explanation.push('Unused vertex colors are removed — they only make the file heavier.');
  }

  // цель по бюджету платформы
  const targetBits = [];
  if (b.triangles) targetBits.push(`up to ${fmtInt(b.triangles)} triangles`);
  if (b.textureMaxSize) targetBits.push(`textures up to ${b.textureMaxSize}px`);
  if (b.vramMB) targetBits.push(`up to ${b.vramMB} MB video memory`);
  if (targetBits.length) {
    explanation.push(`Goal — fit the "${profile.title}" platform budget: ${targetBits.join(', ')}.`);
  }

  return {
    profileId: profile.id,
    title: profile.title,
    engineOpts: { ...opts },
    explanation,
    // аддитивное поле (в рамках правил стабильности §4c): web-interface может взять
    // список расширений прямо из плана, не делая второй вызов
    availableExtensions: extensionsOf(profile),
  };
}

// ----------------------------------------------------------------------------
// getAvailableExtensions(platformId) — расширенные опции платформы (opt-in)
// ----------------------------------------------------------------------------

function extensionsOf(profile) {
  const list = Array.isArray(profile.availableExtensions) ? profile.availableExtensions : [];
  // копии: мутации у потребителя не должны влиять на закешированные профили
  return list.map((e) => ({ ...e, opts: { ...(e.opts || {}) } }));
}

export function getAvailableExtensions(platformId) {
  return extensionsOf(loadProfile(platformId));
}

// Алиас под имя, которое web-interface (server.mjs) уже ищет у ассистента.
export const listExtensions = getAvailableExtensions;

// ----------------------------------------------------------------------------
// explainResult(runResult, platformId)
// ----------------------------------------------------------------------------

export function explainResult(runResult, platformId) {
  loadProfile(platformId); // валидирует platformId (throws на неизвестном) — контракт §4c; budgets больше не нужны здесь

  const rr = runResult || {};
  const before = rr.metrics && rr.metrics.before;
  const after = rr.metrics && rr.metrics.after;

  // --- нештатные статусы ---
  if (rr.error) {
    return {
      summary: `Could not process the model: ${rr.error}`,
      highlights: [],
      budgetChecks: [],
      warnings: [],
    };
  }
  if (rr.status === 'skip') {
    return {
      summary: 'Model skipped: a result for it already exists. To rebuild it, enable overwrite.',
      highlights: [],
      budgetChecks: [],
      warnings: [],
    };
  }
  if (!before || !after) {
    return {
      summary: 'Processing did not reach the result stage — model data is unavailable.',
      highlights: [],
      budgetChecks: [],
      warnings: collectWarnings(rr),
    };
  }

  // --- summary: файл + видеопамять ---
  const fileGrew = after.fileBytes > before.fileBytes;
  const vramDropped = after.gpuBytes < before.gpuBytes;

  let summary = `Done. File: ${fmtMB(before.fileBytes)} → ${fmtMB(after.fileBytes)} (${pctText(before.fileBytes, after.fileBytes)}); `
    + `texture video memory: ${fmtMB(before.gpuBytes)} → ${fmtMB(after.gpuBytes)} (${pctText(before.gpuBytes, after.gpuBytes)}).`;
  if (rr.status === 'fail') {
    summary = 'Result check did not pass — the optimized file was not written. ' + summary;
  } else if (fileGrew && vramDropped) {
    // рост файла при падении VRAM — не ошибка, объясняем нейтрально
    summary += ' The file got slightly heavier but video memory dropped: the GPU texture format weighs more in the file yet takes far less on the GPU.';
  }

  // --- highlights: главные улучшения человеческим языком ---
  const highlights = [];

  if (after.fileBytes < before.fileBytes) {
    highlights.push(`File is ${Math.abs(deltaPct(before.fileBytes, after.fileBytes))}% lighter — faster to load.`);
  } else if (fileGrew && vramDropped) {
    const tl = timesLess(before.gpuBytes, after.gpuBytes);
    highlights.push(tl
      ? `Texture video memory is ${tl} smaller — the model won't eat memory on weak devices.`
      : 'Texture video memory dropped — the model is gentler on weak devices.');
  }

  if (vramDropped && !(fileGrew)) {
    highlights.push(`Texture video memory is ${Math.abs(deltaPct(before.gpuBytes, after.gpuBytes))}% lower — smoother on weak GPUs.`);
  }

  if (after.drawCalls < before.drawCalls) {
    highlights.push(`Rendering is simpler: draw calls ${fmtInt(before.drawCalls)} → ${fmtInt(after.drawCalls)} — less GPU load.`);
  }

  if (before.triangles > 0 && after.triangles === before.triangles) {
    highlights.push(`Model shape fully preserved (${fmtInt(after.triangles)} triangles) — geometry untouched.`);
  } else if (before.triangles > 0 && after.triangles < before.triangles) {
    highlights.push(`Extra triangles removed: ${fmtInt(before.triangles)} → ${fmtInt(after.triangles)}.`);
  }

  if (Array.isArray(rr.applied) && rr.applied.length) {
    highlights.push(`Safe improvements applied: ${rr.applied.length} — each verified, shape and materials not distorted.`);
  }

  // Budget check убран из выдачи (решение Александра): без точных целей пользователя
  // сверять «после» с абстрактными бюджетами платформы бессмысленно. Данные бюджетов
  // остаются в профилях как задел под будущий отдельный аддон, управляемый пользовательским
  // пресетом (тогда цифры цели заданы явно). buildBudgetChecks сохранён, но не вызывается.
  return {
    summary,
    highlights: highlights.slice(0, 6),
    budgetChecks: [],
    warnings: collectWarnings(rr),
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

function collectWarnings(rr) {
  const warnings = [];

  if (Array.isArray(rr.skipped)) {
    for (const s of rr.skipped) {
      if (!s || !s.text) continue;
      const reason = s.reason && s.reason !== s.text ? ` — ${s.reason}` : '';
      warnings.push(`Not applied: ${s.text}${reason}`);
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
