#!/bin/bash
# ci-verify-debs.sh DIR: keep only the .debs in DIR that apt can safely reuse; delete every other entry (#191).
#   scripts/ci-verify-debs.sh --self-test
#
# Why: the webkit job restores WebKit's apt .debs from the Actions cache into the directory apt uses
# as its archive cache, and apt takes an archive already there on its SIZE alone (pkgAcqArchive, apt
# 2.7.14: an existing file of the expected size is marked complete without a hash; astra, #191 r1).
# apt finds that archive by its FILENAME, so the content and the name are both bound here (astra, r2):
# a file is kept only if it is a regular file (not a symlink), its control fields Package, Version and
# Architecture give an SHA256 in the signed Packages index (apt-cache show, after apt-get update,
# selected by Architecture) equal to the file's own, and its name is apt's canonical archive name for
# exactly those fields (package_version_arch.deb, with apt's QuoteString escaping: "%", ":" and "_",
# and "." in the architecture, as %xx, lowercase; so an epoch "2:" is "2%3a").  Everything else, a
# mismatch, a genuine package under another package's name, an unlisted package, a subdirectory, is
# deleted, and apt downloads what it needs again.  SB_DEBS_INDEX=FILE (lines "package arch version
# sha256") replaces apt-cache: the self-test's index.
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

quote() { # STRING BAD: apt's QuoteString: each byte in BAD, "%", or outside 0x21..0x7e as %xx
  local s=$1 bad=$2 out="" c i
  local LC_ALL=C
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    if [[ "$bad%" == *"$c"* ]] || [[ "$c" < "!" ]] || [[ "$c" > "~" ]]; then
      out+=$(printf '%%%02x' "'$c")
    else
      out+=$c
    fi
  done
  printf '%s' "$out"
}

canonical() { # package version arch: the archive's name in apt's cache
  printf '%s_%s_%s.deb' "$(quote "$1" '_:')" "$(quote "$2" '_:')" "$(quote "$3" '_:.')"
}

verify() { # DIR: prints "kept N, deleted M"
  local dir=$1 kept=0 deleted=0 f p a v sum why
  shopt -s dotglob nullglob
  for f in "$dir"/*; do
    why=""
    if [ -L "$f" ] || [ ! -f "$f" ]; then
      why="not a regular file"
    else
      p=$(dpkg-deb -f "$f" Package 2>/dev/null) || p=""
      a=$(dpkg-deb -f "$f" Architecture 2>/dev/null) || a=""
      v=$(dpkg-deb -f "$f" Version 2>/dev/null) || v=""
      sum=$(sha256sum "$f" | cut -d' ' -f1)
      if [ -z "$p" ] || [ -z "$a" ] || [ -z "$v" ]; then
        why="no Package, Version and Architecture"
      elif ! expected "$p" "$a" "$v" | grep -qx "$sum"; then
        why="not the index's SHA256 for $p $v $a"
      elif [ "${f##*/}" != "$(canonical "$p" "$v" "$a")" ]; then
        why="named other than $(canonical "$p" "$v" "$a")"
      fi
    fi
    if [ -z "$why" ]; then
      kept=$((kept + 1))
    else
      echo "deleted ($why): ${f##*/}"
      rm -rf -- "$f"
      deleted=$((deleted + 1))
    fi
  done
  echo "kept $kept, deleted $deleted"
}

