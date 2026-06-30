#!/usr/bin/env bash
# Tideform Expo — one-command dev server (handles the Node-version gotcha).
#
# Expo SDK 52's CLI can't boot under the current Node LTS lines (20.19+, 22.18+, 23+, 25+)
# because Node now does `require(esm)` + TypeScript type-stripping, which pre-empts Expo's
# own .ts transpile hook and chokes on packages whose `main` is a .ts file
# (e.g. expo-modules-core). Two things fix it, both applied here:
#   1. Prefer a Node 20/22 keg (Homebrew) if present.
#   2. Disable require(esm) with --no-experimental-require-module so Expo's hook handles .ts.
#
# Usage:
#   ./start.sh                # LAN dev server + QR (scan with Expo Go on iOS/Android)
#   ./start.sh --tunnel       # works across networks (needs internet; installs ngrok once)
#   ./start.sh --android      # open on a connected Android emulator/device
#   ./start.sh --ios          # open on the iOS simulator
#   ./start.sh --web          # open in a browser (http://localhost:8081)

set -euo pipefail
cd "$(dirname "$0")"

# Prefer a Homebrew Node 20 or 22 keg if the active node is too new.
for keg in node@20 node@22; do
  if [ -x "/opt/homebrew/opt/$keg/bin/node" ]; then
    export PATH="/opt/homebrew/opt/$keg/bin:$PATH"
    break
  fi
done

export NODE_OPTIONS="--no-experimental-require-module"
export EXPO_NO_TELEMETRY=1

echo "Using node $(node --version)"
exec npx expo start "$@"
