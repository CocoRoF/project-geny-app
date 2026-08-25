#!/usr/bin/env python3
"""Generate the app and tray icons.

Drawn in code rather than checked in as opaque binaries: the mark is simple
enough that this file IS the definition, and any size regenerates exactly.
Run with `python3 scripts/make-icons.py` after changing it.

The mark is a 'G' cut from a rounded tile in the app's accent violet. It has
to survive being 16px in a system tray, so: two shapes, high contrast, no
gradient or bevel that would turn to mud when downscaled.
"""
from PIL import Image, ImageDraw

ACCENT = (124, 92, 255, 255)      # --accent, matching the UI
TRAY = (163, 143, 255, 255)       # lighter: tray panels are usually dark
LIGHT = (240, 243, 250, 255)


def draw_g(d, S, colour, *, pad_ratio=0.22, width_ratio=0.135):
    pad = S * pad_ratio
    width = int(S * width_ratio)
    d.arc([pad, pad, S - pad, S - pad], start=38, end=322, fill=colour, width=width)
    cx, cy = S / 2, S / 2
    # the crossbar stops short of the ring's outer edge so the terminal reads
    d.rectangle([cx - S * 0.01, cy - width / 2, S - pad - width * 0.15, cy + width / 2],
                fill=colour)


def icon(size: int, *, tile: bool = True) -> Image.Image:
    # supersample: PIL has no anti-aliased primitives, so draw big and shrink
    S = size * 8
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if tile:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=ACCENT)
        draw_g(d, S, LIGHT)
    else:
        # tray: the tile becomes mud at 16px, so the mark stands alone and a
        # touch heavier so it holds up against any panel colour
        draw_g(d, S, TRAY, pad_ratio=0.14, width_ratio=0.17)
    return img.resize((size, size), Image.LANCZOS)


# Linux wants a real set, not one huge file: a panel asking for 24px should
# get art drawn at 24px, not a 1024px image downscaled at paint time. Given a
# single PNG electron-builder ships exactly that one size, so `linux.icon`
# points at this directory instead.
LINUX_SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)

if __name__ == '__main__':
    import os

    icon(1024).save('build/icon.png')            # mac/win derive from this
    os.makedirs('build/icons', exist_ok=True)
    for size in LINUX_SIZES:
        icon(size).save(f'build/icons/{size}x{size}.png')
    icon(32, tile=False).save('build/tray.png')  # Electron picks @2x by name
    icon(64, tile=False).save('build/tray@2x.png')
    print('build/icon.png, build/icons/{%s}, build/tray.png' %
          ','.join(f'{s}x{s}' for s in LINUX_SIZES))
