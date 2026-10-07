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
set -e
src=${1:-$HOME/scratch/cup}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=$root/web/site/public/demo/jfm
mkdir -p "$out"
cp "$here/index.html" "$here/U.jpg" "$here/D.jpg" "$out/"
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
ls -la "$out"
