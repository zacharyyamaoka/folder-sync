#!/usr/bin/env python3
"""Draw the app icon and the tray's state icons (PNG) for the folder-sync desktop app.

Run: python3 app/scripts/make_icons.py   (needs Pillow). The PNGs are committed; this is how they were made.
icon.icns (macOS) is made from icon.png by Tauri: npx --prefix app tauri icon app/src-tauri/icons/icon.png -o <scratch>, copy icon.icns.
WHY one glyph and a small state badge: a tray icon is ~22 px, so the state must read from colour and shape at a
glance; amber and red are kept for the two states the person must act on (over quota, error), per Zach's calm-UI rule.
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
INK = (32, 36, 44, 255)
PAPER = (247, 247, 245, 255)
STATES = {
    "synced": (46, 160, 90, 255),
    "syncing": (52, 120, 220, 255),
    "offline": (140, 146, 156, 255),
    "over_quota": (226, 150, 30, 255),
    "error": (210, 60, 50, 255),
    "signed_out": None,
    "paused": (140, 146, 156, 255),
}


def folder(draw: ImageDraw.ImageDraw, size: int, fill, outline=None) -> None:
    s = size / 64
    draw.rounded_rectangle([6 * s, 12 * s, 30 * s, 24 * s], radius=3 * s, fill=fill)
    draw.rounded_rectangle([6 * s, 18 * s, 58 * s, 54 * s], radius=5 * s, fill=fill, outline=outline, width=int(max(1, 3 * s)))


def badge(draw: ImageDraw.ImageDraw, size: int, state: str) -> None:
    s = size / 64
    color = STATES[state]
    box = [36 * s, 34 * s, 62 * s, 60 * s]
    draw.ellipse([b - 2 * s if i < 2 else b + 2 * s for i, b in enumerate(box)], fill=PAPER)
    if state == "signed_out":
        draw.ellipse(box, outline=(140, 146, 156, 255), width=int(max(2, 4 * s)))
        return
    draw.ellipse(box, fill=color)
    cx, cy = 49 * s, 47 * s
    w = int(max(2, 3 * s))
    if state == "synced":
        draw.line([(42 * s, 47 * s), (47 * s, 52 * s), (56 * s, 42 * s)], fill=PAPER, width=w)
    elif state == "syncing":
        draw.arc([42 * s, 40 * s, 56 * s, 54 * s], 200, 520 - 60, fill=PAPER, width=w)
    elif state == "paused":
        draw.rectangle([44 * s, 41 * s, 47 * s, 53 * s], fill=PAPER)
        draw.rectangle([51 * s, 41 * s, 54 * s, 53 * s], fill=PAPER)
    elif state in ("over_quota", "error"):
        draw.rectangle([cx - 1.5 * s, 40 * s, cx + 1.5 * s, 49 * s], fill=PAPER)
        draw.rectangle([cx - 1.5 * s, 51 * s, cx + 1.5 * s, 54 * s], fill=PAPER)
    elif state == "offline":
        draw.line([(43 * s, 41 * s), (55 * s, 53 * s)], fill=PAPER, width=w)


def tray(state: str, size: int = 64) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    folder(d, size, (205, 210, 218, 255) if state == "signed_out" else (225, 228, 233, 255))
    badge(d, size, state)
    return img


def app_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=INK)
    inner = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    di = ImageDraw.Draw(inner)
    folder(di, size, PAPER)
    badge(di, size, "synced")
    small = inner.resize((int(size * 0.72), int(size * 0.72)), Image.LANCZOS)
    off = (size - small.width) // 2
    img.alpha_composite(small, (off, off + int(size * 0.02)))
    return img


def main() -> None:
    (HERE / "tray").mkdir(parents=True, exist_ok=True)
    for state in STATES:
        tray(state).save(HERE / "tray" / f"{state}.png")
    big = app_icon(1024)
    big.save(HERE / "icon.png")
    for px, name in [(32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png"), (512, "512x512.png")]:
        big.resize((px, px), Image.LANCZOS).save(HERE / name)
    big.resize((256, 256), Image.LANCZOS).save(HERE / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])


if __name__ == "__main__":
    main()
