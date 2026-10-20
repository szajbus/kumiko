"""Builds the Kumiko asanoha icon pack: SVG masters, PNGs, .icns, .ico, preview."""
import io
import os
import shutil
import sys

import cairosvg
from PIL import Image

OUT = sys.argv[1]
TILE = "#0B0D10"
WOOD = "#D9B98C"

HEX = "50,10 84.64,30 84.64,70 50,90 15.36,70 15.36,30"
SPOKES = "M50 50L50 10M50 50L84.64 30M50 50L84.64 70M50 50L50 90M50 50L15.36 70M50 50L15.36 30"
LEAVES = (
    "M61.55 30L50 50M61.55 30L50 10M61.55 30L84.64 30"
    "M73.09 50L50 50M73.09 50L84.64 30M73.09 50L84.64 70"
    "M61.55 70L50 50M61.55 70L84.64 70M61.55 70L50 90"
    "M38.45 70L50 50M38.45 70L50 90M38.45 70L15.36 70"
    "M26.91 50L50 50M26.91 50L15.36 70M26.91 50L15.36 30"
    "M38.45 30L50 50M38.45 30L15.36 30M38.45 30L50 10"
)

# Stroke weights in the 100-unit drawing: regular for 48 px and up, heavy for small sizes.
WEIGHTS = {"regular": (3.2, 1.8, 1.4), "small": (6.0, 3.6, 3.0)}


def pattern(color, weight):
    outer, spoke, leaf = WEIGHTS[weight]
    return (
        f'<polygon points="{HEX}" fill="none" stroke="{color}" stroke-width="{outer}" stroke-linejoin="round"/>'
        f'<path d="{SPOKES}" fill="none" stroke="{color}" stroke-width="{spoke}" stroke-linecap="round"/>'
        f'<path d="{LEAVES}" fill="none" stroke="{color}" stroke-width="{leaf}" stroke-linecap="round"/>'
    )


def full_tile(weight):
    """Full-bleed rounded tile: Windows, Linux, favicons, in-app use."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
        f'<rect width="1024" height="1024" rx="225" fill="{TILE}"/>'
        f'<g transform="scale(10.24)">{pattern(WOOD, weight)}</g></svg>'
    )


def macos(weight):
    """macOS grid: 824 px body centred on a 1024 canvas, transparent margin."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
        f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{TILE}"/>'
        f'<g transform="translate(100 100) scale(8.24)">{pattern(WOOD, weight)}</g></svg>'
    )


def mark():
    """Tile-less mark in currentColor, for the app header and anywhere text colour applies."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 8 76 84" fill="none" '
        'stroke="currentColor" role="img" aria-label="Kumiko">'
        + pattern("currentColor", "regular").replace(' stroke="currentColor"', "")
        + "</svg>"
    )


def png(svg, size):
    data = cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size)
    return Image.open(io.BytesIO(data)).convert("RGBA")


def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(f"{OUT}/png")
    os.makedirs(f"{OUT}/macos")

    svgs = {
        "icon.svg": full_tile("regular"),
        "icon-small.svg": full_tile("small"),
        "macos/icon-macos.svg": macos("regular"),
        "logo-mark.svg": mark(),
    }
    for name, svg in svgs.items():
        with open(f"{OUT}/{name}", "w") as f:
            f.write(svg + "\n")

    def full(size):
        return png(full_tile("small" if size <= 32 else "regular"), size)

    def mac(size):
        return png(macos("small" if size <= 32 else "regular"), size)

    for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
        full(size).save(f"{OUT}/png/{size}x{size}.png")

    ico_sizes = (16, 24, 32, 48, 64, 128, 256)
    ico_imgs = [full(s) for s in ico_sizes]
    ico_imgs[-1].save(f"{OUT}/icon.ico", sizes=[(s, s) for s in ico_sizes], append_images=ico_imgs[:-1])

    icns_sizes = (16, 32, 64, 128, 256, 512, 1024)
    icns_imgs = [mac(s) for s in icns_sizes]
    icns_imgs[-1].save(f"{OUT}/macos/icon.icns", append_images=icns_imgs[:-1])
    mac(1024).save(f"{OUT}/macos/icon-macos-1024.png")

    # Preview sheet: every PNG size on dark and on light.
    sizes = (16, 24, 32, 48, 64, 128, 256)
    pad, gap = 32, 24
    width = pad * 2 + sum(sizes) + gap * (len(sizes) - 1)
    row = max(sizes) + pad * 2
    sheet = Image.new("RGBA", (width, row * 2), "#0F1115")
    light = Image.new("RGBA", (width, row), "#F4F5F7")
    sheet.paste(light, (0, row))
    for band, y0 in ((0, 0), (1, row)):
        x = pad
        for s in sizes:
            img = Image.open(f"{OUT}/png/{s}x{s}.png")
            sheet.alpha_composite(img, (x, y0 + pad + (max(sizes) - s) // 2))
            x += s + gap
    sheet.save(f"{OUT}/preview.png")


main()
