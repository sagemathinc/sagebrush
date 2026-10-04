#!/bin/bash
# Copy pure-Python CPython 3.14 stdlib modules into lib/, unchanged except
# for a provenance line.  Usage: bash scripts/vendor_stdlib.sh copy copyreg ...
cd "$(dirname "$0")/.."
for m in "$@"; do
  src=/usr/lib/python3.14/$m.py
  [ -f "$src" ] || { echo "no $src"; continue; }
  { echo "# Copied unchanged from CPython 3.14 Lib/$m.py (PSF License; see cdn/LICENSE-CPython.txt)."; cat "$src"; } > lib/$m.py
  echo "vendored $m"
done
