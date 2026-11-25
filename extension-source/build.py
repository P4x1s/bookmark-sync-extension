#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「一个插件包兼容多个浏览器」的构建产物。

单一 manifest.json（MV3）同时声明：
  - background.service_worker  -> Chrome / Edge / Opera 等 Chromium 系
  - background.scripts         -> Firefox（MV3 事件页）/ Safari
Chrome 121+ 会忽略 MV3 manifest 中的 background.scripts，Firefox 使用 scripts，
因此同一目录、同一 zip 可直接用于多个浏览器。

用法：
  python build.py

产物：
  dist/universal/
  bookmark-sync-universal.zip
"""
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
TARGET = DIST / "universal"
ZIP_PATH = ROOT / "bookmark-sync-universal.zip"

# 旧版按浏览器拆包的产物，构建时清理，避免混淆。
LEGACY_DIRS = [DIST / "chrome", DIST / "edge", DIST / "firefox"]
LEGACY_ZIPS = [
    ROOT / "bookmark-sync-chrome-mv3.zip",
    ROOT / "bookmark-sync-edge-mv3.zip",
    ROOT / "bookmark-sync-firefox-mv2.zip",
]


def copy_sources(target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    for item in SRC.rglob("*"):
        if not item.is_file():
            continue
        if item.name == "manifest.base.json":
            continue  # 模板不进入交付包，包内只保留生成的 manifest.json
        rel = item.relative_to(SRC)
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, dest)


def zip_dir(src: Path, out: Path) -> None:
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in sorted(src.rglob("*")):
            if item.is_file():
                zf.write(item, item.relative_to(src).as_posix())


def cleanup_legacy() -> None:
    for d in LEGACY_DIRS:
        if d.exists():
            shutil.rmtree(d)
    for z in LEGACY_ZIPS:
        if z.exists():
            z.unlink()


def main() -> None:
    manifest = json.loads((SRC / "manifest.base.json").read_text(encoding="utf-8"))
    assert manifest["manifest_version"] == 3, "统一包必须使用 Manifest V3"
    assert "service_worker" in manifest["background"], "缺少 Chromium 后台声明"
    assert "scripts" in manifest["background"], "缺少 Firefox 后台声明"

    DIST.mkdir(parents=True, exist_ok=True)
    cleanup_legacy()

    copy_sources(TARGET)
    (TARGET / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    zip_dir(TARGET, ZIP_PATH)
    print(f"[OK] {TARGET.relative_to(ROOT)} -> {ZIP_PATH.name}")


if __name__ == "__main__":
    main()
