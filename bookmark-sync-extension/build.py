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
  dist/extension/
  bookmark-sync-extension.zip
"""
import json
import shutil
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
TARGET = DIST / "extension"
ZIP_PATH = ROOT / "bookmark-sync-extension.zip"

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


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as fh:
        header = fh.read(24)
    assert header[:8] == b"\x89PNG\r\n\x1a\n", f"不是 PNG 文件：{path.name}"
    return struct.unpack(">II", header[16:24])


def validate_icons(manifest: dict) -> None:
    """确保清单引用的图标齐全，且声明尺寸与 PNG 实际尺寸一致。"""
    refs = list(manifest.get("icons", {}).values())
    refs += list(manifest["action"].get("default_icon", {}).values())
    for item in manifest["action"].get("theme_icons", []):
        refs += [item["light"], item["dark"]]
    assert refs, "manifest 未声明任何图标"

    for rel in set(refs):
        path = SRC / rel
        assert path.is_file(), f"缺少图标文件：{rel}"

    for section in (manifest.get("icons", {}), manifest["action"].get("default_icon", {})):
        for size_text, rel in section.items():
            expected = int(size_text)
            assert png_size(SRC / rel) == (expected, expected), f"图标尺寸不符：{rel} 应为 {size_text}x{size_text}"

    for item in manifest["action"].get("theme_icons", []):
        expected = (item["size"], item["size"])
        assert png_size(SRC / item["light"]) == expected
        assert png_size(SRC / item["dark"]) == expected


def main() -> None:
    manifest = json.loads((SRC / "manifest.base.json").read_text(encoding="utf-8"))
    assert manifest["manifest_version"] == 3, "统一包必须使用 Manifest V3"
    assert "service_worker" in manifest["background"], "缺少 Chromium 后台声明"
    assert "scripts" in manifest["background"], "缺少 Firefox 后台声明"
    validate_icons(manifest)

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
