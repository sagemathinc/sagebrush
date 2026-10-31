#!/usr/bin/env python3
# Every raster icon of Sagebrush from the two drawings here (logo F, "Desert
# path", picked by William Oct 30; the redraw and the 16 px tab mark OK'd by
# him Oct 31):
#   sagebrush-logo.svg  the logo: rust square, cream path between two mesas, sage leaf
#   sagebrush-mark.svg  the tab mark: leaf and path only, no mesas (16 px)
# Each drawing is rasterized ONCE at 2048 px (ImageMagick, which renders these
# filled paths exactly: no strokes, no text), then every size is a Lanczos
# reduction of that master.  Each output keeps the pixel mode the file had
# (RGB stays RGB: the App Store's 1024 px icon must have no alpha), except
# that the web's icons, which browsers download, are reduced to a 128-colour
# palette (no dithering; visually the same, about a third of the bytes).  The tab
# mark is not a raster: --data-uri prints it as the data: URI the pages use.
#   python3 -I design/logo/build-icons.py            (from the repository root)
#   python3 -I design/logo/build-icons.py --data-uri
import io, os, subprocess, sys, tempfile, urllib.parse
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
LOGO, MARK = os.path.join(HERE, "sagebrush-logo.svg"), os.path.join(HERE, "sagebrush-mark.svg")
RUST = (0xAE, 0x47, 0x2A)


def data_uri(svg_path):
    svg = open(svg_path).read().strip()
    return "data:image/svg+xml," + urllib.parse.quote(svg, safe=" /=:.,-'")


def master(svg_path, px=2048):
    with tempfile.TemporaryDirectory() as t:
        out = os.path.join(t, "m.png")
        # (the drawing is 100 user units wide, at 72 dpi by default)
        subprocess.run(["magick", "-background", "none", "-density", str(72 * px / 100),
                        svg_path, "-resize", f"{px}x{px}!", out], check=True)
        im = Image.open(out); im.load()
    return im.convert("RGBA")


def sized(im, n):
    return im.resize((n, n), Image.LANCZOS)


def save(im, rel, mode=None):
    path = os.path.join(ROOT, rel)
    if mode == "P":  # (a palette PNG, for the web; no transparency)
        im.convert("RGB").quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)
        return rel
    if mode is None:  # the mode the committed file has
        mode = "RGBA" if Image.open(path).mode in ("RGBA", "LA", "P") else "RGB"
    im = im.convert(mode)
    if mode == "RGB":
        assert im.mode == "RGB"
    im.save(path, optimize=True)
    return rel


def main():
    if sys.argv[1:] == ["--data-uri"]:
        print(data_uri(MARK)); return
    assert sys.argv[1:] == [], "usage: build-icons.py [--data-uri]"
    logo = master(LOGO)
    out = []
    # desktop (tauri.conf.json bundle.icon, Windows Store tiles)
    T = "app/src-tauri/icons/"
    for name, n in [("32x32", 32), ("64x64", 64), ("128x128", 128), ("128x128@2x", 256), ("icon", 512),
                    ("Square30x30Logo", 30), ("Square44x44Logo", 44), ("Square71x71Logo", 71),
                    ("Square89x89Logo", 89), ("Square107x107Logo", 107), ("Square142x142Logo", 142),
                    ("Square150x150Logo", 150), ("Square284x284Logo", 284), ("Square310x310Logo", 310),
                    ("StoreLogo", 50)]:
        out.append(save(sized(logo, n), f"{T}{name}.png"))
    ico = sized(logo, 256)
    ico.save(os.path.join(ROOT, T + "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)])
    out.append(T + "icon.ico")
    big = sized(logo, 1024)
    big.save(os.path.join(ROOT, T + "icon.icns"), append_images=[sized(logo, n) for n in (16, 32, 64, 128, 256, 512)])
    out.append(T + "icon.icns")
    # iOS (Contents.json sizes; RGB, no alpha)
    A = "app/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/"
    for name, n in [("AppIcon-20x20@1x", 20), ("AppIcon-20x20@2x", 40), ("AppIcon-20x20@2x-1", 40),
                    ("AppIcon-20x20@3x", 60), ("AppIcon-29x29@1x", 29), ("AppIcon-29x29@2x", 58),
                    ("AppIcon-29x29@2x-1", 58), ("AppIcon-29x29@3x", 87), ("AppIcon-40x40@1x", 40),
                    ("AppIcon-40x40@2x", 80), ("AppIcon-40x40@2x-1", 80), ("AppIcon-40x40@3x", 120),
                    ("AppIcon-60x60@2x", 120), ("AppIcon-60x60@3x", 180), ("AppIcon-76x76@1x", 76),
                    ("AppIcon-76x76@2x", 152), ("AppIcon-83.5x83.5@2x", 167), ("AppIcon-512@2x", 1024)]:
        out.append(save(sized(logo, n), f"{A}{name}.png", "RGB"))
    # Android (no adaptive-icon XML: the launcher uses ic_launcher / _round;
    # the foreground keeps tauri's layout, the logo inside the 66/108 safe zone)
    R = "app/src-tauri/gen/android/app/src/main/res/mipmap-"
    for d, n, fg in [("mdpi", 48, 108), ("hdpi", 49, 162), ("xhdpi", 96, 216), ("xxhdpi", 144, 324), ("xxxhdpi", 192, 432)]:
        out.append(save(sized(logo, n), f"{R}{d}/ic_launcher.png"))
        mask = Image.new("L", (n * 4, n * 4), 0); ImageDraw.Draw(mask).ellipse((0, 0, n * 4 - 1, n * 4 - 1), fill=255)
        rnd = sized(logo, n); rnd.putalpha(mask.resize((n, n), Image.LANCZOS))
        out.append(save(rnd, f"{R}{d}/ic_launcher_round.png"))
        f = Image.new("RGBA", (fg, fg), (0, 0, 0, 0)); s = round(fg * 66 / 108)
        f.paste(sized(logo, s), ((fg - s) // 2, (fg - s) // 2))
        out.append(save(f, f"{R}{d}/ic_launcher_foreground.png"))
    # web (manifest icons; apple-touch-icon; maskable: the drawing inside the
    # central 80% safe circle, on the full rust square)
    W = "web/icons/"
    for name, n in [("apple-touch-icon", 180), ("icon-192", 192), ("icon-512", 512)]:
        out.append(save(sized(logo, n), f"{W}{name}.png", "P"))
    for n in (192, 512):
        m = Image.new("RGB", (n, n), RUST); s = round(n * 0.8)
        m.paste(sized(logo, s).convert("RGB"), ((n - s) // 2, (n - s) // 2))
        out.append(save(m, f"{W}maskable-{n}.png", "P"))
    for rel in out:
        print(f"{os.path.getsize(os.path.join(ROOT, rel)):>7} {rel}")


main()
