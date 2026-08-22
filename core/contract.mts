// core/contract.mts — то, о чём движок и аддон договариваются между собой.
//
// Вынесено из engine.mjs по ARCH-001: аддон импортировал константы и функцию прямо
// из движка (`addons/gltf/index.mjs` → `core/engine.mjs`), а движок вызывает методы
// аддона — получалась двусторонняя связь. Ни один из двух не «главнее», просто
// обоим нужен общий словарь: политика автофикса, идентификаторы находок уровня
// движка и правила сверки baseline-checkpoint. Теперь оба зависят от этого модуля,
// а он — ни от кого. Формат-специфичного здесь нет и быть не должно.
//
// Второй модуль на TypeScript (после core/types). Выбран следующим по той же причине,
// по которой был вынесен из движка: он ни от кого не зависит, у него два потребителя,
// и это ровно «контракт между модулями» — то, что просили типизировать в первую
// очередь. Исполняемый код здесь есть, но типы из него стираются без остатка:
// собранный core/contract.mjs совпадает с прежним по смыслу строка в строку.

import type { FixSafety } from './types.mjs';

// Политика автофикса (ARCHITECTURE.md §2.4): применяем provable + numeric + perceptual
// (perceptual = KTX2/UASTC — пользователь выбрал сам и доволен). lossy — никогда
// автоматом; только явный force из canFix (например флаг --strip-vertex-colors).
export const TIER_RANK = { provable: 0, numeric: 1, perceptual: 2, lossy: 3 } as const;
export const AUTOFIX_MAX_TIER: FixSafety = 'perceptual';

// Уровень известен движку? Спрашивать ЭТИМ, а не `TIER_RANK[tier] > ...` напрямую.
//
// Прямое сравнение работает по модели fail-open: у опечатки `perceptal` ранга нет,
// `undefined > 2` — ложь, и правило проходит ворота как безопасное. Для движка, который
// продаёт именно предсказуемость преобразований, это ровно наоборот тому, что нужно:
// чего движок не понимает, то он не применяет. Найдено ревью 2026-08-10 (P0.3).
//
// Тип-предикат, а не просто boolean: после этой проверки TypeScript знает, что перед ним
// один из четырёх уровней, — то же знание, ради которого проверка и заводилась.
// Приведение внутри нужно, чтобы принимать что угодно (в том числе undefined) и вести
// себя при этом ровно как прежняя версия на JS.
export const isKnownTier = (tier: unknown): tier is FixSafety =>
  Object.prototype.hasOwnProperty.call(TIER_RANK, tier as PropertyKey);

/** Запись отчёта, которую движок ставит от своего имени, а не от имени правила. */
export interface EngineMeta {
  id: string;
  category: string;
  severity: 'info' | 'warn' | 'error';
  /**
   * Здесь это ПОДПИСЬ для отчёта, а не уровень для ворот автофикса: у inputValidation
   * стоит 'none', которого среди уровней нет и быть не должно — движок ничего не чинит,
   * он только сообщает о находке. Ворота смотрят на meta правила (см. isKnownTier),
   * сюда они не заглядывают, поэтому тип здесь шире FixSafety намеренно.
   */
  fixSafety: string;
  reversible: boolean;
  dataLoss: 'none' | 'minor' | 'significant';
}

// Находки/применения уровня движка (вне правил аддона) — стабильные ruleId «engine/*».
// Аддон может ссылаться на них (напр. gltf/validate — на inputValidation).
export const ENGINE_META: Record<string, EngineMeta> = {
  inputCompression: { id: 'engine/input-compression', category: 'geometry', severity: 'info', fixSafety: 'provable', reversible: true, dataLoss: 'none' },
  inputValidation: { id: 'engine/input-validation', category: 'scene', severity: 'warn', fixSafety: 'none', reversible: true, dataLoss: 'none' },
};

/** Строка сверки baseline-checkpoint: уровень плюс рецепт сообщения (язык отдельно от кода). */
export interface BaselineCheck {
  level: 'pass' | 'info' | 'fail';
  messageId: string;
  data: Record<string, unknown>;
}

/** Снимок структуры: ключ метрики → значение. Что именно за ключи, решает аддон. */
export type BaselineSnapshot = Record<string, unknown>;

export interface CompareBaselineOptions {
  advancedPlannedIds?: string[];
  log?: (msg: string) => void;
  soft?: Set<string>;
}

