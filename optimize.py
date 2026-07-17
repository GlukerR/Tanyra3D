# -*- coding: utf-8 -*-
"""
glb_web_optimize — оптимизация GLB для веба без потери качества модели.

Кладёшь .glb в input/ → получаешь оптимизированные в output/.

Что делает (по порядку):
  1. dedup    — удаляет дубликаты текстур/аксессуаров
  2. prune    — удаляет неиспользуемые узлы и материалы
  3. flatten  — упрощает иерархию сцены
  4. weld     — сваривает только идентичные вершины (форма не меняется)
  5. join     — объединяет меши → меньше draw calls (отключается флагом)
  6. reorder  — переупорядочивает вершины под кэш GPU
  7. png      — текстуры → PNG (промежуточно, без потерь: toktx не читает WebP)
  8. uastc    — текстуры → KTX2/UASTC (нужен toktx, иначе шаги 7-8 пропускаются)
  9. геометрия → Meshopt (по умолчанию) или Draco

Чего НЕ делает принципиально:
  - НЕ упрощает меш (никакого simplify — полигоны не удаляются)
  - НЕ меняет разрешение текстур (никакого texture-resize)

Запуск:
  python optimize.py              → сжатие Meshopt (рекомендуется для веба)
  python optimize.py draco        → сжатие Draco (минимальный вес файла)
  python optimize.py --keep-parts → не объединять меши (взрыв-схемы/кликабельные детали)
  python optimize.py --no-ktx     → не трогать текстуры вообще
  Флаги можно совмещать: python optimize.py draco --keep-parts
"""

import os
import shutil
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_DIR = os.path.join(BASE_DIR, "input")
OUTPUT_DIR = os.path.join(BASE_DIR, "output")

# ---------- разбор аргументов ----------
args = [a.lower() for a in sys.argv[1:]]
CODEC = "draco" if "draco" in args else "meshopt"
KEEP_PARTS = "--keep-parts" in args
NO_KTX = "--no-ktx" in args

# ---------- поиск инструментов ----------
def find_gltf_transform():
    for name in ("gltf-transform", "gltf-transform.cmd"):
        p = shutil.which(name)
        if p:
            return p
    return None

def find_toktx():
    p = shutil.which("toktx")
    if p:
        return p
    candidates = [
        r"C:\Program Files\KTX-Software\bin\toktx.exe",
        r"C:\Program Files (x86)\KTX-Software\bin\toktx.exe",
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None

GLTF = find_gltf_transform()
if not GLTF:
    print("[ОШИБКА] gltf-transform не найден.")
    print("  Установи: npm install --global @gltf-transform/cli")
    print("  (или запусти install.bat из этой папки)")
    sys.exit(1)

TOKTX = None if NO_KTX else find_toktx()
env = os.environ.copy()
if TOKTX:
    toktx_dir = os.path.dirname(TOKTX)
    if toktx_dir not in env.get("PATH", ""):
        env["PATH"] = toktx_dir + os.pathsep + env.get("PATH", "")
elif not NO_KTX:
    print("[ВНИМАНИЕ] toktx (KTX-Software) не найден — шаг KTX2-текстур будет пропущен.")
    print("  Текстуры останутся как есть. Для установки запусти install_ktx.bat")
    print()

# ---------- пайплайн ----------
def run_step(cmd_args, src, dst):
    """Один шаг gltf-transform. Возвращает True при успехе."""
    cmd = [GLTF] + cmd_args[:1] + [src, dst] + cmd_args[1:]
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        print(f"    [ОШИБКА на шаге {cmd_args[0]}]")
        err = (result.stderr or result.stdout or "").strip()
        if err:
            print("    " + "\n    ".join(err.splitlines()[-5:]))
        return False
    if not os.path.exists(dst):
        print(f"    [ОШИБКА] шаг {cmd_args[0]} завершился без ошибки, но файл не создан")
        return False
    return True

def build_steps():
    steps = [
        (["dedup"], "dedup — дубликаты данных"),
        (["prune"], "prune — неиспользуемое"),
        (["flatten"], "flatten — иерархия"),
        (["weld"], "weld — сварка вершин"),
    ]
    if not KEEP_PARTS:
        steps.append((["join"], "join — объединение мешей"))
    steps.append((["reorder"], "reorder — кэш GPU"))
    if TOKTX:
        # toktx не читает WebP (частый формат экспорта из Blender) —
        # сначала декодируем текстуры в PNG без потерь, потом кодируем в KTX2
        steps.append((["png"], "png — декод текстур для toktx"))
        # UASTC: качество-приоритет, без RDO (RDO вносит потери), zstd поверх для веса
        steps.append((["uastc", "--level", "2", "--zstd", "18"], "uastc — текстуры → KTX2"))
    if CODEC == "draco":
        steps.append((["draco"], "draco — сжатие геометрии"))
    else:
        steps.append((["meshopt"], "meshopt — сжатие геометрии"))
    return steps

def mb(path):
    return os.path.getsize(path) / (1024 * 1024)

def process(filename):
    src = os.path.join(INPUT_DIR, filename)
    dst = os.path.join(OUTPUT_DIR, filename)
    if os.path.exists(dst):
        print(f"[ПРОПУСК] {filename} — уже есть в output/")
        return None

    size_before = mb(src)
    base = os.path.splitext(filename)[0]
    tmp_a = os.path.join(OUTPUT_DIR, f"_tmp_{base}_a.glb")
    tmp_b = os.path.join(OUTPUT_DIR, f"_tmp_{base}_b.glb")

    current = src
    steps = build_steps()
    print(f"[РАБОТА] {filename} ({size_before:.2f} МБ), шагов: {len(steps)}")
    try:
        for i, (cmd_args, label) in enumerate(steps):
            last = (i == len(steps) - 1)
            # последний шаг пишет СРАЗУ в итоговый файл — без переименований
            # (rename на этой папке ненадёжен из-за слоя синхронизации)
            if last:
                target = dst
            else:
                target = tmp_a if current != tmp_a else tmp_b
            print(f"    {i+1}/{len(steps)} {label}")
            if not run_step(cmd_args, current, target):
                print(f"[ОШИБКА] {filename} — пайплайн остановлен, файл не сохранён")
                return False
            current = target
        size_after = mb(dst)
        pct = (1 - size_after / size_before) * 100 if size_before else 0
        print(f"[ГОТОВО] {filename}: {size_before:.2f} МБ → {size_after:.2f} МБ (−{pct:.0f}%)")
        return True
    finally:
        for t in (tmp_a, tmp_b):
            if os.path.exists(t):
                try:
                    os.remove(t)
                except OSError:
                    pass

def main():
    os.makedirs(INPUT_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    files = sorted(f for f in os.listdir(INPUT_DIR) if f.lower().endswith(".glb"))
    if not files:
        print(f"В папке input/ нет .glb файлов. Положи модели сюда:\n  {INPUT_DIR}")
        return

    print(f"Кодек геометрии: {CODEC}" + (" | без join" if KEEP_PARTS else "") + (" | без KTX2" if not TOKTX else ""))
    print(f"Файлов к обработке: {len(files)}\n")

    ok = skipped = failed = 0
    for f in files:
        result = process(f)
        if result is True:
            ok += 1
        elif result is None:
            skipped += 1
        else:
            failed += 1
        print()

    print(f"Итог: готово {ok}, пропущено {skipped}, ошибок {failed}")
    if failed:
        print("Файлы с ошибками остались в input/ нетронутыми — можно разбираться.")

if __name__ == "__main__":
    main()
