// addons/gltf/rules.mjs — десять правил пайплайна glTF. Логика фиксов перенесена из
// optimize2.mjs без изменений; ВЕСЬ пользовательский текст вынесен в каталог
// (messages/en.mjs) — правила возвращают { messageId, data }, а не готовую строку
// (ядро рендерит их через core/i18n.mjs). Форма объекта-правила — см. core/types.mjs:
//   meta { id, category, title, severity, fixSafety, tier, runAfter, touches, enabled, ... }
//   analyze(ctx)          — фаза 1, только чтение
//   canFix(finding, ctx)  — { safe, messageId, data } (причина идёт в отчёт как ключ)
//   fix(finding, ctx)     — фаза 3, меняет ctx.document; возвращает { found/skipped/
//                           details/irreversible } — массивы { messageId, data }
//
// ВАЖНО (эквивалентность v2): бОльшая часть находок в glTF считается только по факту
// применения (diff до/после prune, вырожденные треугольники появляются ПОСЛЕ weld и
// т.д.). Поэтому analyze возвращает «задание» ({ messageId: 'pipeline' }), а конкретика
// с цифрами приходит из fix — ровно те же измерения, что делал v2.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as fns from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

import { render } from '../../core/i18n.mjs';
import { collectMetrics, countTriangles, effectiveSkins, listSemantics } from './metrics.mjs';
import { GLTF_CLI, TOKTX, runCli } from './tools.mjs';

