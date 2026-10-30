#!/bin/bash
# sign-testkey.sh IN.apk OUT.apk: a copy of IN signed with a throwaway key made
# here, for testing only (NOT FOR DISTRIBUTION). Moved verbatim from
# app-mobile.yml's release job (#362, reviewed there); only the paths arrive as
# arguments. Its password is random, masked, in this process's environment
# only (never argv, $GITHUB_ENV, outputs or files), and the keystore is
# deleted here. Needs BT (build-tools dir), JAVA_HOME, BUILD_TOOLS_VERSION,
# RUNNER_TEMP and GITHUB_STEP_SUMMARY; used by app-mobile.yml and
# app-mobile-selftest.yml.
set -euo pipefail
APK=${1:?usage: sign-testkey.sh IN.apk OUT.apk}
signed=${2:?usage: sign-testkey.sh IN.apk OUT.apk}
: "${BT:?}" "${JAVA_HOME:?}" "${BUILD_TOOLS_VERSION:?}" "${RUNNER_TEMP:?}" "${GITHUB_STEP_SUMMARY:?}"
[ -s "$APK" ] || { echo "FAIL: no APK at $APK"; exit 1; }
[ "$(realpath -m -- "$APK")" != "$(realpath -m -- "$signed")" ] || { echo "FAIL: IN and OUT are the same file"; exit 1; }
[ ! -e "$signed" ] || { echo "FAIL: $signed already exists"; exit 1; }
umask 077
kdir=$(mktemp -d "$RUNNER_TEMP/testkey.XXXXXX")
trap 'rm -rf "$kdir"' EXIT
KS_PASS=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
echo "::add-mask::$KS_PASS"
export KS_PASS
"$JAVA_HOME/bin/keytool" -genkeypair -keystore "$kdir/test.p12" -storetype PKCS12 -alias test \
  -keyalg RSA -keysize 4096 -validity 2 -dname "CN=sagebrush CI test key (NOT FOR DISTRIBUTION), O=sagebrush CI" \
  -storepass:env KS_PASS -keypass:env KS_PASS > /dev/null
# (the new key's PUBLIC certificate, hashed before the keystore goes:
# the final APK must be signed by exactly this one certificate)
"$JAVA_HOME/bin/keytool" -exportcert -keystore "$kdir/test.p12" -storetype PKCS12 -alias test \
  -storepass:env KS_PASS -file "$kdir/test.der" > /dev/null
want=$(sha256sum "$kdir/test.der" | cut -d' ' -f1)
[ "${#want}" = 64 ] || { echo "FAIL: no certificate hash"; exit 1; }
mkdir -p "$(dirname "$signed")"
"$BT/zipalign" -P 16 -f 4 "$APK" "$kdir/aligned.apk"
"$BT/apksigner" sign --ks "$kdir/test.p12" --ks-key-alias test --ks-pass env:KS_PASS --key-pass env:KS_PASS \
  --out "$signed" "$kdir/aligned.apk"
rm -rf "$kdir"
[ ! -e "$kdir" ] || { echo "FAIL: the keystore directory is still there"; exit 1; }
unset KS_PASS
"$BT/zipalign" -c -P 16 4 "$signed" > /dev/null || { echo "FAIL: the signed APK is not aligned"; exit 1; }
"$BT/apksigner" verify --print-certs "$signed" > /tmp/certs.txt || { cat /tmp/certs.txt; echo "FAIL: apksigner verify"; exit 1; }
signers=$(grep -c '^Signer #[0-9]* certificate SHA-256 digest: ' /tmp/certs.txt) || [ $? = 1 ]
got=$(sed -n 's/^Signer #1 certificate SHA-256 digest: \([0-9a-f]\{64\}\)$/\1/p' /tmp/certs.txt)
[ "$signers" = 1 ] && [ "$got" = "$want" ] || { cat /tmp/certs.txt; echo "FAIL: expected exactly one signer, this run's test certificate $want (signers $signers, #1 '$got')"; exit 1; }
grep -q '^Signer #1 certificate DN: .*NOT FOR DISTRIBUTION' /tmp/certs.txt || { cat /tmp/certs.txt; echo "FAIL: the signer's DN is not the test key's"; exit 1; }
{
  echo "TESTKEY (made in this run, deleted; NOT FOR DISTRIBUTION): $(grep -m1 'certificate SHA-256 digest' /tmp/certs.txt)"
  echo "apksigner $("$BT/apksigner" --version), build-tools $BUILD_TOOLS_VERSION, $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"
  sha256sum "$APK" "$signed"
} | tee -a "$GITHUB_STEP_SUMMARY"
