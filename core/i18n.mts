import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { MessageCatalog, MessageData, MessageRef } from './types.mjs';

const catalogs = new Map<string, MessageCatalog>();

const BASE_LOCALE = 'en';

export function register(locale: string, messages: MessageCatalog): void {
  const cur = catalogs.get(locale) || {};
  catalogs.set(locale, { ...cur, ...messages });
}

const CATALOG_FILE = /^([a-z]{2}(?:-[a-z]{2})?)\.mjs$/i;

export async function loadCatalogs(dir: string | URL): Promise<string[]> {
  const base = typeof dir === 'string' ? dir : fileURLToPath(dir);
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const name of names.sort()) {
    const m = CATALOG_FILE.exec(name);
    if (!m) continue;
    const locale = m[1]!.toLowerCase();
    try {
      const mod = await import(pathToFileURL(path.join(base, name)).href);
      const catalog = mod.default;
      if (catalog && typeof catalog === 'object') {
        register(locale, catalog as MessageCatalog);
        loaded.push(locale);
      }
    } catch (e) {
      console.warn(`[i18n] каталог ${name} не загрузился: ${(e as Error).message}`);
    }
  }
  return loaded;
}

export function render(messageId: string, data: MessageData = {}, locale: string = BASE_LOCALE): string {
  const cat = catalogs.get(locale);
  const tpl = cat ? cat[messageId] : undefined;
  if (tpl == null) {
    if (locale !== BASE_LOCALE) return render(messageId, data, BASE_LOCALE);
    const why = cat ? `missing message '${messageId}'` : `no catalog for locale '${locale}'`;
    throw new Error(`i18n: ${why} for locale '${locale}'`);
  }
  const values = resolveNested(data, locale);
  if (typeof tpl === 'function') return tpl(values);
  return String(tpl).replace(/\{(\w+)\}/g, (_, k: string) => (k in values ? String(values[k]) : `{${k}}`));
}

function resolveNested(data: MessageData, locale: string): MessageData {
  let out = data;
  for (const [k, v] of Object.entries(data)) {
    if (!isMessageRef(v)) continue;
    if (out === data) out = { ...data };
    out[k] = render(v.messageId, v.data || {}, locale);
  }
  return out;
}

function isMessageRef(v: unknown): v is MessageRef {
  return !!v && typeof v === 'object' && !!(v as MessageRef).messageId;
}

const LOCALIZED_LISTS = ['applied', 'skipped', 'findings', 'validation'];

export function localizeResult<T>(result: T, locale: string): T {
  if (!result || !locale) return result;
  const src = result as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  const rootRefs = src.i18n as Record<string, unknown> | undefined;
  if (rootRefs) {
    for (const [field, ref] of Object.entries(rootRefs)) {
      if (!isMessageRef(ref)) continue;
      try {
        out[field] = render(ref.messageId, ref.data || {}, locale);
      } catch (e) {
      }
    }
  }
  for (const key of LOCALIZED_LISTS) {
    const list = src[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.map((rec: unknown) => {
      const entry = rec as Record<string, unknown> | null;
      if (!entry || !entry.i18n) return rec;
      const next: Record<string, unknown> = { ...entry };
      for (const [field, ref] of Object.entries(entry.i18n as Record<string, unknown>)) {
        if (!isMessageRef(ref)) continue;
        try {
          next[field] = render(ref.messageId, ref.data || {}, locale);
        } catch (e) {
        }
      }
      return next;
    });
  }
  return out as T;
}
