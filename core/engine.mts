import fs from 'node:fs';
import path from 'node:path';

import { loadCatalogs, render } from './i18n.mjs';

await loadCatalogs(new URL('./messages/', import.meta.url));

import { TIER_RANK, AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline, isKnownTier } from './contract.mjs';

export { AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline };

import type {
  Addon,
  AppliedEntry,
  Context,
  FindingEntry,
  FoundMeta,
  FixResult,
  I18nRefs,
  Message,
  MessageRef,
  NormalizedOpts,
  ReportLines,
  Rule,
  RunResult,
  SkipKind,
  SkippedEntry,
} from './types.mjs';


interface SkipMeta {
  id: string;
  title?: string;
  titleKey?: string;
  feature?: string | undefined;
}

interface AppliedMeta {
  id: string;
  fixSafety: string;
  reversible?: boolean;
  dataLoss?: string;
}

interface AppliedOverrides {
  fixSafety?: string | undefined;
  reversible?: boolean;
  dataLoss?: string;
}

const asLines = (v: ReportLines | undefined | null): Message[] => (
  v == null ? [] : Array.isArray(v) ? v : [v]
);

interface Entry { text: string; ref: MessageRef | null }

const entriesOf = (v: ReportLines | undefined | null, locale: string | undefined): Entry[] =>
  asLines(v).map((x) => (typeof x === 'string'
    ? { text: x, ref: null }
    : { text: render(x.messageId, x.data, locale), ref: { messageId: x.messageId, data: x.data ?? {} } }));

const withRefs = <T extends { i18n?: I18nRefs }>(rec: T, refs: Record<string, MessageRef | null>): T => {
  const i18n: I18nRefs = {};
  for (const [field, ref] of Object.entries(refs)) if (ref) i18n[field] = ref;
  if (Object.keys(i18n).length) rec.i18n = i18n;
  return rec;
};

const titleRef = (meta: SkipMeta): Message => (
  meta.titleKey ? { messageId: meta.titleKey, data: {} } : (meta.title as string)
);

const skipLine = (meta: SkipMeta, reason: Message): MessageRef => ({
  messageId: 'engine.skipped.line',
  data: { title: titleRef(meta), reason },
});

export function orderRules(rules: Rule[]): Rule[] {
  const ids = new Set(rules.map((r) => r.meta.id));
  for (const r of rules) {
    const deps = r.meta.runAfter || [];
    const seen = new Set<string>();
    for (const d of deps) {
      if (!ids.has(d)) throw new Error(`unknown runAfter dependency "${d}" in rule "${r.meta.id}"`);
      if (d === r.meta.id) throw new Error(`rule "${r.meta.id}" depends on itself in runAfter`);
      if (seen.has(d)) throw new Error(`duplicate runAfter dependency "${d}" in rule "${r.meta.id}"`);
      seen.add(d);
    }
  }
  const done = new Set<string>();
  const pending = [...rules];
  const out: Rule[] = [];
  while (pending.length) {
    const i = pending.findIndex((r) => (r.meta.runAfter || []).every((d) => done.has(d)));
    if (i === -1) throw new Error(`cycle in runAfter: ${pending.map((r) => r.meta.id).join(', ')}`);
    const [r] = pending.splice(i, 1);
    done.add(r!.meta.id);
    out.push(r!);
  }
  return out;
}

export async function runOptimize(
  addon: Addon,
  srcPath: string,
  opts: Record<string, unknown> = {},
): Promise<RunResult> {
  const src = path.resolve(String(srcPath));
  const dstName = addon.outputName(src);
  const result: RunResult = {
    status: 'ok',
    file: { src, dst: null, written: false, reportPath: null },
    findings: [],
    skipped: [],
    applied: [],
    validation: [],
    metrics: { before: null, after: null },
  };
  try {
    const o = addon.normalizeOpts(opts);
    result.file.dst = path.join(o.outDir, dstName);
    return await runFile(addon, src, dstName, o, result);
  } catch (e) {
    const err = e as { message?: string; i18n?: MessageRef } | null | undefined;
    result.status = 'fail';
    result.error = err && err.message ? err.message : String(e);
    if (err && err.i18n && err.i18n.messageId) {
      result.i18n = { error: { messageId: err.i18n.messageId, data: err.i18n.data ?? {} } };
    }
    return result;
  }
}

