import type { Document } from '@gltf-transform/core';

export interface AttachedTexture {
  slot: string;
  file: string;
}

export interface ImportNote {
  animations: number;
  skins: number;
  missingTextures: string[];
  attached: AttachedTexture[];
}

export const emptyNote = (): ImportNote => ({ animations: 0, skins: 0, missingTextures: [], attached: [] });

const NOTES = new WeakMap<Document, ImportNote>();

export function setImportNote(doc: Document, note: ImportNote): void {
  NOTES.set(doc, note);
}

export function importNote(doc: Document): ImportNote | null {
  return NOTES.get(doc) || null;
}
