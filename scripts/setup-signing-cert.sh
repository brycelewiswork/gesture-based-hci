#!/usr/bin/env bash
# One-time: create a stable self-signed code-signing certificate in the login
# keychain. Signing with a fixed identity (instead of ad-hoc) makes macOS pin
# the Accessibility grant to the CERTIFICATE, not the binary hash — so the grant
# survives every future rebuild. (Same technique yabai/skhd use.)
set -euo pipefail

CERT_CN="Gesture HCI Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning 2>/dev/null | grep -q "$CERT_CN"; then
  echo "✓ Signing identity \"$CERT_CN\" already exists — nothing to do."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Config file form works on macOS's LibreSSL (which lacks `req -addext`).
cat > "$TMP/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $CERT_CN
[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

echo "Generating self-signed code-signing certificate \"$CERT_CN\"…"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/openssl.cnf"

# OpenSSL 3 defaults to AES/SHA-256 PKCS#12, which Apple's `security` importer
# can't read — force legacy (SHA1/3DES) algorithms. LibreSSL already defaults to
# legacy and doesn't accept the flag, so add it only for OpenSSL 3+.
P12_ARGS=()
if openssl version | grep -qiE "^OpenSSL [3-9]"; then P12_ARGS+=(-legacy); fi
openssl pkcs12 -export "${P12_ARGS[@]}" -out "$TMP/cert.p12" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -passout pass:ghci

# Import key+cert and grant codesign access to the private key.
security import "$TMP/cert.p12" -k "$KEYCHAIN" -P ghci -T /usr/bin/codesign

echo
echo "✓ Created \"$CERT_CN\" in your login keychain."
echo
echo "Next:"
echo "  1. Run: npm run build:app   (it now signs with this identity)"
echo "  2. The first build may pop a keychain prompt — click \"Always Allow\"."
echo "  3. Grant Accessibility to the app ONE more time (the identity changed)."
echo "     After that, it persists across every rebuild — no more re-granting."
