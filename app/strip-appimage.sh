#!/bin/sh
# Remove GTK's TIFF image loader, and so libtiff and libjbig (GPL-2+), from
# the AppImage that tauri builds: the app never loads TIFF images, and
# JBIG-KIT's license is not one the desktop app takes on (the systematic
# review's DIST-F1, SR-0158; William's decision, Oct 10 2026).  Fails if
# anything left in the image still needs either library.
#   sh app/strip-appimage.sh app/src-tauri/target/release/bundle/appimage/X.AppImage
set -eu
img=$(realpath "$1")
work=$(mktemp -d)
cd "$work"
"$img" --appimage-extract >/dev/null
root=squashfs-root
find "$root" -name 'libpixbufloader-tiff.so' -print -delete
find "$root" \( -name 'libtiff.so*' -o -name 'libjbig.so*' \) -print -delete
rm -rf "$root"/usr/share/doc/libtiff* "$root"/usr/share/doc/libjbig*
# the loaders cache: drop the TIFF loader's block (a quoted path line, then
# its description lines, up to a blank line)
find "$root" -name loaders.cache | while read -r c; do
  python3 - "$c" <<'EOF'
import sys
path = sys.argv[1]
blocks = open(path).read().split("\n\n")
kept = [b for b in blocks if "libpixbufloader-tiff.so" not in b]
open(path, "w").write("\n\n".join(kept))
print(path, len(blocks) - len(kept), "block(s) removed")
EOF
done
# nothing may still need them
left=$(find "$root" -type f -exec sh -c 'readelf -d "$1" 2>/dev/null | grep -E "NEEDED.*\[(libtiff|libjbig)" >/dev/null && echo "$1"' _ {} \; || true)
if [ -n "$left" ]; then
  echo "still needed by: $left" >&2
  exit 1
fi
if find "$root" -name 'libjbig*' -o -name 'libtiff*' | grep -q .; then
  echo "libtiff or libjbig still present" >&2
  exit 1
fi
tool=${APPIMAGETOOL:-appimagetool}
ARCH=x86_64 "$tool" --no-appstream "$root" "$img"
echo "stripped: $img"
