#!/usr/bin/env bash
# Compile the Swift Accessibility helper to native/bin/window-helper.
# Requires Xcode command line tools (swiftc). macOS only.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/bin"

swiftc -O "$DIR/WindowHelper.swift" \
  -o "$DIR/bin/window-helper" \
  -framework Cocoa \
  -framework ApplicationServices

echo "Built $DIR/bin/window-helper"
