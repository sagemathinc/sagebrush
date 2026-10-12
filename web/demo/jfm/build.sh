#!/bin/sh
# The JFM Notebooks demo (sagebrush.space/demo/jfm): the page, the published
# notebooks and data, and 3D views made by running the notebooks with
# Sagebrush.  Run after `bun web/build.ts` and `npm run build`:
#
#   sh web/demo/jfm/build.sh [directory with the published files]
#
# The directory (default ~/scratch/cup) has U-vortices-plot.ipynb,
# U-vortices_data.mat and D-vortices-data.mat.  The D notebook is the U one
# with its own data file and color range, as published.
#
# Also the notebooks of "Introducing JFM Notebooks" (Meneveau & Caulfield,
# J. Fluid Mech. 952, E1, 2022; CC BY 4.0): its supplementary material
# (S002211202200903Xsup001.zip from the article's page), unzipped in the
# second directory (default ~/scratch/jfm-intro).  A file over the host's
# 25 MiB limit (figure 3's data.npy) is served in parts with a manifest the
# page joins (file=...parts.json).
set -e
src=${1:-$HOME/scratch/cup}
intro=${2:-$HOME/scratch/jfm-intro}/S002211202200903Xsup001
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=$root/web/site/public/demo/jfm
mkdir -p "$out"
cp "$here/index.html" "$here/U.jpg" "$here/D.jpg" "$here/fig1.jpg" "$here/fig3.jpg" "$here/fig4.jpg" "$out/"
for n in 1 3 4; do
  d="$out/intro/figure-$n"
  mkdir -p "$d"
  for f in "$intro"/*Figure-$n/*; do
    case "$f" in *Figure4.html|*.py) continue ;; esac
    size=$(stat -c %s "$f")
    if [ "$size" -gt 24000000 ]; then
      b=$(basename "$f")
      split -b 20000000 -d -a 1 "$f" "$d/$b."
      parts=$(cd "$d" && ls "$b".[0-9] | sed 's/.*/"&"/' | paste -sd, -)
      printf '{"name": "%s", "size": %s, "parts": [%s]}\n' "$b" "$size" "$parts" > "$d/$b.parts.json"
    else
      cp "$f" "$d/"
    fi
  done
done
cp "$src/U-vortices-plot.ipynb" "$src/U-vortices_data.mat" "$src/D-vortices-data.mat" "$out/"
sed -e 's/U-vortices_data\.mat/D-vortices-data.mat/' -e 's/U-vortices\.html/D-vortices.html/' \
    -e 's/color_range=\[-50, 50\]/color_range=[-100, 100]/' "$src/U-vortices-plot.ipynb" > "$out/D-vortices-plot.ipynb"
# run the notebooks' code (in a scratch directory) for the standalone 3D views
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for n in U D; do
  cp "$out/$n-vortices-plot.ipynb" "$tmp/"
  python3 -c "
import json, sys
nb = json.load(open(sys.argv[1]))
print('\n'.join(''.join(c['source']) for c in nb['cells'] if c['cell_type'] == 'code'))" "$tmp/$n-vortices-plot.ipynb" > "$tmp/$n.py"
done
cp "$out"/*.mat "$tmp/"
(cd "$tmp" && for n in U D; do node "$root/dist/src/cli.js" "$n.py" > /dev/null; done)
cp "$tmp/U-vortices.html" "$tmp/D-vortices.html" "$out/"
# the pages' Content-Security-Policy (the 3D views' inline scripts by hash)
bun "$root/web/csp.ts"
ls -la "$out"
