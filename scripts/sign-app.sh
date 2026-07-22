#!/usr/bin/env bash
# Code-sign the packaged .app. Prefers the stable self-signed identity created by
# scripts/setup-signing-cert.sh (so the Accessibility grant persists across
# rebuilds); falls back to ad-hoc if that identity isn't installed.
set -euo pipefail

CERT_CN="Gesture HCI Signing"

APP="$(find release -maxdepth 2 -name '*.app' -type d | head -1)"
if [ -z "$APP" ]; then
  echo "No .app found under release/. Run: npm run pack" >&2
  exit 1
fi
HELPER="$APP/Contents/Resources/window-helper"

if security find-identity -p codesigning 2>/dev/null | grep -q "$CERT_CN"; then
  SIGN=(--sign "$CERT_CN")
  echo "Signing with stable identity: $CERT_CN"
else
  SIGN=(--sign -)
  echo "Signing ad-hoc (Accessibility grant will reset each rebuild)."
  echo "  → Run 'npm run setup:signing' once for a grant that persists."
fi

# Sign the bundled helper FIRST (it's a sealed resource of the app), then the
# app itself so the outer seal covers the signed helper.
[ -f "$HELPER" ] && { chmod +x "$HELPER"; codesign --force "${SIGN[@]}" "$HELPER"; }
codesign --force --deep "${SIGN[@]}" "$APP"

echo
echo "Verifying…"
codesign --verify --verbose=2 "$APP" && echo "OK — signature valid."
echo
echo "Designated requirement (what TCC pins the Accessibility grant to):"
codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => /  /p'
echo
echo "Launch it:  open \"$APP\""
