// index.ts — обвязка двух вьюпортов (оригинал ⇄ оптимизировано) поверх движка просмотра.
//
// Модуль НЕ знает про Three.js напрямую: он работает через узкий интерфейс, который даёт
// createViewer() (сейчас единственная реализация — Three.js, см. viewer.js). Это тот же
// приём «шва», что core/addon в ядре: завтра можно подменить движок просмотра или добавить
// режим (дизайнерский, показ пропавших точек), не трогая эту обвязку и app.js.
//
// Наружу отдаётся глобальный API window.OptiViewer — его дёргает классический app.js
// (который остаётся не-модульным скриптом), чтобы модульность просмотрщика не протекала
// в остальной UI.
//
// Импорт пишется с расширением `.js`, хотя рядом лежит `.ts`: это адрес, по которому
// файл запросит БРАУЗЕР, а собранное кладётся под тем же именем. Компилятор такую
// запись понимает и не переписывает — см. tsconfig.ui.json.

import { Viewer } from "./viewer.js";
import type { CameraState, PackEntry, ViewerLike } from "./contract.js";

/**
 * Реализации движка просмотра, которые приложение действительно везёт с собой.
 *
 * Ключ — то самое имя, которое движок называет полем `viewer` в `engines/<id>.json`
 * (ARCHITECTURE.md §4g): «другой движок — другой вьюпорт» становится добавлением строки
 * сюда и файла движка, а не правкой обвязки и app.js.
 *
 * Тип значения — `ViewerLike`, а НЕ класс `Viewer`. Разница видна только со вторым
 * движком, и она решающая: класс три.js несёт `renderer: THREE.WebGLRenderer`,
 * `scene: THREE.Scene`, `_draco: DRACOLoader`, и структурная совместимость потребовала
 * бы всего этого от чужой реализации. Сам контракт — в `contract.ts`, там же разобрано,
 * обо что спотыкался второй движок (`ROADMAP.md` §5g).
 */
const VIEWERS: Record<string, (canvas: HTMLCanvasElement) => ViewerLike> = {
  threejs: (canvas) => new Viewer(canvas),
};

// Имя реализации, которую монтировать. Пустое значение — единственная сегодняшняя
// норма: движок мог не назвать вьюпорт, и это не повод остаться без картинки.
let wantedViewer = 'threejs';

/**
 * Сказать обвязке, какой вьюпорт монтировать дальше. Незнакомое имя НЕ подставляется
 * молча: мы бы нарисовали чужим движком и выдали это за верный предпросмотр — а
 * предпросмотр здесь главное, ради чего приложение существует. Поэтому остаёмся на
 * прежней реализации и говорим об этом в консоль.
 */
function useViewer(id: string) {
  if (!id || id === wantedViewer) return wantedViewer;
  if (!VIEWERS[id]) {
    console.warn(`[viewer] Движок просит вьюпорт «${id}», а приложение везёт только: ${Object.keys(VIEWERS).join(', ')}. Остаюсь на «${wantedViewer}».`);
    return wantedViewer;
  }
  wantedViewer = id;
  return wantedViewer;
}

function createViewer(canvas: HTMLCanvasElement) {
  return VIEWERS[wantedViewer]!(canvas);
}

// Окно замера нагрузки на отрисовку: 60 кадров — примерно секунда на 60-герцовом
// мониторе. Короче — цифра дёргается и её невозможно читать; длиннее — реакция на
// смену модели становится заметно вялой. Подробности замера — у DualViewport._pushPerf.
const PERF_WINDOW = 60;

