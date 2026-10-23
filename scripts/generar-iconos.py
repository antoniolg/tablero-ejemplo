#!/usr/bin/env python3
"""Draws the board's app icons (public/icon-512.png and public/apple-touch-icon.png).

Same design as public/favicon.svg, but full-bleed: macOS and iOS round the corners
themselves. Standard library only; run it again after changing the design.
"""
import struct
import zlib
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent.parent / "public"
BACKGROUND = (30, 30, 30)
# Kanban columns on favicon.svg's 32-unit grid (centred here): x, y, width, height, opacity.
BARS = [(6.5, 8, 5, 16, 1.0), (13.5, 8, 5, 11, 0.7), (20.5, 8, 5, 7, 0.45)]
RADIUS = 2
SAMPLES = 4  # per axis, for smooth corners


def inside(x, y, left, top, width, height, radius):
    if x < left or x > left + width or y < top or y > top + height:
        return False
    cx = min(max(x, left + radius), left + width - radius)
    cy = min(max(y, top + radius), top + height - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def render(size):
    unit = size / 32
    bars = [(x * unit, y * unit, w * unit, h * unit, RADIUS * unit, a) for x, y, w, h, a in BARS]
    offsets = [(i + 0.5) / SAMPLES for i in range(SAMPLES)]
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter: none
        for px in range(size):
            color = BACKGROUND
            for left, top, width, height, radius, alpha in bars:
                if px + 1 < left or px > left + width or py + 1 < top or py > top + height:
                    continue
                hits = sum(inside(px + ox, py + oy, left, top, width, height, radius) for ox in offsets for oy in offsets)
                if hits:
                    cover = alpha * hits / SAMPLES**2
                    color = tuple(round(c + (255 - c) * cover) for c in color)
            row += bytes(color)
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


for name, size in (("icon-512.png", 512), ("apple-touch-icon.png", 180)):
    (PUBLIC / name).write_bytes(render(size))
    print(f"public/{name} ({size}×{size})")
