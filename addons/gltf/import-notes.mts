/**
 * addons/gltf/import-notes.mts — что случилось при ВВОЗЕ чужого формата.
 *
 * Отдельный модуль, потому что записку заполняет один код (разбор файла), а читает
 * другой (правила отчёта), и связывать их напрямую значило бы дать правилам знать про
 * FBX. Правила про формат ввоза не знают и знать не должны: их вопрос — «что сказать
 * человеку», а не «откуда это приехало».
 *
 * ПОЧЕМУ WeakMap, А НЕ `extras` ДОКУМЕНТА. `extras` уезжают в СОБРАННЫЙ файл, и наша
 * служебная записка стала бы частью модели человека — мусором в чужом файле, который он
 * повезёт на площадку. Здесь она живёт ровно столько, сколько живёт сам документ, и
 * наружу не попадает никогда.
 */

import type { Document } from '@gltf-transform/core';

/** Куда легла карта: слот материала и файл, из которого она взята. */
export interface AttachedTexture {
  /** Ключ сообщения слота: baseColor, normal, metallicRoughness, occlusion, emissive. */
  slot: string;
  /** Имя файла, как его видел человек. */
  file: string;
}

/** Что случилось при ввозе: и потери, и находки. */
export interface ImportNote {
  /** Анимационных дорожек в исходнике (в glTF пока не переносим). */
  animations: number;
  /** Скинов — там же. */
  skins: number;
  /** Имена текстур, которые файл НАЗЫВАЕТ, а рядом их не оказалось. */
  missingTextures: string[];
  /** Карты, подобранные среди соседей по имени файла (см. attachNeighbourTextures). */
  attached: AttachedTexture[];
}

/** Пустая записка — чтобы никто не собирал её по полю и не забыл новое. */
export const emptyNote = (): ImportNote => ({ animations: 0, skins: 0, missingTextures: [], attached: [] });

const NOTES = new WeakMap<Document, ImportNote>();

/** Привязать записку к документу. Зовёт тот, кто разбирал файл. */
export function setImportNote(doc: Document, note: ImportNote): void {
  NOTES.set(doc, note);
}

/** Записка о ввозе для этого документа, если он приехал из чужого формата. */
export function importNote(doc: Document): ImportNote | null {
  return NOTES.get(doc) || null;
}
