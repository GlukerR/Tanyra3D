// assistant.mjs — слой ассистента (ai-assistant) поверх ядра optimize2.mjs.
//
// Роль: превратить выбор платформы в план обработки (engineOpts для ядра) и
// перевести результат работы ядра (RunResult из ARCHITECTURE.md §4b) на человеческий
// язык — для правой панели «Анализ» веб-интерфейса.
//
// ВАЖНО: этот модуль НЕ импортирует optimize2.mjs. Ядро вызывает web-interface, не мы.
// Профили платформ — это ДАННЫЕ (profiles/*.json). Новая платформа = новый json-файл
// без правки этого кода.
//
// Экспорты — зафиксированный контракт с web-interface (ARCHITECTURE.md §4c):
//   listPlatforms()                     → [{ id, title, description }]
//   planFor(platformId)                 → { profileId, title, engineOpts, explanation: [string] }
//   explainResult(runResult, platformId)→ { summary, highlights, budgetChecks, warnings }

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
  if (!platformId) throw new Error('Не указана платформа.');
  const file = profilePath(platformId);
  if (!fs.existsSync(file)) {
    const known = listPlatforms().map((p) => p.id).join(', ');
    throw new Error(`Неизвестная платформа «${platformId}». Доступные: ${known || '—'}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Профиль «${platformId}» повреждён: ${e.message}`);
  }
}

// ----------------------------------------------------------------------------
// Форматирование чисел для человеческих текстов (байты → МБ здесь, не в ядре)
// ----------------------------------------------------------------------------

