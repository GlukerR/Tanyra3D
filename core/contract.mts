import type { FixSafety } from './types.mjs';

export const TIER_RANK = { provable: 0, numeric: 1, perceptual: 2, lossy: 3 } as const;
export const AUTOFIX_MAX_TIER: FixSafety = 'perceptual';

export const isKnownTier = (tier: unknown): tier is FixSafety =>
  Object.prototype.hasOwnProperty.call(TIER_RANK, tier as PropertyKey);

export interface EngineMeta {
  id: string;
  category: string;
  severity: 'info' | 'warn' | 'error';
  fixSafety: string;
  reversible: boolean;
  dataLoss: 'none' | 'minor' | 'significant';
}

export const ENGINE_META: Record<string, EngineMeta> = {
  inputCompression: { id: 'engine/input-compression', category: 'geometry', severity: 'info', fixSafety: 'provable', reversible: true, dataLoss: 'none' },
  inputValidation: { id: 'engine/input-validation', category: 'scene', severity: 'warn', fixSafety: 'none', reversible: true, dataLoss: 'none' },
};

export interface BaselineCheck {
  level: 'pass' | 'info' | 'fail';
  messageId: string;
  data: Record<string, unknown>;
}

export type BaselineSnapshot = Record<string, unknown>;

export interface CompareBaselineOptions {
  advancedPlannedIds?: string[];
  log?: (msg: string) => void;
  soft?: Set<string>;
}

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