function median(arr: ArrayLike<number>) {
  const s = Array.from(arr).sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Привести адрес соседнего файла к одному виду, чтобы написанное в `.gltf` совпало с
 * тем, что человек бросил.
 *
 * Три расхождения, каждое из которых встречается в настоящих файлах:
 *   - косая черта задом наперёд (`textures\wood.png`) — так пишет часть экспортёров;
 *   - `./` в начале — законно и ничего не значит;
 *   - проценты (`w%20ood.png`) — по стандарту адрес в glTF закодирован, а имя файла на
 *     диске нет.
 *
 * Регистр приводим к нижнему. Причина не в лени: файл с именем `Wood.PNG` и ссылка на
 * `wood.png` — обычное дело, потому что автор собирал модель на Windows, где это ОДИН
 * файл. Двух файлов, различающихся только регистром, там существовать не может, значит
 * склеить разные под одним ключом мы не рискуем.
 */
function normalizeAssetPath(raw: string) {
  let s = String(raw || "").split("\\").join("/");
  try { s = decodeURIComponent(s); } catch { /* адрес закодирован не по правилам — берём как есть */ }
  s = s.replace(/^\.\//, "").replace(/^\/+/, "");
  return s.toLowerCase();
}

/**
 * Один слот сравнения: панель `.vp-pane` с <canvas> и строкой статуса.
 * Лениво создаёт движок при первой загрузке (когда контейнер уже виден и имеет размер).
 */
class ViewportSlot {
  // `declare` — объявление ТОЛЬКО для проверки типов: в собранный файл эти строки не
  // попадают. Обычное поле класса компилятор превратил бы в реальное определение
  // свойства перед телом конструктора, то есть добавил бы в вывод код, которого в
  // исходном .js не было. Значения по-прежнему присваивает конструктор.
  declare container: HTMLElement;
  declare canvas: HTMLCanvasElement | null;
  declare statusEl: HTMLElement | null;
  declare viewer: ViewerLike | null;
  declare _blobUrl: string | null;
  /** Адреса соседних файлов пачки. Живут ровно одну загрузку — см. _revokePack. */
  declare _packUrls: string[];

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = container.querySelector<HTMLCanvasElement>(".viewer-canvas");
    this.statusEl = container.querySelector<HTMLElement>(".viewer-status");
    this.viewer = null;
    this._blobUrl = null;
    this._packUrls = [];
  }

  _ensureViewer() {
    if (!this.viewer) this.viewer = createViewer(this.canvas!);
    return this.viewer;
  }

  /**
   * Подпись посреди панели. Принимает КЛЮЧ каталога, а не готовую строку.
   *
   * Правило 8: ни одной пользовательской строки в логике. Раньше здесь стояли
   * английские литералы («Loading…», «Run optimization to compare»), и в русском
   * интерфейсе они такими и оставались.
   *
   * `I18n.setText` не просто переводит, а ПОМЕЧАЕТ элемент ключом. Поэтому смена
   * языка перерисовывает подпись сама, через общий apply() — без перезагрузки модели
   * и без пересчёта чего бы то ни было (Правило 8 §1). Без пометки подпись
   * «Загрузка…» осталась бы русской после переключения на английский.
   *
   * @param key     ключ каталога; null или '' — убрать подпись
   * @param values  подстановки одного сообщения (Правило 8 §3: «Загрузка… 45 %» —
   *                ОДНО сообщение с подстановкой, а не склейка слова и числа в коде)
   */
  _setStatus(key: string | null, values?: UiParams) {
    if (!this.statusEl) return;
    // Текст живёт в отдельном span, а не прямо в контейнере. Контейнер растянут на всю
    // панель (inset: 0) и служит только для центрирования — повесь фон на него, и
    // закрасится вся панель. Плашка обязана облегать буквы, а не занимать вьюпорт.
    // textContent контейнера при этом читается по-прежнему: он собирает текст потомков.
    this.statusEl.textContent = "";
    if (key) {
      const plate = document.createElement("span");
      plate.className = "viewer-status-plate";
      if (window.I18n) window.I18n.setText(plate, key, values);
      else plate.textContent = key;   // каталог не загрузился — лучше ключ, чем пустота
      this.statusEl.appendChild(plate);
    }
    this.statusEl.classList.toggle("hidden", !key);
  }

  _revokeBlob() {
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
  }

  _revokePack() {
    for (const u of this._packUrls) URL.revokeObjectURL(u);
    this._packUrls = [];
    this.viewer?.setAssetResolver?.(null);
  }

  /**
   * Подставить движку соседние файлы модели вместо адресов, по которым идти некуда.
   *
   * Как загрузчик считает адрес соседа: берёт адрес самой модели, отрезает всё после
   * последней косой черты и приклеивает то, что написано в `.gltf`. У blob-адреса
   * (`blob:http://host/8d1f-…`) отрезание даёт `blob:http://host/`, и сосед превращается
   * в `blob:http://host/textures/wood.png` — адрес, за которым НЕТ ничего и никогда не
   * будет. Поэтому подмена ловит всё, что начинается с этой основы, и отдаёт blob того
   * файла, который человек бросил.
   *
   * Заодно это и есть защита от сети: несуществующий blob-адрес наружу не ходит, а
   * подменённый — тем более. Ни одного запроса за пределы вкладки (Правило: приложение
   * работает без интернета).
   *
   * Возвращает множество НЕНАЙДЕННЫХ адресов: модель ссылается, а файла в пачке нет.
   * Молчать об этом нельзя — человек увидел бы пустой вьюпорт без единого слова о причине.
   */
  _installPack(viewer: ViewerLike, modelUrl: string, pack?: PackEntry[] | null) {
    this._revokePack();
    const missing = new Set<string>();
    if (!pack || !pack.length) return missing;
    if (typeof viewer.setAssetResolver !== "function") {
      // Движок без подмены адресов покажет пачку без текстур. Это не отказ показать
      // модель, но и не то, что человек бросил, — значит говорим вслух.
      console.warn("[viewer] Движок не умеет брать соседние файлы модели — пачка будет показана без них.");
      return missing;
    }

    const base = modelUrl.slice(0, modelUrl.lastIndexOf("/") + 1);
    const byPath = new Map<string, string>();
    // Второй указатель — ПО ИМЕНИ файла, и только для имён, встречающихся в пачке один
    // раз. Нужен там, где модель называет соседа с папкой, а человек бросил файлы плоско:
    // FBX почти всегда пишет «textures/wood.png», а выбор через «+» приносит «wood.png».
    // Без этого модель показывалась бы без карт, хотя все файлы у нас на руках.
    //
    // Условие «один раз» обязательно, и оно не осторожность ради осторожности: две
    // картинки вполне могут зваться basecolor.png и лежать в разных папках — ровно тот
    // случай, ради которого пачка вообще носит ПУТИ, а не имена. Двойник просто не
    // попадает в этот указатель, и поиск по нему остаётся строгим.
    const byName = new Map<string, string | null>();
    for (const item of pack) {
      if (!item || !item.file) continue;
      const blobUrl = URL.createObjectURL(item.file);
      this._packUrls.push(blobUrl);
      const rel = normalizeAssetPath(item.path);
      byPath.set(rel, blobUrl);
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      byName.set(name, byName.has(name) ? null : blobUrl);
    }

    viewer.setAssetResolver((requested: string) => {
      if (requested === modelUrl || !base || !requested.startsWith(base)) return null;
      const rel = normalizeAssetPath(requested.slice(base.length));
      const hit = byPath.get(rel);
      if (hit) return hit;
      const byBase = byName.get(rel.slice(rel.lastIndexOf("/") + 1));
      if (byBase) return byBase;
      missing.add(rel);
      return null;
    });
    return missing;
  }

  /** Загрузить модель из URL (строка) или File (создаётся blob URL).
   *  opts.camera — ракурс, который надо сохранить вместо авто-кадрирования (сборка/ребилд).
   *  opts.pack — соседние файлы (.bin, текстуры) для `.gltf`, брошенного вместе с ними. */
  async load(source: string | File | Blob, opts: { camera?: CameraState | null; pack?: PackEntry[] | null } = {}) {
    // Формат берём У ФАЙЛА, пока имя ещё есть: дальше модель живёт blob-адресом, а в нём
    // расширения нет вовсе, и узнать по адресу, что это STL, невозможно.
    const format = source instanceof File
      ? (source.name.split('.').pop() || '').toLowerCase()
      : null;
    const viewer = this._ensureViewer();
    this._setStatus("viewer.status.loading");

    let url = source as string;
    if (source instanceof File || source instanceof Blob) {
      this._revokeBlob();
      url = this._blobUrl = URL.createObjectURL(source);
    }

    const missing = this._installPack(viewer, url, opts.pack);
    try {
      await viewer.load(url, {
        format,
        camera: opts.camera || null,
        onProgress: (e: ProgressEvent) => {
          if (e && e.lengthComputable) {
            this._setStatus("viewer.status.loadingPct", { pct: Math.round((e.loaded / e.total) * 100) });
          }
        },
      });
      this._setStatus(null);
    } catch (err) {
      console.error("Viewer failed to load model:", err);
      this._setStatus("viewer.status.unavailable");
      this._revokeBlob();
      if (missing.size) console.warn('[viewer] Пачка не дала файлов, которые запросил загрузчик:', [...missing].join(', '));
      return null;
    } finally {
      // Соседи нужны ровно на время разбора: дальше картинки живут в видеопамяти, а
      // blob-адреса держали бы файлы в памяти вкладки до перезагрузки страницы.
      this._revokePack();
    }
    this._revokeBlob();
    // Загрузчик спросил файл, которого в пачке нет. Человеку об этом говорит НЕ здесь:
    // приложение сверяет пачку со списком ссылок внутри `.gltf` ещё до загрузки и
    // называет нехватку одной строкой (там же видны файлы-сироты, за которыми
    // загрузчик и не пойдёт). Эта же запись — про НАС: если тут что-то есть, а сверка
    // промолчала, значит адреса разошлись при приведении к общему виду.
    if (missing.size) console.warn('[viewer] Пачка не дала файлов, которые запросил загрузчик:', [...missing].join(', '));
    return { stats: viewer.getStats(), detected: viewer.getDetection() };
  }

  renderFrame() {
    if (this.viewer) this.viewer.renderFrame();
  }

  /** Подсказка в пустой панели. Аргумент — КЛЮЧ каталога, не готовая строка. */
  showHint(key: string, values?: UiParams) {
    this._setStatus(key, values);
  }

  /**
   * Опустошить слот: снять модель, разобрать движок и ГАРАНТИРОВАННО очистить полотно.
   *
   * Очистка живёт здесь, а не внутри движка: движок освобождает свои ресурсы, но canvas
   * хранит последний отрисованный кадр сам по себе, а пустой слот больше не перерисовывается —
   * иначе в нём висит «замороженная» картинка прошлой модели.
   *
   * Сбрасываем РАЗМЕР буфера отрисовки: это единственный способ очистки, не требующий знать
   * графический API (подойдёт и WebGL, и WebGPU, и 2D) — значит сброс одинаков для ЛЮБОГО
   * движка просмотра и не зависит от того, помнит ли новый движок про очистку (см. контракт
   * у createViewer()). Важно ставить ИМЕННО другой размер: присваивание того же значения
   * буфер не пересоздаёт и содержимое не стирает (проверено в Chrome). 1×1 прозрачного
   * полотна не видно, а следующий движок при создании сам развернёт canvas по панели.
   */
  reset() {
    this._revokeBlob();
    this._revokePack();
    if (this.viewer) {
      this.viewer.dispose();
      this.viewer = null;
    }
    if (this.canvas) {
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
    this._setStatus(null);
  }
}

class DualViewport {
  // Только объявления (см. пояснение про `declare` у ViewportSlot).
  declare left: ViewportSlot | null;
  declare right: ViewportSlot | null;
  declare linked: boolean;
  declare _syncing: boolean;
  declare _rafId: number | null;
  declare _animPlaying: boolean;
  declare _animTime: number;
  declare _animClipIndex: number;
  /** Выбранный вариант материала; null — основной вид из файла. Переживает загрузку. */
  declare _variantName: string | null;
  /** Показанный уровень детализации; null — как в файле. Тоже переживает загрузку. */
  declare _lodIndex: number | 'all' | null;
  /** Выбранный ракурс автора; null — своя орбита. Переживает сборку, но не смену модели. */
  declare _cameraIndex: number | null;
  /** Чей свет показываем. Тоже переживает сборку, но не смену модели. */
  declare _lightMode: 'studio' | 'file';
  declare _exposure: number;
  /** Материал показа, один на оба окна. См. setDisplayMaterial. */
  declare _display: 'file' | 'clay';
  declare _perf: { left: Float64Array; right: Float64Array; frame: Float64Array; i: number };
  // Эти два появляются позже конструктора и до тех пор отсутствуют — отсюда `?`:
  // снятие подписки заводится при связывании камер, слушатель загрузки — из UI.
  declare _unlink?: (() => void) | null;
  declare _onLoaded?: (() => void) | null;

  constructor() {
    this.left = null; // оригинал
    this.right = null; // оптимизировано
    this.linked = true; // связанные камеры: крутишь один — синхронно второй
    this._syncing = false;
    this._rafId = null;
    // Анимация проигрывается сразу: модель, у которой она есть, должна двигаться
    // без нажатий. Пауза нужна, чтобы РАССМОТРЕТЬ конкретный кадр, а не чтобы
    // включить движение.
    this._animPlaying = true;
    this._animTime = 0;
    this._animClipIndex = 0; // выбранный клип переживает загрузку новой модели
    this._variantName = null; // выбранный вариант материала — тоже (см. _applyVariantSelection)
    this._lodIndex = null;    // и показанный уровень детализации
    this._cameraIndex = null; // и выбранный ракурс автора (см. _applyCameraSelection)
    this._lightMode = 'studio'; // и чей свет показываем
    this._exposure = 1;      // 1.0 — как отдаёт three.js без поправки
    // Кольцевые буферы замера отрисовки; заполняются в _pushPerf каждый кадр.
    this._perf = {
      left: new Float64Array(PERF_WINDOW),
      right: new Float64Array(PERF_WINDOW),
      frame: new Float64Array(PERF_WINDOW),
      i: 0,
    };
  }

  /** Сбросить окно замера — после загрузки новой модели прежние кадры уже не про неё. */
  _resetPerf() {
    this._perf.i = 0;
  }

  _init() {
    if (this.left && this.right) return true;
    const leftEl = document.getElementById("preview-original");
    const rightEl = document.getElementById("preview-optimized");
    if (!leftEl || !rightEl) return false;
    this.left = new ViewportSlot(leftEl);
    this.right = new ViewportSlot(rightEl);
    return true;
  }

  /**
   * Подписывает контролы двух вьюпортов друг на друга. Снимает предыдущую подписку перед
   * новой — иначе повторный show() без reset() между ними копил бы 'change'-слушатели на
   * тех же экземплярах Viewer (they persist across show() calls; см. ViewportSlot._ensureViewer).
   */
  _linkCameras() {
    this._unlinkCameras();
    if (!this.left!.viewer || !this.right!.viewer) return;

    const sync = (from: ViewerLike, to: ViewerLike) => {
      if (this._syncing || !this.linked) return;
      this._syncing = true;
      to.applyCameraState(from.getCameraState());
      this._syncing = false;
    };
    const onLeftChange = () => sync(this.left!.viewer!, this.right!.viewer!);
    const onRightChange = () => sync(this.right!.viewer!, this.left!.viewer!);

    this.left!.viewer.controls.addEventListener("change", onLeftChange);
    this.right!.viewer.controls.addEventListener("change", onRightChange);
    this._unlink = () => {
      this.left!.viewer?.controls.removeEventListener("change", onLeftChange);
      this.right!.viewer?.controls.removeEventListener("change", onRightChange);
    };
  }

  _unlinkCameras() {
    if (this._unlink) {
      this._unlink();
      this._unlink = null;
    }
  }

  _startLoop() {
    if (this._rafId != null) return;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - prev) / 1000, 0.1); // клип времени: вкладка была свёрнута
      prev = now;
      this._advanceAnimation(dt);
      // Время каждого вьюпорта меряется отдельно, время кадра — общее.
      // Почему именно так — см. комментарий у _perf ниже.
      const t0 = performance.now();
      this.left!.renderFrame();
      const t1 = performance.now();
      this.right!.renderFrame();
      const t2 = performance.now();
      this._pushPerf(t0, t1, t2, dt);
      this._rafId = requestAnimationFrame(tick);
    };
    prev = performance.now();
    this._rafId = requestAnimationFrame(tick);
  }

  // -----------------------------------------------------------------------
  // Замер нагрузки на отрисовку.
  //
  // ВАЖНО, почему здесь НЕ «FPS слева» и «FPS справа». Оба вьюпорта рисуются
  // в ОДНОМ кадре одного requestAnimationFrame (см. tick выше) — кадр у них
  // общий физически. Считать кадры отдельно по вьюпортам значит получить два
  // одинаковых числа по построению: они всегда совпадут, что бы ни показала
  // оптимизация. А само число почти всегда упрётся в частоту монитора: rAF
  // не даёт рисовать чаще, и на настольной видеокарте обе сцены успевают в
  // бюджет кадра. Пользователь увидел бы «60 и 60» и прочитал бы это как
  // «оптимизация ничего не дала».
  //
  // Различается — время, которое занимает renderFrame() каждого вьюпорта.
  // Оно растёт с числом вызовов отрисовки и переключений состояния, то есть
  // ровно с тем, что и правит оптимизация. Мерится в одном кадре, на одной
  // машине, в одну и ту же секунду — это честное сравнение «до/после».
  //
  // Чего это число НЕ значит: это время работы CPU по подготовке и отправке
  // кадра, а не время самой видеокарты (WebGL асинхронен, дожидаться его
  // пришлось бы принудительной синхронизацией, которая исказит замер).
  // И это машина автора, а не телефон посетителя сайта. Показатель
  // относительный: во сколько раз легче стало, а не «столько будет у людей».
  //
  // Медиана по окну в 60 кадров, а не среднее: одиночная задержка от сборщика
  // мусора или переключения вкладки не должна дёргать цифру.
  // -----------------------------------------------------------------------

  _pushPerf(t0: number, t1: number, t2: number, dt: number) {
    const p = this._perf;
    p.left[p.i % PERF_WINDOW] = t1 - t0;
    p.right[p.i % PERF_WINDOW] = t2 - t1;
    p.frame[p.i % PERF_WINDOW] = dt * 1000;
    p.i++;
  }

  /**
   * Нагрузка на отрисовку за последние PERF_WINDOW кадров.
   * `null`, пока окно не набралось — показывать половину замера хуже, чем ничего.
   */
  getPerf() {
    const p = this._perf;
    if (p.i < PERF_WINDOW) return null;
    return {
      leftMs: median(p.left),
      rightMs: median(p.right),
      fps: 1000 / Math.max(median(p.frame), 0.001), // общий на оба вьюпорта
    };
  }

  // -----------------------------------------------------------------------
  // Анимация: одно время на оба вьюпорта.
  //
  // Часы живут здесь, а не внутри вьюпортов. Оба получают ОДНО И ТО ЖЕ абсолютное
  // время каждый кадр — поэтому оригинал и результат всегда в одной позе. Если бы
  // каждый вьюпорт тикал сам, они разъехались бы по фазе за первые секунды: правый
  // грузится позже, кадры пропускаются неравномерно. Сравнивать «до и после» стало
  // бы нельзя — глаз ловил бы разницу поз, а не разницу оптимизации.
  // -----------------------------------------------------------------------

  // Слоты создаются лениво, в _init() при первой загрузке модели: до неё
  // this.left и this.right — null. app.js опрашивает getAnimation() с первого
  // кадра страницы, поэтому все методы ниже обязаны переживать пустое состояние.
  _advanceAnimation(dt: number) {
    if (this._animPlaying) this._animTime = (this._animTime || 0) + dt;
    const t = this._animTime || 0;
    this.left?.viewer?.setAnimationTime(t);
    this.right?.viewer?.setAnimationTime(t);
  }

  /** Есть ли что проигрывать и что именно — для панели управления в app.js. */
  getAnimation() {
    const info = this.left?.viewer?.getAnimationInfo?.() || { count: 0, names: [], index: -1, duration: 0 };
    return {
      ...info,
      playing: !!this._animPlaying,
      time: this._animTime || 0,
      // Индекс клипа по сторонам — чтобы рассинхрон был видимой величиной, а не
      // ощущением «дёргается не в такт». Именно он и был дефектом: правый вьюпорт
      // после сборки оставался на клипе 0, пока не переключишь вручную.
      leftIndex: this.left?.viewer?.getAnimationInfo?.().index ?? -1,
      rightIndex: this.right?.viewer?.getAnimationInfo?.().index ?? -1,
    };
  }

  /**
   * Варианты материала загруженной модели — для панели управления.
   *
   * Спрашиваем ЛЕВЫЙ вьюпорт: он показывает исходник, и список вариантов в нём полный
   * по определению. Если справа их окажется меньше — это дефект оптимизации, и увидеть
   * его должен отчёт, а не молчаливо укоротившийся список.
   */
  getVariants() {
    const info = this.left?.viewer?.getVariantInfo?.() || { count: 0, names: [], current: null };
    return { ...info, selected: this._variantName ?? null };
  }

  /**
   * Переключить вариант В ОБОИХ окнах. Смысл сравнения в том, что слева и справа одна
   * и та же модель в одном и том же виде; разъехавшийся выбор цвета превратил бы
   * сравнение оптимизации в сравнение окрасок.
   *
   * Выбор запоминается: следующая загруженная модель придёт на тот же вариант — та же
   * причина, что у клипа анимации (см. _applyAnimSelection).
   */
  async selectVariant(name: string | null) {
    this._variantName = name;
    await Promise.all([
      this.left?.viewer?.setVariant?.(name),
      this.right?.viewer?.setVariant?.(name),
    ]);
  }

  /**
   * Уровни детализации загруженной модели — для панели управления.
   *
   * Спрашиваем ЛЕВЫЙ вьюпорт: он показывает исходник, и набор уровней в нём полный по
   * определению. Меньше справа — это находка про оптимизацию, и говорить о ней должен
   * отчёт, а не молча укоротившийся список.
   */
  getLods() {
    const info = this.left?.viewer?.getLodInfo?.()
      || { count: 0, source: null, names: [], triangles: [], current: null };
    return { ...info, selected: this._lodIndex ?? null };
  }

  /**
   * Показать уровень В ОБОИХ окнах. Переключение — состояние показа: спрятанный уровень
   * остаётся и в сцене, и в файле (Правило 11).
   */
  selectLod(index: number | 'all' | null) {
    this._lodIndex = index;
    this.left?.viewer?.setLod?.(index);
    this.right?.viewer?.setLod?.(index);
  }

  /**
   * Свет загруженной модели — для полки значков.
   *
   * Спрашиваем ЛЕВЫЙ вьюпорт по той же причине, что варианты и уровни: он показывает
   * исходник. Пропавший справа источник — находка про оптимизацию, и говорить о ней
   * должен отчёт, а не молча погасшая кнопка.
   */
  getLight() {
    const info = this.left?.viewer?.getLightInfo?.() || { count: 0, mode: 'studio' as const };
    return {
      ...info,
      // По сторонам — по той же причине, что у камер: разный свет слева и справа
      // читается как последствие оптимизации, а на деле это рассинхрон настроек показа.
      leftMode: this.left?.viewer?.getLightInfo?.().mode ?? null,
      rightMode: this.right?.viewer?.getLightInfo?.().mode ?? null,
    };
  }

  /**
   * Переключить свет В ОБОИХ окнах: разное освещение слева и справа читалось бы как
   * последствие оптимизации — та же причина, по которой экспозиция одна на двоих.
   *
   * Выбор НЕ запоминается между моделями, в отличие от клипа и варианта: у следующей
   * модели своего света может не быть вовсе, и она открылась бы почти чёрной.
   */
  selectLightMode(mode: 'studio' | 'file') {
    this._lightMode = mode;
    this.left?.viewer?.setLightMode?.(mode);
    this.right?.viewer?.setLightMode?.(mode);
  }

  /**
   * Камеры автора — для полки значков. Спрашиваем ЛЕВЫЙ вьюпорт: он показывает
   * исходник, и набор ракурсов в нём полный по определению.
   */
  getCameras() {
    const info = this.left?.viewer?.getCameraInfo?.() || { count: 0, names: [], current: null };
    return {
      ...info,
      // По сторонам — чтобы рассинхрон был ВИДИМОЙ величиной, а не ощущением «что-то не
      // то после сборки». Ровно та же причина, что у leftIndex/rightIndex в
      // getAnimation(), и ровно тот же дефект: 2026-08-15 после сборки левое окно
      // продолжало смотреть камерой автора, а правое возвращалось к своей орбите.
      leftCurrent: this.left?.viewer?.getCameraInfo?.().current ?? null,
      rightCurrent: this.right?.viewer?.getCameraInfo?.().current ?? null,
    };
  }

  /**
   * Смотреть через камеру автора В ОБОИХ окнах. Разные ракурсы слева и справа сделали
   * бы сравнение бессмысленным — та же причина, по которой связаны орбиты.
   *
   * Выбор НЕ запоминается между моделями: у следующей этого ракурса может не быть.
   */
  selectCamera(index: number | null) {
    this._cameraIndex = index;
    this.left?.viewer?.setCamera?.(index);
    this.right?.viewer?.setCamera?.(index);
  }

  setAnimationPlaying(playing: boolean) {
    this._animPlaying = !!playing;
  }

  /** Перемотка в абсолютное время (секунды). */
  seekAnimation(seconds: number) {
    this._animTime = Math.max(0, Number(seconds) || 0);
    this._advanceAnimation(0);
  }

  /** Переключить клип в обоих вьюпортах и начать с нуля. */
  selectAnimationClip(index: number) {
    // Запоминаем выбор: следующая загруженная модель должна прийти на этот же
    // клип, иначе она начнёт с нулевого и разойдётся со второй (см. _applyAnimSelection).
    this._animClipIndex = Math.max(0, Number(index) || 0);
    this.left?.viewer?.playClip?.(this._animClipIndex);
    this.right?.viewer?.playClip?.(this._animClipIndex);
    this._animTime = 0;
    this._advanceAnimation(0);
  }

  // -----------------------------------------------------------------------
  // Экспозиция
  //
  // Одна на оба вьюпорта — иначе сравнение «до и после» врёт: разная яркость
  // читается глазом как разница обработки. Пересвеченные модели встречаются
  // часто (материалы под другое окружение), и без этого регулятора они
  // выглядят испорченными ещё до всякой оптимизации.
  // -----------------------------------------------------------------------

  setExposure(value: number) {
    const v = Number(value);
    this._exposure = Number.isFinite(v) ? Math.max(0.05, Math.min(v, 4)) : 1;
    this._applyExposure();
  }

  getExposure() {
    return this._exposure ?? 1;
  }

  _applyExposure() {
    const v = this._exposure ?? 1;
    this.left?.viewer?.setExposure?.(v);
    this.right?.viewer?.setExposure?.(v);
  }

  /**
   * Материал показа — ОДИН на оба окна, по той же причине, по которой один вариант
   * материала и один уровень детализации: сравнивают тут «до» и «после», и разъехавшийся
   * показ превратил бы сравнение оптимизации в сравнение способов рисовать.
   */
  setDisplayMaterial(mode: 'file' | 'clay') {
    this._display = mode === 'clay' ? 'clay' : 'file';
    this._applyDisplayMaterial();
  }

  getDisplayMaterial() {
    return this._display || 'file';
  }

  _applyDisplayMaterial() {
    const mode = this._display || 'file';
    this.left?.viewer?.setDisplayMaterial?.(mode);
    this.right?.viewer?.setDisplayMaterial?.(mode);
  }

  /**
   * Показать глину сразу, если у модели НЕТ НИ ОДНОЙ текстуры.
   *
   * Не своеволие: у такой модели нет ни картинок, ни, как правило, цвета — экспортёр
   * оставил белый материал по умолчанию, и подменять там нечего. Белое же под ровным
   * светом читается силуэтом без формы, ради чего глина и заведена.
   *
   * Ровно одно условие и никаких догадок: есть хоть одна текстура — не трогаем. И
   * человек в любой момент возвращает родные материалы одним выбором.
   */
  _autoDisplayMaterial() {
    const viewer = this.left?.viewer;
    if (!viewer || typeof viewer.hasTextures !== 'function') return;
    this._display = viewer.hasTextures() ? 'file' : 'clay';
    this._applyDisplayMaterial();
  }

  _stopLoop() {
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** Загрузить оригинал (File) в левый вьюпорт. Правый сбрасывается — прежний
   *  оптимизированный результат больше не соответствует новой исходной модели. */
  async loadOriginal(originalFile: File | null, pack?: PackEntry[] | null) {
    if (!this._init()) return null;
    // ДРУГАЯ модель — ракурс автора и свет из файла забываем. Клип и вариант так не
    // делают намеренно (человек сравнивает модели в одном виде), а здесь наоборот:
    // «камера 5» у новой модели — совсем другая точка зрения, если она вообще есть,
    // и подсовывать её вместо своей орбиты значит решать за человека.
    //
    // Пересборка той же модели идёт через loadOptimized и сюда не попадает — там выбор
    // как раз обязан пережить сборку (см. _applyCameraSelection).
    this._cameraIndex = null;
    this._lightMode = 'studio';
    this._unlinkCameras();
    this.right!.reset();
    this.right!.showHint("viewer.hint.compare");
    let info = null;
    if (originalFile) info = await this.left!.load(originalFile, { pack: pack || null });
    // ДРУГАЯ модель — заново решаем, показывать ли глиной: у прошлой текстуры могли быть,
    // у этой нет. Сборка той же модели (loadOptimized) сюда не попадает и выбор не трогает.
    this._autoDisplayMaterial();
    this._afterLoad();
    return info; // { stats, detected } — метрики модели + что уже сжато в исходнике
  }

  /** Загрузить оптимизированную модель (URL) в правый вьюпорт.
   *  Ракурс НЕ сбрасывается: берём текущую камеру левого вьюпорта (камеры связаны, bbox
   *  тот же) и применяем к результату — приближённая деталь остаётся на месте после
   *  любой сборки/ребилда. Левый (оригинал) не трогаем. */
  async loadOptimized(optimizedUrl: string | null) {
    if (!this._init()) return;
    if (optimizedUrl) {
      const camera = this.left!.viewer ? this.left!.viewer.getCameraState() : null;
      await this.right!.load(optimizedUrl, { camera });
    } else {
      this.right!.showHint("viewer.hint.noOutput");
    }
    this._afterLoad();
  }

  _afterLoad() {
    this._resetPerf(); // сцена сменилась — прежние кадры мерили другую модель
    if (this.left!.viewer && this.right!.viewer) this._linkCameras();
    this._applyAnimSelection();
    this._applyVariantSelection();
    this._applyLodSelection();
    this._applyCameraSelection();
    this._applyLightSelection();
    this._applyExposure();
    this._applyDisplayMaterial();
    this._startLoop();
    // Состав модели изменился — панели управления надо перестроить СЕЙЧАС, а не
    // когда до них дойдёт очередь кадра. Сначала это делалось опросом в цикле
    // отрисовки, и в фоновой вкладке (где requestAnimationFrame заморожен)
    // панель анимации не появлялась вовсе.
    this._notifyLoaded();
  }

  /** Подписка UI на «модель загружена/сменилась». Один слушатель — больше не нужно. */
  setOnLoaded(fn: (() => void) | null) {
    this._onLoaded = typeof fn === 'function' ? fn : null;
  }

  /**
   * Уведомить UI. Запасной путь через глобальную функцию — не украшение:
   * app.js подключён обычным скриптом, а этот модуль — type="module", то есть
   * отложен и выполняется ПОСЛЕ него. На момент своего запуска app.js ещё не
   * видит window.OptiViewer и подписаться не может. Глобальную функцию он
   * объявляет заранее, и порядок перестаёт иметь значение.
   */
  _notifyLoaded() {
    const fn = this._onLoaded || window.onOptiViewerModelLoaded;
    if (typeof fn === 'function') fn();
  }

  /**
   * Привести только что загруженную модель к тому, что уже выбрано на панели.
   *
   * Без этого свежезагруженный вьюпорт начинал с клипа №0, а второй продолжал
   * играть выбранный пользователем. Симптом: собрал модель, смотря второй клип —
   * результат справа дёргается не в такт, и «чинится» только переключением клипа
   * (оно единственное задавало индекс обоим сразу).
   */
  /**
   * Привести только что загруженную модель к выбранному варианту материала.
   *
   * Та же причина, что у клипа анимации: без этого свежий вьюпорт показывал бы
   * основной вид, пока второй стоит на выбранном цвете, и сравнение сравнивало бы
   * окраски вместо оптимизации. `null` пропускаем — это и есть состояние по умолчанию.
   */
  /**
   * Привести только что загруженную модель к показанному уровню детализации.
   *
   * Та же причина, что у клипа и у варианта: слева исходник, справа результат, и разные
   * уровни в окнах сравнивали бы не оптимизацию, а подробность. `null` пропускаем —
   * это и есть состояние по умолчанию.
   */
  _applyLodSelection() {
    const index = this._lodIndex;
    if (index === null) return;
    this.left?.viewer?.setLod?.(index);
    this.right?.viewer?.setLod?.(index);
  }

  /**
   * Вернуть свежезагруженной модели выбранный ракурс автора.
   *
   * Дефект 2026-08-15: этого не было, а load() ракурс сбрасывает. После сборки левое
   * окно продолжало смотреть камерой автора, правое возвращалось к своей орбите — два
   * окна показывали РАЗНОЕ, и разница читалась как последствие оптимизации.
   *
   * Отказ обрабатываем честно: если камеры с таким номером в модели нет, возвращаем
   * СВОЮ орбиту в обоих окнах и забываем выбор. Молча оставить окна в разных
   * состояниях — это тот же дефект, только тише.
   */
  _applyCameraSelection() {
    const index = this._cameraIndex;
    if (index === null) return;
    const okLeft = this.left?.viewer ? this.left.viewer.setCamera(index) : true;
    const okRight = this.right?.viewer ? this.right.viewer.setCamera(index) : true;
    if (okLeft && okRight) return;
    this._cameraIndex = null;
    this.left?.viewer?.setCamera?.(null);
    this.right?.viewer?.setCamera?.(null);
  }

  /** То же для света: своего света у пересобранной модели может не оказаться. */
  _applyLightSelection() {
    if (this._lightMode !== 'file') return;
    const okLeft = this.left?.viewer ? this.left.viewer.setLightMode('file') : true;
    const okRight = this.right?.viewer ? this.right.viewer.setLightMode('file') : true;
    if (okLeft && okRight) return;
    this._lightMode = 'studio';
    this.left?.viewer?.setLightMode?.('studio');
    this.right?.viewer?.setLightMode?.('studio');
  }

  _applyVariantSelection() {
    const name = this._variantName;
    if (name === null) return;
    void Promise.all([
      this.left?.viewer?.setVariant?.(name),
      this.right?.viewer?.setVariant?.(name),
    ]);
  }

  _applyAnimSelection() {
    const idx = this._animClipIndex || 0;
    if (idx > 0) {
      this.left?.viewer?.playClip?.(idx);
      this.right?.viewer?.playClip?.(idx);
    }
    this._advanceAnimation(0);
  }

  /**
   * Заново навести камеры на модели (кнопка «сбросить ракурс»).
   *
   * Кадрируем ОДИН вьюпорт и копируем результат во второй, а не наводим каждый
   * по своей модели. Оптимизация может едва заметно менять габарит (сварка вершин,
   * удаление вырожденных треугольников), и раздельное кадрирование давало двум
   * окнам разные дистанцию, near/far и пределы приближения — то есть ровно тот
   * рассинхрон, ради отсутствия которого сравнение и делается.
   */
  resetView() {
    const source = this.left?.viewer || this.right?.viewer;
    if (!source) return;
    source.frame();
    const state = source.getCameraState();
    if (this.left?.viewer && this.left.viewer !== source) this.left.viewer.applyCameraState(state);
    if (this.right?.viewer && this.right.viewer !== source) this.right.viewer.applyCameraState(state);
  }

  /** Текущее состояние камер обоих вьюпортов (read-only): позиция + target. */
  cameraStates() {
    return {
      left: this.left && this.left.viewer ? this.left.viewer.getCameraState() : null,
      right: this.right && this.right.viewer ? this.right.viewer.getCameraState() : null,
    };
  }

  setLinked(on: boolean) {
    this.linked = !!on;
  }

  reset() {
    this._stopLoop();
    this._resetPerf();
    this._unlinkCameras();
    if (this.left) this.left.reset();
    if (this.right) this.right.reset();
    // Моделей больше нет — панель анимации обязана убраться вместе с ними.
    this._notifyLoaded();
  }
}

