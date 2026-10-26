#!/bin/bash
# ci-verify-debs.sh DIR: keep only the .debs in DIR whose SHA256 is the one the authenticated apt index
# gives for that package, architecture and version; delete every other file there (#191).
#   scripts/ci-verify-debs.sh --self-test
#
# Why: the webkit job restores WebKit's apt .debs from the Actions cache into the directory apt uses
# as its archive cache, and apt takes an archive already there on its SIZE alone (pkgAcqArchive, apt
# 2.7.14: an existing file of the expected size is marked complete without a hash; astra, #191 r1).
# So a restored .deb is checked here first, against the SHA256 in the signed Packages index (apt-cache
# show, after apt-get update, selected by Architecture); one that fails, or that the index doesn't list, is deleted, and apt
# downloads it again.  SB_DEBS_INDEX=FILE (lines "package arch version sha256") replaces apt-cache:
# the self-test's index.
set -euo pipefail

expected() { # package arch version: the index's SHA256(s) for it, one per line
  if [ -n "${SB_DEBS_INDEX:-}" ]; then
    awk -v p="$1" -v a="$2" -v v="$3" '$1 == p && $2 == a && $3 == v { print $4 }' "$SB_DEBS_INDEX"
  else
    apt-cache show "$1=$3" 2>/dev/null | awk -v a="$2" '
      /^Architecture: / { arch = $2 } /^SHA256: / { sha = $2 }
      /^$/ { if (arch == a && sha != "") print sha; arch = ""; sha = "" }
      END { if (arch == a && sha != "") print sha }'
  fi
}

verify() { # DIR: prints "kept N, deleted M"
  local dir=$1 kept=0 deleted=0 f p a v sum
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    p=$(dpkg-deb -f "$f" Package 2>/dev/null) || p=""
    a=$(dpkg-deb -f "$f" Architecture 2>/dev/null) || a=""
    v=$(dpkg-deb -f "$f" Version 2>/dev/null) || v=""
    sum=$(sha256sum "$f" | cut -d' ' -f1)
    if [ -n "$p" ] && [ -n "$a" ] && [ -n "$v" ] && expected "$p" "$a" "$v" | grep -qx "$sum"; then
      kept=$((kept + 1))
    else
      echo "deleted (not the index's SHA256 for ${p:-?} ${a:-?} ${v:-?}): ${f##*/}"
      rm -f -- "$f"
      deleted=$((deleted + 1))
    fi
  done
  echo "kept $kept, deleted $deleted"
}

self_test() {
  local t ok=0
  t=$(mktemp -d)
  trap 'rm -rf "$t"' RETURN
  mkdir -p "$t/pkg/DEBIAN" "$t/pkg/usr/share/sb" "$t/debs"
  printf 'Package: sb-selftest\nVersion: 1.0-1\nArchitecture: all\nMaintainer: ci <ci@localhost>\nDescription: ci-verify-debs self-test\n' > "$t/pkg/DEBIAN/control"
  head -c 4096 /dev/urandom > "$t/pkg/usr/share/sb/data"
  dpkg-deb --root-owner-group -Znone --build "$t/pkg" "$t/good.deb" > /dev/null
  echo "sb-selftest all 1.0-1 $(sha256sum "$t/good.deb" | cut -d' ' -f1)" > "$t/index"
  cp "$t/good.deb" "$t/debs/good.deb"
  # the same size, one byte changed near the end (in the data, after the control member)
  cp "$t/good.deb" "$t/debs/same-size-corrupt.deb"
  local n; n=$(stat -c %s "$t/good.deb")
  local b; b=$(dd if="$t/good.deb" bs=1 skip=$((n - 100)) count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
  printf "\\$(printf '%03o' $(((b + 1) % 256)))" | dd of="$t/debs/same-size-corrupt.deb" bs=1 seek=$((n - 100)) conv=notrunc 2> /dev/null
  [ "$(stat -c %s "$t/debs/same-size-corrupt.deb")" = "$n" ] || { echo "self-test: the corrupt copy changed size"; return 1; }
  # a well-formed package the index doesn't list, and a file that isn't a .deb at all
  sed -i 's/^Package: sb-selftest$/Package: sb-unlisted/' "$t/pkg/DEBIAN/control"
  dpkg-deb --root-owner-group -Znone --build "$t/pkg" "$t/debs/unlisted.deb" > /dev/null
  head -c 100 /dev/urandom > "$t/debs/garbage.deb"
  SB_DEBS_INDEX="$t/index" verify "$t/debs" > "$t/out"
  check() { if eval "$1"; then ok=$((ok + 1)); else echo "self-test FAILED: $2"; cat "$t/out"; return 1; fi; }
  check '[ -f "$t/debs/good.deb" ]' "the index's .deb is kept"
  check '[ ! -e "$t/debs/same-size-corrupt.deb" ]' "a same-size corrupted .deb is deleted"
  check '[ ! -e "$t/debs/unlisted.deb" ]' "a .deb the index doesn't list is deleted"
  check '[ ! -e "$t/debs/garbage.deb" ]' "a file that isn't a .deb is deleted"
  check 'grep -qx "kept 1, deleted 3" "$t/out"' "the summary"
  echo "ci-verify-debs self-test: ok ($ok checks)"
}

case "${1:-}" in
  --self-test) self_test ;;
  "") echo "usage: $0 DIR | --self-test" >&2; exit 2 ;;
  *) verify "$1" ;;
esac