const MB = (bytes) => bytes / (1024 * 1024);
// Человеческий размер: до 1 МБ показываем в КБ, иначе в МБ — крошечные модели
// не должны выглядеть как «0.0 МБ».
const fmtMB = (bytes) => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${MB(bytes).toFixed(1)} МБ`;
};
const fmtInt = (n) => Number(n).toLocaleString('ru-RU');

function deltaPct(before, after) {
  if (!before) return 0;
  return Math.round(((after - before) / before) * 100);
}

// «−18%» / «+220%» / «без изменений»
function pctText(before, after) {
  const p = deltaPct(before, after);
  if (p === 0) return 'без изменений';
  return p < 0 ? `−${Math.abs(p)}%` : `+${p}%`;
}

// «в 4 раза» — для нейтрального объяснения падения VRAM
function timesLess(before, after) {
  if (!after) return null;
  const ratio = before / after;
  if (ratio < 1.15) return null;
  return `в ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1).replace('.', ',')} раза`;
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
      if (p && p.id) out.push({ id: p.id, title: p.title || p.id, description: p.description || '' });
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
  const opts = profile.engineOpts || {};
  const b = profile.budgets || {};

  const explanation = [];

  // геометрия
  if (opts.codec === 'draco') {
    explanation.push('Геометрию сожмём проверенным способом (Draco) — файл заметно легче, модель распакуется в браузере.');
  } else {
    explanation.push('Геометрию сожмём современным способом (meshopt) — файл меньше, а модель быстро распаковывается прямо на видеокарте.');
  }

  // текстуры
  if (opts.noKtx) {
    explanation.push('Текстуры оставим в исходном виде — без перевода в GPU-формат.');
  } else if (opts.texMode === 'uastc') {
    explanation.push('Текстуры переведём в качественный GPU-формат — картинка остаётся чёткой, а видеопамяти нужно меньше.');
  } else {
    explanation.push('Цветные текстуры сожмём в лёгкий формат ради быстрой загрузки, а карты с мелкими деталями — в более точный. Так экономим и трафик, и видеопамять.');
  }

  // сборка деталей
  if (!opts.keepParts) {
    explanation.push('Мелкие детали объединим в одну модель — видеокарте нужно меньше отдельных вызовов на отрисовку.');
  } else {
    explanation.push('Отдельные детали модели сохраним как есть — не объединяем.');
  }

  // цвета вершин
  if (opts.stripColors) {
    explanation.push('Уберём неиспользуемые цвета вершин — они только утяжеляют файл.');
  }

  // цель по бюджету платформы
  const targetBits = [];
  if (b.triangles) targetBits.push(`до ${fmtInt(b.triangles)} треугольников`);
  if (b.textureMaxSize) targetBits.push(`текстуры до ${b.textureMaxSize}px`);
  if (b.vramMB) targetBits.push(`до ${b.vramMB} МБ видеопамяти`);
  if (targetBits.length) {
    explanation.push(`Цель — уложиться в бюджет платформы «${profile.title}»: ${targetBits.join(', ')}.`);
  }

  return {
    profileId: profile.id,
    title: profile.title,
    engineOpts: { ...opts },
    explanation,
  };
}

// ----------------------------------------------------------------------------
// explainResult(runResult, platformId)
// ----------------------------------------------------------------------------

export function explainResult(runResult, platformId) {
  const profile = loadProfile(platformId);
  const budgets = profile.budgets || {};

  const rr = runResult || {};
  const before = rr.metrics && rr.metrics.before;
  const after = rr.metrics && rr.metrics.after;

  // --- нештатные статусы ---
  if (rr.error) {
    return {
      summary: `Не удалось обработать модель: ${rr.error}`,
      highlights: [],
      budgetChecks: [],
      warnings: [],
    };
  }
  if (rr.status === 'skip') {
    return {
      summary: 'Модель пропущена: результат для неё уже существует. Чтобы пересобрать заново, включите перезапись.',
      highlights: [],
      budgetChecks: [],
      warnings: [],
    };
  }
  if (!before || !after) {
    return {
      summary: 'Обработка не дошла до подсчёта результата — данные о модели недоступны.',
      highlights: [],
      budgetChecks: [],
      warnings: collectWarnings(rr),
    };
  }

  // --- summary: файл + видеопамять ---
  const fileGrew = after.fileBytes > before.fileBytes;
  const vramDropped = after.gpuBytes < before.gpuBytes;

  let summary = `Готово. Файл: ${fmtMB(before.fileBytes)} → ${fmtMB(after.fileBytes)} (${pctText(before.fileBytes, after.fileBytes)}); `
    + `видеопамять под текстуры: ${fmtMB(before.gpuBytes)} → ${fmtMB(after.gpuBytes)} (${pctText(before.gpuBytes, after.gpuBytes)}).`;
  if (rr.status === 'fail') {
    summary = 'Проверка результата не пройдена — оптимизированный файл не записан. ' + summary;
  } else if (fileGrew && vramDropped) {
    // рост файла при падении VRAM — не ошибка, объясняем нейтрально
    summary += ' Файл чуть потяжелел, зато видеопамять уменьшилась: GPU-формат текстур весит в файле больше, но на видеокарте занимает в разы меньше.';
  }

  // --- highlights: главные улучшения человеческим языком ---
  const highlights = [];

  if (after.fileBytes < before.fileBytes) {
    highlights.push(`Файл легче на ${Math.abs(deltaPct(before.fileBytes, after.fileBytes))}% — быстрее загрузка.`);
  } else if (fileGrew && vramDropped) {
    const tl = timesLess(before.gpuBytes, after.gpuBytes);
    highlights.push(tl
      ? `Видеопамять под текстуры меньше ${tl} — модель не «съест» память на слабых устройствах.`
      : 'Видеопамять под текстуры уменьшилась — модель бережнее к слабым устройствам.');
  }

  if (vramDropped && !(fileGrew)) {
    highlights.push(`Видеопамять под текстуры меньше на ${Math.abs(deltaPct(before.gpuBytes, after.gpuBytes))}% — плавнее на слабых видеокартах.`);
  }

  if (after.drawCalls < before.drawCalls) {
    highlights.push(`Отрисовка проще: вызовов ${fmtInt(before.drawCalls)} → ${fmtInt(after.drawCalls)} — меньше нагрузка на видеокарту.`);
  }

  if (before.triangles > 0 && after.triangles === before.triangles) {
    highlights.push(`Форма модели сохранена полностью (${fmtInt(after.triangles)} треугольников) — геометрия не пострадала.`);
  } else if (before.triangles > 0 && after.triangles < before.triangles) {
    highlights.push(`Убраны лишние треугольники: ${fmtInt(before.triangles)} → ${fmtInt(after.triangles)}.`);
  }

  if (Array.isArray(rr.applied) && rr.applied.length) {
    highlights.push(`Применено безопасных улучшений: ${rr.applied.length} — каждое проверено, форма и материалы не искажены.`);
  }

  // --- budgetChecks: metrics.after против бюджетов платформы ---
  const budgetChecks = buildBudgetChecks(budgets, after);

  return {
    summary,
    highlights: highlights.slice(0, 6),
    budgetChecks,
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
      name: 'Треугольники',
      limitText: `до ${fmtInt(budgets.triangles)}`,
      actualText: fmtInt(actual),
      ok,
    };
    if (!ok) {
      const over = actual - budgets.triangles;
      c.advice = `Треугольников ${fmtInt(actual)} при бюджете ${fmtInt(budgets.triangles)} — на ${fmtInt(over)} больше. Упростите модель (decimation) при экспорте или уменьшите детализацию исходника.`;
    }
    checks.push(c);
  }

  // Draw calls
  if (budgets.drawCalls != null) {
    const actual = after.drawCalls;
    const ok = actual <= budgets.drawCalls;
    const c = {
      name: 'Вызовы отрисовки (draw calls)',
      limitText: `до ${fmtInt(budgets.drawCalls)}`,
      actualText: fmtInt(actual),
      ok,
    };
    if (!ok) {
      const over = actual - budgets.drawCalls;
      c.advice = `Вызовов отрисовки ${fmtInt(actual)} при бюджете ${fmtInt(budgets.drawCalls)} — на ${fmtInt(over)} больше. Объедините детали и сократите число материалов при экспорте.`;
    }
    checks.push(c);
  }

  // Видеопамять под текстуры (gpuBytes vs vramMB)
  if (budgets.vramMB != null) {
    const limitBytes = budgets.vramMB * 1024 * 1024;
    const actual = after.gpuBytes;
    const ok = actual <= limitBytes;
    const c = {
      name: 'Видеопамять под текстуры',
      limitText: `до ${budgets.vramMB} МБ`,
      actualText: fmtMB(actual),
      ok,
    };
    if (!ok) {
      c.advice = `Текстуры занимают ${fmtMB(actual)} видеопамяти при рекомендации ${budgets.vramMB} МБ — превышение на ${Math.round((MB(actual) - budgets.vramMB))} МБ. Уменьшите разрешение текстур при экспорте или используйте меньше текстурных карт.`;
    }
    checks.push(c);
  }

  // Размер файла (fileBytes vs fileMB)
  if (budgets.fileMB != null) {
    const limitBytes = budgets.fileMB * 1024 * 1024;
    const actual = after.fileBytes;
    const ok = actual <= limitBytes;
    const c = {
      name: 'Размер файла',
      limitText: `до ${budgets.fileMB} МБ`,
      actualText: fmtMB(actual),
      ok,
    };
    if (!ok) {
      c.advice = `Файл ${fmtMB(actual)} превышает рекомендованные ${budgets.fileMB} МБ на ${(MB(actual) - budgets.fileMB).toFixed(1)} МБ. Уменьшите разрешение текстур или упростите геометрию при экспорте.`;
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
      warnings.push(`Не применили: ${s.text}${reason}`);
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