const dual = new DualViewport();

// Глобальный API для классического app.js.
window.OptiViewer = {
  // Какие вьюпорты приложение умеет монтировать и какой выбран. Через это поле
  // движок из engines/<id>.json дотягивается до картинки — см. VIEWERS выше.
  implementations: () => Object.keys(VIEWERS),
  useViewer: (id) => useViewer(id),
  currentViewer: () => wantedViewer,
  loadOriginal: (file, pack) => dual.loadOriginal(file, pack as PackEntry[] | null),
  // Приведение адреса соседа к общему виду. Наружу отдано НЕ для красоты: приложение
  // сверяет ссылки внутри `.gltf` с брошенными файлами, и считать ключи оно обязано тем
  // же кодом, что и подмена адресов при показе. Две копии этого правила разошлись бы на
  // первом же файле с пробелом в имени — и разошлись бы молча.
  assetKey: (p) => normalizeAssetPath(p),
  loadOptimized: (url) => dual.loadOptimized(url),
  resetView: () => dual.resetView(),
  setLinked: (on) => dual.setLinked(on),
  reset: () => dual.reset(),
  cameraStates: () => dual.cameraStates(),
  // Анимация. Одно время на оба вьюпорта — см. _advanceAnimation.
  getAnimation: () => dual.getAnimation(),
  setAnimationPlaying: (on) => dual.setAnimationPlaying(on),
  seekAnimation: (sec) => dual.seekAnimation(sec),
  selectAnimationClip: (i) => dual.selectAnimationClip(i),
  // Варианты материала — запасные цвета и отделки. Один выбор на оба вьюпорта:
  // разъехавшийся цвет превратил бы сравнение оптимизации в сравнение окрасок.
  // Уровни детализации: показ одного из них, без правки файла (Правило 11).
  getLods: () => dual.getLods(),
  selectLod: (index) => dual.selectLod(index),
  getVariants: () => dual.getVariants(),
  selectVariant: (name) => dual.selectVariant(name),
  // Свет: наш студийный или тот, что принесла сама модель. Один на оба вьюпорта.
  getLight: () => dual.getLight(),
  selectLightMode: (mode) => dual.selectLightMode(mode),
  // Камеры автора: его ракурсы вместо нашей орбиты. Тоже один выбор на оба вьюпорта.
  getCameras: () => dual.getCameras(),
  selectCamera: (index) => dual.selectCamera(index),
  // Экспозиция — одна на оба вьюпорта, см. _applyExposure.
  setExposure: (v) => dual.setExposure(v),
  // Материал показа: 'file' — как в файле, 'clay' — наша глина для безтекстурных моделей.
  setDisplayMaterial: (mode) => dual.setDisplayMaterial(mode),
  getDisplayMaterial: () => dual.getDisplayMaterial(),
  getExposure: () => dual.getExposure(),
  // Нагрузка на отрисовку: { leftMs, rightMs, fps } либо null, пока окно замера
  // не набралось. Почему не «FPS слева / FPS справа» — см. DualViewport._pushPerf.
  getPerf: () => dual.getPerf(),
  // Уведомление «модель загрузилась/сменилась/сброшена» — по нему UI перестраивает
  // панели, вместо того чтобы опрашивать состав модели каждый кадр.
  setOnLoaded: (fn) => dual.setOnLoaded(fn),
};
