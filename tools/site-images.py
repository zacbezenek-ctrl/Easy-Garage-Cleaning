#!/usr/bin/env python3
"""Build the small public-site image derivatives from the committed originals.

Run after replacing a source image: python3 tools/site-images.py (needs Pillow with WebP).
The derivatives are committed; the site build (_generate_site.py) never runs this, so
page builds stay dependency-free. tests/public-performance.test.mjs checks the results:
header/footer logos at most 30 KB, and srcset widths that match the real files.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "images"
BRAND = IMAGES / "brand"

# 368px = 2x the 184px header lockup (styles.css .logo); the footer lockup reuses it. It is the 1x
# image-set choice (with the PNG fallback); high-density screens get a WebP about 3x the widest box
# the logo is drawn in on a phone: the 181px header (543px) and the 235px footer lockup (705px).
LOGO_WIDTH = 368
LOGOS = {"egc-logo-horizontal-primary": 552, "egc-logo-horizontal-white": 704}
# Mobile hero cells are about half the phone width; 600px covers them at 3x.
HERO_WIDTH = 600
HEROES = ("garage-before", "garage-after")
# /before-after card thumbnails, named like the gallery's other -768 thumbnails.
CARD_WIDTH = 768


def resized(source, width):
    image = Image.open(source)
    image.load()
    height = round(image.height * width / image.width)
    return image.resize((width, height), Image.Resampling.LANCZOS)


def build_logos():
    for name, hidpi in LOGOS.items():
        resized(BRAND / f"{name}.png", hidpi).convert("RGBA").save(BRAND / f"{name}-{hidpi}.webp", format="WEBP", quality=90, method=6)
        logo = resized(BRAND / f"{name}.png", LOGO_WIDTH).convert("RGBA")
        logo.save(BRAND / f"{name}-{LOGO_WIDTH}.webp", format="WEBP", quality=90, method=6)
        # PNG fallback for browsers without image-set WebP support: 256-colour palette with alpha.
        logo.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(
            BRAND / f"{name}-{LOGO_WIDTH}.png", format="PNG", optimize=True)


def build_heroes():
    for name in HEROES:
        for width in (HERO_WIDTH, CARD_WIDTH):
            resized(IMAGES / f"{name}.webp", width).convert("RGB").save(
                IMAGES / f"{name}-{width}.webp", format="WEBP", quality=80, method=6)


def main():
    build_logos()
    build_heroes()
    for path in sorted([*BRAND.glob("egc-logo-horizontal-*-[0-9]*.*"), *IMAGES.glob("garage-*-[0-9]*.webp")]):
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