async function runFile(
  addon: Addon,
  src: string,
  dstName: string,
  o: NormalizedOpts,
  result: RunResult,
): Promise<RunResult> {
  const dst = result.file.dst as string;
  if (!o.dryRun && !o.force && fs.existsSync(dst)) {
    result.status = 'skip';
    return result;
  }
  const progress = o.onProgress || (() => {});
  const log = o.log;
  const locale = o.locale;
  const addFound = (meta: FoundMeta, v: ReportLines | undefined | null): void => {
    for (const e of entriesOf(v, locale)) {
      result.findings.push(withRefs<FindingEntry>({ ruleId: meta.id, category: meta.category, severity: meta.severity, fixSafety: meta.fixSafety, text: e.text }, { text: e.ref }));
    }
  };
  const addSkipped = (
    meta: SkipMeta,
    v: ReportLines | undefined | null,
    reason?: Message | null,
    kind: SkipKind = 'nothing',
  ): void => {
    const r = reason == null ? null : entriesOf(reason, locale)[0];
    for (const e of entriesOf(v, locale)) {
      result.skipped.push(withRefs<SkippedEntry>(
        { ruleId: meta.id, feature: meta.feature ?? null, text: e.text, reason: r ? r.text : e.text, kind },
        { text: e.ref, reason: r ? r.ref : e.ref },
      ));
    }
  };
  const addExclusiveConflicts = (): void => {
    for (const conflict of o.exclusiveConflicts || []) {
      const selected: MessageRef = { messageId: conflict.selected.titleKey, data: {} };
      for (const rejected of conflict.rejected || []) {
        const meta: SkipMeta = {
          id: conflict.ruleId,
          feature: rejected.feature,
          titleKey: rejected.titleKey,
        };
        const reason: MessageRef = {
          messageId: 'engine.feature.exclusive',
          data: { selected },
        };
        addSkipped(meta, skipLine(meta, reason), reason, 'exclusive');
      }
    }
  };
  const addApplied = (
    meta: AppliedMeta,
    v: ReportLines | undefined | null,
    over: AppliedOverrides = {},
  ): void => {
    for (const e of entriesOf(v, locale)) {
      result.applied.push(withRefs<AppliedEntry>({
        ruleId: meta.id,
        fixSafety: over.fixSafety ?? meta.fixSafety,
        reversible: over.reversible ?? meta.reversible ?? false,
        dataLoss: over.dataLoss ?? meta.dataLoss ?? 'none',
        text: e.text,
      }, { text: e.ref }));
    }
  };

  fs.mkdirSync(o.outDir, { recursive: true });
  const io = await addon.createIO();

  const ctx: Context = {
    document: await addon.load(io, src),
    io,
    opts: o,
    src,
    outDir: o.outDir,
    dstName,
    cache: new Map(),
    log,
  };
  const before = addon.collectMetrics(ctx.document, addon.sourceBytes
    ? addon.sourceBytes(src)
    : fs.statSync(src).size);

  addExclusiveConflicts();

  const strippedCodecs = addon.stripInputCompression(ctx.document);
  if (strippedCodecs.length) {
    const codecs = strippedCodecs.join(', ');
    addFound(ENGINE_META.inputCompression!, { messageId: 'engine.inputCompression.found', data: { codecs } });
    const reencodeNote: MessageRef = o.compress
      ? { messageId: 'engine.inputCompression.reencode', data: { codec: o.codec } }
      : { messageId: 'engine.inputCompression.noCompress', data: {} };
    addApplied(ENGINE_META.inputCompression!, { messageId: 'engine.inputCompression.applied', data: { codecs, note: reencodeNote } });
  }

  const orderedRules = orderRules(addon.rules);
  const activeCount = orderedRules.filter((r) => r.meta.enabled(o)).length;
  const basicPass: Rule[] = [];
  const advancedPass: Rule[] = [];
  const deferredIds = new Set<string>();
  for (const rule of orderedRules) {
    const dependsOnDeferred = (rule.meta.runAfter || []).some((d) => deferredIds.has(d));
    if (rule.meta.tier === 'advanced' || dependsOnDeferred) {
      advancedPass.push(rule);
      if (rule.meta.enabled(o)) deferredIds.add(rule.meta.id);
    } else {
      basicPass.push(rule);
    }
  }

  interface Planned { rule: Rule; finding: ReturnType<Rule['analyze']>[number] }

  const analyzeAndPlan = (rules: Rule[]): Planned[] => {
    const findings: Planned[] = [];
    for (const rule of rules) {
      for (const f of rule.analyze(ctx)) findings.push({ rule, finding: f });
    }
    const planned: Planned[] = [];
    for (const { rule, finding } of findings) {
      if (!rule.meta.enabled(o)) {
        if (rule.meta.feature) {
          const reason: MessageRef = { messageId: 'feature.notEnabled', data: { feature: rule.meta.feature } };
          addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'disabled');
        }
        continue;
      }
      if (!rule.fix) { addFound(rule.meta, finding); continue; }
      const decision = rule.canFix ? rule.canFix(finding, ctx) : { safe: true };
      if (!decision.safe) {
        const reason: Message = decision.messageId
          ? { messageId: decision.messageId, data: decision.data || {} }
          : (decision.reason || '');
        addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'unsafe');
        continue;
      }
      const tier = finding.fixSafety || rule.meta.fixSafety;
      if (!isKnownTier(tier)) {
        const reason: MessageRef = { messageId: 'engine.policy.unknownSafetyLevel', data: { tier: String(tier) } };
        addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'policy');
        continue;
      }
      if (TIER_RANK[tier] > TIER_RANK[AUTOFIX_MAX_TIER] && !decision.force) {
        const reason: MessageRef = { messageId: 'engine.policy.safetyLevel', data: { tier } };
        addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'policy');
        continue;
      }
      planned.push({ rule, finding });
    }
    return planned;
  };

  const applyPlanned = async (planned: Planned[]): Promise<void> => {
    for (const { rule, finding } of planned) {
      const titleText = rule.meta.titleKey ? render(rule.meta.titleKey, {}, locale) : rule.meta.title;
      progress({ type: 'rule', phase: 3, ruleId: rule.meta.id, title: titleText });
      log(`      • ${titleText}`);
      const res: FixResult = (await rule.fix!(finding, ctx)) || {};
      const saidSomething = [res.found, res.skipped, res.cost, res.details, res.detail, res.irreversible]
        .some((v) => (Array.isArray(v) ? v.length > 0 : v != null));
      if (!saidSomething && (rule.meta.feature || rule.meta.featureGroup)) {
        const reason: MessageRef = { messageId: 'engine.nothingToDo', data: { feature: rule.meta.feature ?? '' } };
        addSkipped(rule.meta, skipLine(rule.meta, reason), reason, 'nothing');
      }
      addFound(rule.meta, res.found);
      addSkipped(rule.meta, res.skipped);
      addSkipped(rule.meta, res.cost, undefined, 'cost');
      addApplied(rule.meta, res.details ?? res.detail);
      addApplied(rule.meta, res.irreversible, {
        reversible: false,
        dataLoss: 'significant',
        fixSafety: res.irreversibleSafety,
      });
    }
  };

  progress({ type: 'phase', phase: 1, name: 'analysis' });
  log(`    phase 1/5 · analysis (rules: ${orderedRules.length}, active: ${activeCount})`);
  progress({ type: 'phase', phase: 2, name: 'plan' });
  log('    phase 2/5 · plan');
  const basicPlanned = analyzeAndPlan(basicPass);
  progress({ type: 'phase', phase: 3, name: 'apply' });
  log(`    phase 3/5 · apply · basic (${basicPlanned.length} fixes)`);
  await applyPlanned(basicPlanned);

  ctx.baselineMetrics = addon.baselineMetrics(ctx.document);
  log(`      baseline-checkpoint: ${addon.BASELINE_METRICS.map((k) => `${k}=${ctx.baselineMetrics![k]}`).join(', ')}`);

  const advancedPlanned = analyzeAndPlan(advancedPass);
  if (advancedPlanned.length) log(`      extensions (${advancedPlanned.length} fixes)`);
  await applyPlanned(advancedPlanned);

  progress({ type: 'phase', phase: 4, name: 'validation' });
  log('    phase 4/5 · validation');
  const glb = await addon.writeBytes(io, ctx.document, src, ctx.opts);
  const after = addon.collectMetrics(await addon.readBytes(io, glb), glb.byteLength);
  await addon.validate({
    ctx, before, after, glbBytes: glb, src, result,
    advancedPlannedIds: advancedPlanned.map((p) => p.rule.meta.id),
    addFound, log,
  });

  const validationOk = !result.validation.some((x) => x.level === 'fail');

  progress({ type: 'phase', phase: 5, name: 'report' });
  log('    phase 5/5 · report');
  const writeAsset = !o.dryRun;
  if (writeAsset) {
    try {
      fs.writeFileSync(dst, glb);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const err: Error & { i18n?: MessageRef } = new Error(render('engine.outDirGone', {}, locale));
      err.i18n = { messageId: 'engine.outDirGone', data: {} };
      throw err;
    }
  }
  const reportName = addon.writeReport({ name: dstName, result, before, after, assetWritten: writeAsset, opts: o });

  result.file.written = writeAsset;
  result.file.reportPath = path.join(o.outDir, reportName);
  result.metrics = { before, after };
  result.status = validationOk ? 'ok' : 'fail';
  return result;
}