// Человеческое имя метрики. Без него в русскую фразу утекал английский идентификатор —
// «vertices изменился при кодировании» человек и читал (Александр, 2026-08-22). Имя —
// вложенное сообщение, а не склейка: render() развернёт его на языке отчёта.
//
// Ключ, которого в списке нет, подставляется КАК ЕСТЬ. Строгость каталога (нет ключа —
// падаем) хороша на ошибке разработчика, но набор метрик задаёт аддон, а не движок:
// уронить чужую сборку из-за неназванной метрики — цена не по проступку.
// Ключи выписаны ЛИТЕРАЛАМИ, а не собраны шаблоном `metric.${k}`. Так их видит
// статический сканер сторожа ключей-сирот (tests/engine-contract.test.mjs): собранный
// на лету ключ он прочесть не может, и восемь честных имён повисли бы мусором.
const METRIC_NAMES: Record<string, { messageId: string; data: Record<string, unknown> }> = {
  triangles: { messageId: 'metric.triangles', data: {} },
  vertices: { messageId: 'metric.vertices', data: {} },
  drawCalls: { messageId: 'metric.drawCalls', data: {} },
  skins: { messageId: 'metric.skins', data: {} },
  nodes: { messageId: 'metric.nodes', data: {} },
  animations: { messageId: 'metric.animations', data: {} },
  morphTargets: { messageId: 'metric.morphTargets', data: {} },
  attributes: { messageId: 'metric.attributes', data: {} },
};
const metricName = (k: string): { messageId: string; data: Record<string, unknown> } | string =>
  METRIC_NAMES[k] ?? k;

// BASELINE-CHECKPOINT: сверка снимка структуры (после базового прохода) с метриками
// реальных байтов будущего файла. Жёсткие ключи (треугольники/скины/узлы/анимации/
// draw-calls) не должны меняться — их расхождение блокирует запись (нарушение гарантии
// компонента). Мягкие ключи (soft, напр. vertices) — только информируют: кодек может
// переиндексировать/сваривать вершины при сериализации (Draco зовёт weld перед сжатием),
// это меняет ЧИСЛО вершин, но не треугольники и топологию — для неанимированной модели
// это легитимная полная оптимизация, для анимированной защищают строгие ключи skins/
// animations. Возвращает строки валидации в порядке отчёта; логирует посписочную сверку.
export function compareBaseline(
  baseline: BaselineSnapshot,
  after: BaselineSnapshot,
  keys: string[],
  { advancedPlannedIds = [], log = () => {}, soft = new Set<string>() }: CompareBaselineOptions = {},
): BaselineCheck[] {
  for (const k of keys) {
    log(`      [baseline-validate] ${k}: ${baseline[k]} → ${after[k]}${after[k] === baseline[k] ? '' : '  ← MISMATCH'}`);
  }
  const broken = keys.filter((k) => after[k] !== baseline[k]);
  if (broken.length === 0) {
    return [{ level: 'pass', messageId: 'check.baselineMatch', data: {} }];
  }
  return broken.map((k) => {
    if (soft.has(k)) {
      return {
        level: 'info' as const,
        messageId: 'check.baselineSoftMismatch',
        data: { k: metricName(k), baseline: baseline[k], after: after[k] },
      };
    }
    // Разбор — В ЖУРНАЛ, а не в отчёт. Человеку нужны две вещи: что изменилось и что с
    // этим делать; «согласно официальной документации компонентов документации компонентов»
    // и «ошибка библиотеки или некорректное использование компонента» — это записка нам
    // самим, и в правой панели она только пугает (Александр, 2026-08-22: «слишком страшно
    // выглядит и звучит непонятно»). Журнал для такого и заведён.
    log(
      `      [baseline-validate] HARD MISMATCH ${k}: ${baseline[k]} → ${after[k]}; likely cause: `
      + (advancedPlannedIds.length ? `second-pass extensions (${advancedPlannedIds.join(', ')}) or file writing` : 'file writing (no second-pass fixes applied)')
      + '; per docs/ЗАВИСИМОСТИ.md the codecs must not change mesh topology — suspect a library bug or incorrect component use',
    );
    return {
      level: 'fail' as const,
      messageId: 'check.baselineHardMismatch',
      data: { k: metricName(k), baseline: baseline[k], after: after[k] },
    };
  });
}
