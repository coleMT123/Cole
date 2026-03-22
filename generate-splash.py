#!/usr/bin/env python3
"""
Generate iOS splash screens and apple-touch-icons for all iPhone sizes.
Uses icon-512.png as the source icon.

Run:
  pip3 install Pillow
  python3 generate-splash.py
"""

from PIL import Image
import os

BG_COLOR = (15, 15, 15)   # matches #0f0f0f background

# All required iOS splash screen sizes (portrait, @2x/@3x physical pixels)
SPLASH_SIZES = [
    (750,  1334, "splash-750x1334.png"),    # iPhone SE / iPhone 8
    (1242, 2208, "splash-1242x2208.png"),   # iPhone 8 Plus
    (1125, 2436, "splash-1125x2436.png"),   # iPhone X / XS / 11 Pro
    (828,  1792, "splash-828x1792.png"),    # iPhone XR / 11
    (1242, 2688, "splash-1242x2688.png"),   # iPhone XS Max / 11 Pro Max
    (1080, 2340, "splash-1080x2340.png"),   # iPhone 12 mini / 13 mini
    (1170, 2532, "splash-1170x2532.png"),   # iPhone 12 / 12 Pro / 13 / 13 Pro / 14
    (1284, 2778, "splash-1284x2778.png"),   # iPhone 12 Pro Max / 13 Pro Max / 14 Plus
    (1179, 2556, "splash-1179x2556.png"),   # iPhone 14 Pro / 15 / 15 Pro / 16
    (1290, 2796, "splash-1290x2796.png"),   # iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus
    (1206, 2622, "splash-1206x2622.png"),   # iPhone 16 Pro
    (1320, 2868, "splash-1320x2868.png"),   # iPhone 16 Pro Max
]

# Apple touch icon sizes needed
ICON_SIZES = [
    (180, "apple-touch-icon-180.png"),
    (152, "apple-touch-icon-152.png"),
    (120, "apple-touch-icon-120.png"),
]

def generate():
    src = Image.open("icon-512.png").convert("RGBA")

    # Generate apple-touch-icons
    print("Generating apple-touch-icons...")
    for size, name in ICON_SIZES:
        bg = Image.new("RGB", (size, size), BG_COLOR)
        icon = src.resize((size, size), Image.LANCZOS)
        bg.paste(icon, (0, 0), icon)
        bg.save(name, "PNG", optimize=True)
        print(f"  ✓ {name}")

    # Generate splash screens
    print("\nGenerating splash screens...")
    for w, h, name in SPLASH_SIZES:
        # Dark background
        img = Image.new("RGB", (w, h), BG_COLOR)

        # Center icon at ~22% of smaller dimension
        icon_px = int(min(w, h) * 0.22)
        icon_px = max(icon_px, 80)
        icon_resized = src.resize((icon_px, icon_px), Image.LANCZOS)

        # Place icon slightly above center (like native iOS splash)
        x = (w - icon_px) // 2
        y = (h - icon_px) // 2 - int(h * 0.04)
        img.paste(icon_resized, (x, y), icon_resized)

        img.save(name, "PNG", optimize=True)
        print(f"  ✓ {name}")

    print("\n✅ Done! All images generated.")
    print("Now run: firebase deploy")

if __name__ == "__main__":
    generate()