self_test() {
  local t ok=0
  t=$(mktemp -d)
  trap 'rm -rf "$t"' RETURN
  mkdir -p "$t/debs"
  build() { # package version: a .deb with 4096 B of random data, at $t/package.deb, indexed
    rm -rf "$t/pkg" && mkdir -p "$t/pkg/DEBIAN" "$t/pkg/usr/share/sb"
    printf 'Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: ci <ci@localhost>\nDescription: ci-verify-debs self-test\n' "$1" "$2" > "$t/pkg/DEBIAN/control"
    head -c 4096 /dev/urandom > "$t/pkg/usr/share/sb/data"
    dpkg-deb --root-owner-group -Znone --build "$t/pkg" "$t/$1.deb" > /dev/null
    echo "$1 all $2 $(sha256sum "$t/$1.deb" | cut -d' ' -f1)" >> "$t/index"
  }
  build sb-selftest 1.0-1
  build sb-epoch 2:1.0-1
  build sb-corrupt 1.0-1
  build sb-aa 1.0-1
  build sb-bb 1.0-1
  [ "$(stat -c %s "$t/sb-aa.deb")" = "$(stat -c %s "$t/sb-bb.deb")" ] || { echo "self-test: sb-aa and sb-bb differ in size"; return 1; }
  # kept: indexed, at their canonical names (the epoch's ":" as %3a)
  cp "$t/sb-selftest.deb" "$t/debs/sb-selftest_1.0-1_all.deb"
  cp "$t/sb-epoch.deb" "$t/debs/sb-epoch_2%3a1.0-1_all.deb"
  # deleted: the same size with one byte changed near the end (in the data, after the control member)
  cp "$t/sb-corrupt.deb" "$t/debs/sb-corrupt_1.0-1_all.deb"
  local n b; n=$(stat -c %s "$t/sb-corrupt.deb")
  b=$(dd if="$t/sb-corrupt.deb" bs=1 skip=$((n - 100)) count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
  printf "\\$(printf '%03o' $(((b + 1) % 256)))" | dd of="$t/debs/sb-corrupt_1.0-1_all.deb" bs=1 seek=$((n - 100)) conv=notrunc 2> /dev/null
  [ "$(stat -c %s "$t/debs/sb-corrupt_1.0-1_all.deb")" = "$n" ] || { echo "self-test: the corrupt copy changed size"; return 1; }
  # deleted: genuine, indexed sb-aa under sb-bb's canonical name (the same size: apt would take it as sb-bb)
  cp "$t/sb-aa.deb" "$t/debs/sb-bb_1.0-1_all.deb"
  # deleted: genuine, indexed, under a non-canonical name; and the epoch's ":" left unescaped
  cp "$t/sb-selftest.deb" "$t/debs/renamed.deb"
  cp "$t/sb-epoch.deb" "$t/debs/sb-epoch_2:1.0-1_all.deb"
  # deleted: an unlisted well-formed package, a file that isn't a .deb, a symlink, a subdirectory
  sed -i 's/^Package: sb-bb$/Package: sb-unlisted/' "$t/pkg/DEBIAN/control"
  dpkg-deb --root-owner-group -Znone --build "$t/pkg" "$t/debs/sb-unlisted_1.0-1_all.deb" > /dev/null
  head -c 100 /dev/urandom > "$t/debs/garbage.deb"
  ln -s "$t/sb-aa.deb" "$t/debs/sb-aa_1.0-1_all.deb"
  mkdir -p "$t/debs/partial" && cp "$t/sb-aa.deb" "$t/debs/partial/sb-aa_1.0-1_all.deb"
  SB_DEBS_INDEX="$t/index" verify "$t/debs" > "$t/out"
  check() { if eval "$1"; then ok=$((ok + 1)); else echo "self-test FAILED: $2"; cat "$t/out"; return 1; fi; }
  check '[ -f "$t/debs/sb-selftest_1.0-1_all.deb" ]' "an indexed .deb at its canonical name is kept"
  check '[ -f "$t/debs/sb-epoch_2%3a1.0-1_all.deb" ]' "an epoch's canonical name (2%3a) is kept"
  check '[ ! -e "$t/debs/sb-corrupt_1.0-1_all.deb" ]' "a same-size corrupted .deb is deleted"
  check '[ ! -e "$t/debs/sb-bb_1.0-1_all.deb" ]' "a genuine indexed .deb under another package's name is deleted"
  check '[ ! -e "$t/debs/renamed.deb" ]' "a genuine indexed .deb under a non-canonical name is deleted"
  check '[ ! -e "$t/debs/sb-epoch_2:1.0-1_all.deb" ]' "an epoch left unescaped is deleted"
  check '[ ! -e "$t/debs/sb-unlisted_1.0-1_all.deb" ]' "a .deb the index doesn't list is deleted"
  check '[ ! -e "$t/debs/garbage.deb" ]' "a file that isn't a .deb is deleted"
  check '[ ! -L "$t/debs/sb-aa_1.0-1_all.deb" ] && [ ! -e "$t/debs/sb-aa_1.0-1_all.deb" ]' "a symlink is deleted"
  check '[ ! -e "$t/debs/partial" ]' "a subdirectory is deleted"
  check 'grep -qx "kept 2, deleted 8" "$t/out"' "the summary"
  echo "ci-verify-debs self-test: ok ($ok checks)"
}

case "${1:-}" in
  --self-test) self_test ;;
  "") echo "usage: $0 DIR | --self-test" >&2; exit 2 ;;
  *) verify "$1" ;;
esac
