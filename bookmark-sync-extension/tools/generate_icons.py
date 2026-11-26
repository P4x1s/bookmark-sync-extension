#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Bookmark Sync 的统一图标资源。

设计语义：云 + 上下双向箭头（与原弹窗图标一致，表示云端/仓库双向同步）。
输出：
  - src/icons/icon.svg          可随系统深浅色变化的主 SVG
  - src/icons/brand-mark.svg    弹窗内使用的纯图形标记
  - src/icons/icon-<size>.png   默认工具栏/管理页图标
  - src/icons/icon-on-light-*.png  浅色工具栏（深色文字）适配
  - src/icons/icon-on-dark-*.png   深色工具栏（浅色文字）适配

PNG 使用标准库纯 Python 渲染 + 超采样抗锯齿，不依赖 Pillow/Cairo。
用法：python tools/generate_icons.py
"""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "src" / "icons"
BASE = 64.0
SIZES = (16, 24, 32, 48, 64, 128)
THEME_SIZES = (16, 32)

VARIANTS = {
    "default": {
        "tile_a": "#5B9CFF", "tile_b": "#7B6CFF",
        "cloud": "#FFFFFF", "arrow": "#35489B",
        "border": "#FFFFFF", "border_alpha": 0.18,
    },
    # 用于 theme_icons 的 "dark" 槽：深色文字/浅色工具栏。
    "on_light": {
        "tile_a": "#3546A8", "tile_b": "#5A4DC6",
        "cloud": "#FFFFFF", "arrow": "#2C3F8F",
        "border": "#FFFFFF", "border_alpha": 0.14,
    },
    # 用于 theme_icons 的 "light" 槽：浅色文字/深色工具栏。
    "on_dark": {
        "tile_a": "#EAF0FF", "tile_b": "#D9E1FF",
        "cloud": "#35489B", "arrow": "#FFFFFF",
        "border": "#26357A", "border_alpha": 0.12,
    },
}


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def sd_round_rect(px: float, py: float, cx: float, cy: float,
                  half_w: float, half_h: float, radius: float) -> float:
    qx = abs(px - cx) - (half_w - radius)
    qy = abs(py - cy) - (half_h - radius)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - radius


def sd_circle(px: float, py: float, cx: float, cy: float, radius: float) -> float:
    return math.hypot(px - cx, py - cy) - radius


def segment_distance(px: float, py: float, ax: float, ay: float,
                     bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    t = clamp(((px - ax) * dx + (py - ay) * dy) / length_sq, 0.0, 1.0)
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def triangle_sign(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    return (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1])


def in_triangle(px: float, py: float, a: tuple[float, float],
                b: tuple[float, float], c: tuple[float, float]) -> bool:
    p = (px, py)
    d1 = triangle_sign(p, a, b)
    d2 = triangle_sign(p, b, c)
    d3 = triangle_sign(p, c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


CLOUD_PARTS = (
    ("circle", 25.0, 29.0, 10.5),
    ("circle", 37.0, 27.0, 12.0),
    ("circle", 44.0, 34.0, 8.5),
    ("rect", 33.0, 38.0, 15.5, 7.0, 7.0),
)

ARROW_UP_LINE = (27.0, 38.0, 27.0, 25.0)
ARROW_UP_HEAD = ((27.0, 20.0), (22.0, 27.0), (32.0, 27.0))
ARROW_DOWN_LINE = (38.0, 25.0, 38.0, 38.0)
ARROW_DOWN_HEAD = ((38.0, 43.0), (33.0, 36.0), (43.0, 36.0))
ARROW_HALF_WIDTH = 2.5


def cloud_distance(px: float, py: float) -> float:
    distance = float("inf")
    for part in CLOUD_PARTS:
        if part[0] == "circle":
            _, cx, cy, radius = part
            distance = min(distance, sd_circle(px, py, cx, cy, radius))
        else:
            _, cx, cy, half_w, half_h, radius = part
            distance = min(distance, sd_round_rect(px, py, cx, cy, half_w, half_h, radius))
    return distance


def arrow_hit(px: float, py: float) -> bool:
    if segment_distance(px, py, *ARROW_UP_LINE) <= ARROW_HALF_WIDTH:
        return True
    if segment_distance(px, py, *ARROW_DOWN_LINE) <= ARROW_HALF_WIDTH:
        return True
    if in_triangle(px, py, *ARROW_UP_HEAD):
        return True
    if in_triangle(px, py, *ARROW_DOWN_HEAD):
        return True
    return False


def blend(base: tuple[int, int, int], overlay: tuple[int, int, int], alpha: float) -> tuple[int, int, int]:
    return mix(base, overlay, clamp(alpha, 0.0, 1.0))


def sample_color(px: float, py: float, variant: dict) -> tuple[int, int, int, int]:
    tile_distance = sd_round_rect(px, py, 32.0, 32.0, 28.0, 28.0, 15.0)
    if tile_distance > 0.0:
        return (0, 0, 0, 0)

    gradient_t = clamp((px + py - 8.0) / (BASE * 2.0 - 16.0), 0.0, 1.0)
    color = mix(hex_rgb(variant["tile_a"]), hex_rgb(variant["tile_b"]), gradient_t)

    if tile_distance > -1.2:
        edge_alpha = variant["border_alpha"] * clamp((tile_distance + 1.2) / 1.2, 0.0, 1.0)
        color = blend(color, hex_rgb(variant["border"]), edge_alpha)

    if cloud_distance(px, py) <= 0.0:
        color = hex_rgb(variant["cloud"])
    if arrow_hit(px, py):
        color = hex_rgb(variant["arrow"])

    return (color[0], color[1], color[2], 255)


def render_rgba(size: int, variant: dict) -> list[bytes]:
    supersample = 4 if size <= 64 else 3
    sample_count = supersample * supersample
    rows: list[bytes] = []

    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(supersample):
                py = ((y + (sy + 0.5) / supersample) / size) * BASE
                for sx in range(supersample):
                    px = ((x + (sx + 0.5) / supersample) / size) * BASE
                    r, g, b, a = sample_color(px, py, variant)
                    alpha = a / 255.0
                    acc_r += r * alpha
                    acc_g += g * alpha
                    acc_b += b * alpha
                    acc_a += alpha
            alpha = acc_a / sample_count
            if alpha <= 0.0:
                row.extend((0, 0, 0, 0))
            else:
                row.extend((
                    round(acc_r / acc_a),
                    round(acc_g / acc_a),
                    round(acc_b / acc_a),
                    round(alpha * 255),
                ))
        rows.append(bytes(row))
    return rows


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path: Path, size: int, rows: list[bytes]) -> None:
    raw = b"".join(b"\x00" + row for row in rows)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    data = (b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) +
            png_chunk(b"IDAT", zlib.compress(raw, 9)) + png_chunk(b"IEND", b""))
    path.write_bytes(data)


def svg_defs() -> str:
    return """  <defs>
    <linearGradient id="iconGradient" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5B9CFF"/>
      <stop offset="100%" stop-color="#7B6CFF"/>
    </linearGradient>
    <linearGradient id="iconGradientDark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#8CBEFF"/>
      <stop offset="100%" stop-color="#8D80FF"/>
    </linearGradient>
  </defs>"""


def svg_cloud(variant: dict) -> str:
    cloud = variant["cloud"]
    return f"""  <g fill="{cloud}">
    <circle cx="25" cy="29" r="10.5"/>
    <circle cx="37" cy="27" r="12"/>
    <circle cx="44" cy="34" r="8.5"/>
    <rect x="17.5" y="31" width="31" height="14" rx="7"/>
  </g>"""


def svg_arrows(variant: dict) -> str:
    arrow = variant["arrow"]
    return f"""  <g fill="{arrow}" stroke="{arrow}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M27 38V25" fill="none"/>
    <path d="M27 20l-5 7h10z" stroke="none"/>
    <path d="M38 25v13" fill="none"/>
    <path d="M38 43l-5-7h10z" stroke="none"/>
  </g>"""


def write_master_svg(path: Path) -> None:
    variant = VARIANTS["default"]
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Bookmark Sync">
{svg_defs()}
  <style>
    .tile {{ fill: url(#iconGradient); }}
    @media (prefers-color-scheme: dark) {{
      .tile {{ fill: url(#iconGradientDark); }}
    }}
  </style>
  <rect class="tile" x="4" y="4" width="56" height="56" rx="15"/>
  <rect x="4.5" y="4.5" width="55" height="55" rx="14.5" fill="none"
        stroke="{variant['border']}" stroke-opacity="{variant['border_alpha']}" stroke-width="1"/>
{svg_cloud(variant)}
{svg_arrows(variant)}
</svg>
"""
    path.write_text(svg, encoding="utf-8")


def write_brand_svg(path: Path) -> None:
    variant = VARIANTS["default"]
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Sync">
{svg_cloud(variant)}
{svg_arrows(variant)}
</svg>
"""
    path.write_text(svg, encoding="utf-8")


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)

    for size in SIZES:
        write_png(ICON_DIR / f"icon-{size}.png", size, render_rgba(size, VARIANTS["default"]))
    for size in THEME_SIZES:
        write_png(ICON_DIR / f"icon-on-light-{size}.png", size, render_rgba(size, VARIANTS["on_light"]))
        write_png(ICON_DIR / f"icon-on-dark-{size}.png", size, render_rgba(size, VARIANTS["on_dark"]))

    write_master_svg(ICON_DIR / "icon.svg")
    write_brand_svg(ICON_DIR / "brand-mark.svg")

    print(f"[OK] generated {len(SIZES) + 2 * len(THEME_SIZES)} PNG icons and 2 SVG sources in {ICON_DIR.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