// Порядок пайплайна ЖЁСТКИЙ и выверен в v2 (кодируется через runAfter):
// dedup → prune → vertex-colors → weld → degenerate → orphan → (flatten+join)
// → prune → ktx2 → geometry-compress. Не менять.
export const RULES = [
  {
    meta: {
      id: 'structure/dedup', category: 'materials', title: 'Duplicate resources (dedup)',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: ['texture', 'material', 'accessor'],
      reversible: false, dataLoss: 'none', // склеиваются только байт-в-байт идентичные копии — терять нечего
      enabled: (o) => o.safe,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'dedup.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, acc: root.listAccessors().length };
      await ctx.document.transform(fns.dedup());
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, acc: root.listAccessors().length };
      const out = { found: [], details: [] };
      if (b.tex > a.tex) { out.found.push({ messageId: 'dedup.found.textures', data: { n: b.tex - a.tex } }); out.details.push({ messageId: 'dedup.done.textures', data: { n: b.tex - a.tex } }); }
      if (b.mat > a.mat) { out.found.push({ messageId: 'dedup.found.materials', data: { n: b.mat - a.mat } }); out.details.push({ messageId: 'dedup.done.materials', data: { n: b.mat - a.mat } }); }
      if (b.acc > a.acc) { out.found.push({ messageId: 'dedup.found.accessors', data: { n: b.acc - a.acc } }); out.details.push({ messageId: 'dedup.done.accessors', data: { n: b.acc - a.acc } }); }
      return out;
    },
  },

  {
    meta: {
      id: 'structure/prune-unused', category: 'scene', title: 'Unused resources (prune)',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['structure/dedup'], touches: ['texture', 'material', 'accessor', 'node'],
      reversible: false, dataLoss: 'none', // удаляется только то, на что нет ни одной ссылки
      enabled: (o) => o.safe,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'prune.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const semBefore = listSemantics(ctx.document);
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      await ctx.document.transform(fns.prune({ keepAttributes: false, keepLeaves: false }));
      const semAfter = listSemantics(ctx.document);
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      const out = { found: [], details: [] };
      for (const s of semBefore) {
        if (!semAfter.has(s)) {
          out.found.push({ messageId: 'prune.found.attribute', data: { sem: s } });
          out.details.push({ messageId: 'prune.done.attribute', data: { sem: s } });
        }
      }
      if (b.tex > a.tex) { out.found.push({ messageId: 'prune.found.textures', data: { n: b.tex - a.tex } }); out.details.push({ messageId: 'prune.done.textures', data: { n: b.tex - a.tex } }); }
      if (b.mat > a.mat) { out.found.push({ messageId: 'prune.found.materials', data: { n: b.mat - a.mat } }); out.details.push({ messageId: 'prune.done.materials', data: { n: b.mat - a.mat } }); }
      if (b.skins > a.skins && b.effSkins === a.effSkins) {
        // удалены только пустышки: действующих скинов не убыло (иначе инвариант остановит запись)
        out.found.push({ messageId: 'prune.found.emptySkins', data: { n: b.skins - a.skins } });
        out.details.push({ messageId: 'prune.done.emptySkins', data: { n: b.skins - a.skins } });
      }
      return out;
    },
  },

  {
    meta: {
      // tier basic: базовое действие — удаление БЕЛЫХ каналов (provable, вид не меняется).
      // Lossy-ветка (удалить раскрашенные) — расширение 'strip-colors': включается только
      // через advancedFeatures:['strip-colors'] или флаг --strip-vertex-colors (→ opts.stripColors).
      id: 'attributes/vertex-colors', category: 'attributes', title: 'Vertex colors (COLOR_n)',
      severity: 'warn', fixSafety: 'provable', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['accessor'],
      // базовая ветка (белые каналы) — потери нет; strip-ветка помечает свои строки
      // через res.irreversible → dataLoss 'significant' на уровне applied-записи
      reversible: false, dataLoss: 'none',
      // белая-чистка входит в safe; удаление раскрашенных — флажок strip-colors (внутри fix)
      enabled: (o) => o.safe || o.stripColors,
    },
    // Детекция при применении, а не в analyze: COLOR-каналы, которые снесёт prune
    // (например неиспользуемый COLOR_1), не должны попадать в находки — v2 сканировал
    // ПОСЛЕ prune, сохраняем то же окно измерения.
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      // белый (все значения 1.0) → provable: множитель baseColor равен единице.
      // раскрашенный → lossy: убирается только явным флагом (решение внутри fix).
      return { safe: true, messageId: 'vertexColors.safe', data: {} };
    },
    fix(finding, ctx) {
      const out = { found: [], skipped: [], details: [] };
      const el = [];
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          for (const sem of prim.listSemantics()) {
            if (!sem.startsWith('COLOR_')) continue;
            const acc = prim.getAttribute(sem);
            let allWhite = true;
            const n = acc.getCount();
            for (let i = 0; i < n; i++) {
              acc.getElement(i, el); // нормализованные float-значения
              if (el.some((v) => v < 0.999)) { allWhite = false; break; }
            }
            const data = { sem, mesh: mesh.getName() || '—' };
            if (allWhite) {
              prim.setAttribute(sem, null);
              out.found.push({ messageId: 'vertexColors.found.white', data });
              out.details.push({ messageId: 'vertexColors.done.white', data });
            } else if (ctx.opts.stripColors) {
              prim.setAttribute(sem, null); // lossy, но пользователь явно форсировал флагом
              out.found.push({ messageId: 'vertexColors.found.painted', data });
              (out.irreversible ??= []).push({ messageId: 'vertexColors.stripped', data });
            } else {
              out.found.push({ messageId: 'vertexColors.found.painted', data });
              out.skipped.push({ messageId: 'vertexColors.skipped', data });
            }
          }
        }
      }
      return out;
    },
  },

  {
    meta: {
      id: 'geometry/weld', category: 'geometry', title: 'Vertex weld',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['attributes/vertex-colors'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none', // свариваются только идентичные вершины
      // geometry-чистка идёт и при компрессии: спека Draco — «decode → run all geometry
      // optimizations → encode». Без неё draco роняет вырожденные треугольники на записи →
      // расхождение с checkpoint. Поэтому safe ИЛИ compress.
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'weld.safe', data: {} }; },
    async fix(finding, ctx) {
      // точка отсчёта для инварианта «треугольники не изменились» — как в v2:
      // после prune/цветов, до сварки (weld порождает вырожденные треугольники)
      ctx.cache.set('trianglesBeforeWeld', countTriangles(ctx.document));
      let vb = 0, va = 0;
      for (const m of ctx.document.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); if (pos) vb += pos.getCount(); }
      await ctx.document.transform(fns.weld());
      for (const m of ctx.document.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); if (pos) va += pos.getCount(); }
      if (vb > va) {
        return { found: [{ messageId: 'weld.found', data: { n: vb - va } }], details: [{ messageId: 'weld.done', data: { before: vb, after: va } }] };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'geometry/degenerate-triangles', category: 'geometry', title: 'Degenerate triangles',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['geometry/weld'], touches: ['geometry'],
      reversible: false, dataLoss: 'none', // нулевая площадь — не рисовались
      enabled: (o) => o.safe || o.compress, // чистка геометрии нужна и перед компрессией
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'degenerate.safe', data: {} }; },
    fix(finding, ctx) {
      // два/три одинаковых индекса = нулевая площадь; считаем ПОСЛЕ weld (он их порождает).
      // Итог меряем дельтой по сцене: правка общего аксессора действует на все его инстансы.
      const trisBefore = countTriangles(ctx.document);
      const patched = new Set();
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          if (prim.getMode() !== 4) continue; // только TRIANGLES
          const indices = prim.getIndices();
          if (!indices || patched.has(indices)) continue;
          const arr = indices.getArray();
          const out = [];
          for (let i = 0; i + 2 < arr.length; i += 3) {
            const a = arr[i], b = arr[i + 1], c = arr[i + 2];
            if (a !== b && b !== c && a !== c) out.push(a, b, c);
          }
          if (out.length < arr.length) indices.setArray(new arr.constructor(out));
          patched.add(indices); // общий аксессор не обрабатываем дважды
        }
      }
      const sceneRemoved = trisBefore - countTriangles(ctx.document);
      ctx.cache.set('degenerateRemoved', sceneRemoved); // для инварианта по треугольникам
      if (sceneRemoved > 0) {
        return {
          found: [{ messageId: 'degenerate.found', data: { n: sceneRemoved } }],
          details: [{ messageId: 'degenerate.done', data: { n: sceneRemoved } }],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'geometry/orphan-vertices', category: 'geometry', title: 'Orphan vertices',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['geometry/degenerate-triangles'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none', // не адресованы индексами — не рисовались
      enabled: (o) => o.safe || o.compress, // чистка геометрии нужна и перед компрессией
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (typeof fns.compactPrimitive !== 'function') {
        return { safe: false, messageId: 'orphan.unavailable', data: {} };
      }
      return { safe: true, messageId: 'orphan.safe', data: {} };
    },
    fix(finding, ctx) {
      let before = 0;
      let after = 0;
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION');
          if (!pos || !prim.getIndices()) continue;
          before += pos.getCount();
          fns.compactPrimitive(prim);
          after += prim.getAttribute('POSITION').getCount();
        }
      }
      if (before > after) {
        return {
          found: [{ messageId: 'orphan.found', data: { n: before - after } }],
          details: [{ messageId: 'orphan.done', data: { n: before - after } }],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'scene/join', category: 'scene', title: 'Mesh join (flatten + join)',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['geometry/orphan-vertices'], touches: ['geometry', 'node'],
      reversible: false, dataLoss: 'significant', // §4d: структура узлов и имена частей теряются безвозвратно
      reversalNote: 'Node hierarchy and separate parts are merged — they cannot be restored from the result. To keep parts, use --keep-parts.',
      feature: 'join', // отдельный флажок (структурно, необратимо)
      enabled: (o) => o.join,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'join.safe', data: {} }; },
    async fix(finding, ctx) {
      const m = () => { const r = collectMetrics(ctx.document, 0); return { drawCalls: r.drawCalls, nodes: r.nodes, meshes: r.meshes }; };
      const b = m();
      await ctx.document.transform(fns.flatten(), fns.join());
      const a = m();
      if (b.drawCalls > a.drawCalls || b.nodes > a.nodes || b.meshes > a.meshes) {
        return {
          found: [{ messageId: 'join.found', data: { drawCalls: b.drawCalls, nodes: b.nodes } }],
          details: [{ messageId: 'join.done', data: { dcBefore: b.drawCalls, dcAfter: a.drawCalls, nodesBefore: b.nodes, nodesAfter: a.nodes } }],
        };
      }
      return {};
    },
  },

  {
    meta: {
      // GPU-инстансинг: повторяющиеся меши → EXT_mesh_gpu_instancing (меньше draw calls).
      // Отдельный флажок; расширение требует поддержки декодера на целевом сайте.
      id: 'scene/instance', category: 'scene', title: 'GPU instancing',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['node', 'mesh'],
      reversible: true, dataLoss: 'none',
      reversalNote: 'Instancing can be expanded back to individual nodes.',
      feature: 'instance',
      enabled: (o) => o.instance,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = { nodes: root.listNodes().length, dc: collectMetrics(ctx.document, 0).drawCalls };
      await ctx.document.transform(fns.instance());
      const a = { nodes: root.listNodes().length, dc: collectMetrics(ctx.document, 0).drawCalls };
      if (a.nodes < b.nodes || a.dc < b.dc) {
        return {
          found: [`repeated meshes turned into GPU instances (EXT_mesh_gpu_instancing)`],
          details: [`GPU instancing: draw calls ${b.dc} → ${a.dc}, nodes ${b.nodes} → ${a.nodes}`],
        };
      }
      return { skipped: ['no repeated meshes to instance'] };
    },
  },

  {
    meta: {
      // Ресэмпл анимаций: убрать избыточные ключевые кадры (без потерь качества).
      id: 'animation/resample', category: 'performance', title: 'Resample animations',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['accessor'],
      reversible: false, dataLoss: 'none',
      feature: 'resample',
      enabled: (o) => o.resample,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      if (!root.listAnimations().length) return { skipped: ['no animations to resample'] };
      const bytes = () => root.listAccessors().reduce((s, a) => { const arr = a.getArray(); return s + (arr ? arr.byteLength : 0); }, 0);
      const before = bytes();
      await ctx.document.transform(fns.resample());
      const after = bytes();
      if (after < before) return { details: [`Animation keyframes resampled — accessor data ${before} → ${after} bytes`] };
      return { skipped: ['no redundant keyframes to resample — animation already minimal'] };
    },
  },

  {
    meta: {
      id: 'structure/prune-final', category: 'scene', title: 'Cleanup of orphaned resources',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['scene/join', 'geometry/orphan-vertices'], touches: ['accessor', 'node'],
      reversible: false, dataLoss: 'none', // только осиротевшие после предыдущих фиксов ресурсы
      enabled: (o) => o.safe || o.join || o.compress, // финальная зачистка после safe/склейки/компрессии

    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'pruneFinal.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = root.listAccessors().length;
      await ctx.document.transform(fns.prune()); // как в v2: подчистка после всех проходов
      const a = root.listAccessors().length;
      if (b > a) return { details: [{ messageId: 'pruneFinal.done', data: { n: b - a } }] };
      return {};
    },
  },

  {
    meta: {
      // ADVANCED: KTX2 требует KTX2Loader (Three.js) / поддержку basisu в движке —
      // работает не «везде», поэтому только явный opt-in (advancedFeatures:['ktx2'] / --ktx2).
      // normalizeOpts переводит выбор фичи в noKtx:false — enabled смотрит на итоговую опцию.
      id: 'textures/ktx2', category: 'textures', title: 'Textures → KTX2/UASTC',
      severity: 'warn', fixSafety: 'perceptual', tier: 'advanced', feature: 'ktx2',
      runAfter: ['structure/prune-final'], touches: ['texture'],
      reversible: true, dataLoss: 'minor', // §4d: KTX2 ↔ PNG/WebP, потеря от BASIS-U распаковки
      reversalNote: 'KTX2 can be unpacked back to PNG/WebP with a small quality loss (BASIS decoding).',
      enabled: (opts) => !opts.noKtx,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (!TOKTX || !GLTF_CLI) {
        return { safe: false, messageId: 'ktx2.noTools', data: {} };
      }
      return { safe: true, messageId: 'ktx2.safe', data: {} };
    },
    async fix(finding, ctx) {
      const out = { found: [], skipped: [], details: [] };
      // data-текстуры (нормали/occlusion/roughness) — UASTC: ETC1S мылит нормали и даёт
      // ступеньки на roughness. Цветовые (baseColor/emissive/прочее) — ETC1S: в разы
      // легче в файле при той же экономии VRAM. Regex и glob должны совпадать по смыслу.
      const DATA_SLOT_RE = /normal|occlusion|roughness/i;
      const DATA_SLOT_GLOB = '*{normal,Normal,occlusion,Occlusion,metallicRoughness,Roughness}*';
      const dataTex = [];
      const colorTex = [];
      for (const tex of ctx.document.getRoot().listTextures()) {
        const mime = tex.getMimeType();
        const name = tex.getName() || '—';
        if (mime === 'image/ktx2') {
          out.skipped.push({ messageId: 'ktx2.skipped.already', data: { name } });
          continue;
        }
        if (mime === 'image/webp' || mime === 'image/jpeg') {
          const sharp = (await import('sharp')).default; // ленивый импорт: нужен только для WebP/JPEG
          const png = await sharp(Buffer.from(tex.getImage())).png().toBuffer();
          tex.setImage(png);
          tex.setMimeType('image/png');
          out.details.push({ messageId: 'ktx2.done.toPng', data: { name, mime } });
        }
        const slots = fns.listTextureSlots(tex).join(' ');
        if (DATA_SLOT_RE.test(slots)) dataTex.push(name);
        else colorTex.push(name);
      }
      const needKtx = dataTex.length + colorTex.length;
      if (needKtx === 0) {
        ctx.log(render('ktx2.log.skipped', {}, ctx.opts.locale));
        return out;
      }
      out.found.push({ messageId: 'ktx2.found', data: { n: needKtx } });
      const mixed = ctx.opts.texMode === 'mixed';
      ctx.log(render('ktx2.log.encoding', { n: needKtx, mixed }, ctx.opts.locale));
      // Промежуточные файлы KTX2-конвейера. Раньше лежали в ctx.outDir под именами
      // `_tmp_<имя модели>` — два параллельных вызова с одинаковым именем модели писали
      // в один и тот же файл, и модель получала чужие текстуры. Отдельный каталог в
      // системной temp снимает и это, и второй случай: модель, которую УЖЕ зовут
      // `_tmp_model.glb`, совпадала по имени с temp-файлом соседней `model.glb`.
      // Побочно: аварийно завершённый процесс больше не оставляет мусор в output/ —
      // недобранное подчистит ОС.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-ktx2-'));
      const tmpA = path.join(tmpDir, `_tmp_${ctx.dstName}`);
      const tmpB = path.join(tmpDir, `_tmp2_${ctx.dstName}`);
      const tmpC = path.join(tmpDir, `_tmp3_${ctx.dstName}`);
      try {
        await ctx.io.write(tmpA, ctx.document);
        let cur = tmpA;
        if (mixed) {
          if (dataTex.length) { runCli(['uastc', cur, tmpB, '--slots', DATA_SLOT_GLOB, '--level', '2', '--zstd', '18']); cur = tmpB; }
          if (colorTex.length) { runCli(['etc1s', cur, tmpC, '--slots', `!(${DATA_SLOT_GLOB})`, '--quality', '255']); cur = tmpC; }
        } else {
          runCli(['uastc', cur, tmpB, '--level', '2', '--zstd', '18']);
          cur = tmpB;
        }
        ctx.document = await ctx.io.read(cur); // дальше пайплайн работает с KTX2-версией
      } finally {
        // каталог целиком — вместе с тем, что мог дописать сам toktx
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* занят — подчистит ОС */ }
      }
      if (mixed) {
        if (colorTex.length) out.details.push({ messageId: 'ktx2.done.color', data: { n: colorTex.length, list: colorTex.join(', ') } });
        if (dataTex.length) out.details.push({ messageId: 'ktx2.done.data', data: { n: dataTex.length, list: dataTex.join(', ') } });
      } else {
        out.details.push({ messageId: 'ktx2.done.uastc', data: { n: needKtx } });
      }
      return out;
    },
  },

  {
    meta: {
      // tier advanced — обязательно. Сжатие геометрии должно идти ПОСЛЕ снимка
      // baseline-checkpoint, иначе снимок берётся с уже сжатой модели и сверка фазы 4
      // сравнивает Draco сам с собой: повреждение кодеком становится ненаблюдаемым.
      // Раньше стояло tier:'basic' с рассуждением «Meshopt базовый, advanced — только
      // выбор кодека». Практический эффект: правило попадало во второй проход лишь
      // косвенно, через runAfter ['textures/ktx2'] — и только когда KTX2 включён.
      // Без KTX2 (обычный случай `['safe','draco']`) сжатие уезжало в первый проход,
      // и checkpoint фиксировался уже после него.
      id: 'geometry/compress', category: 'geometry', title: 'Geometry compression',
      severity: 'info', fixSafety: 'numeric', tier: 'advanced', runAfter: ['textures/ktx2', 'structure/prune-final'], touches: ['geometry', 'accessor'],
      reversible: true, dataLoss: 'none', // §4d: Draco/Meshopt ↔ стандартный формат в пределах точности float32
      reversalNote: 'Compressed geometry unpacks back to the standard format without data loss.',
      feature: 'meshopt', // компрессия геометрии — opt-in (флажок meshopt или draco → codec)
      enabled: (o) => o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'compress.safe', data: {} }; },
    async fix(finding, ctx) {
      if (ctx.opts.codec === 'draco') {
        await ctx.document.transform(fns.draco());
      } else {
        await ctx.document.transform(fns.meshopt({ encoder: MeshoptEncoder }));
      }
      return { details: [{ messageId: 'compress.done', data: { codec: ctx.opts.codec } }] };
    },
  },
];
