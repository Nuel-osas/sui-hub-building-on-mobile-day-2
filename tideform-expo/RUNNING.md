# Running the Tideform Expo app

Verified working on macOS — the app **bundles cleanly for web, Android, and iOS**
(1000+ modules, all 6 routes) and the dev server serves on `:8081`.

## TL;DR

```bash
cd tideform-expo
cp .env.example .env          # mainnet IDs + tidalform Google client are pre-filled
npm install                   # also pulls expo-asset, react-dom, react-native-web, @expo/metro-runtime
npm start                     # → QR code; scan with Expo Go (iOS or Android)
```

`npm start` runs [`start.sh`](start.sh), which handles the Node-version gotcha for you.

## Run it on Android

1. Install **Expo Go** from the Play Store on your Android phone.
2. Put the phone on the **same Wi-Fi** as this Mac.
3. `npm start` → scan the QR with Expo Go (or open `exp://<your-mac-LAN-ip>:8081` manually).
4. Different network? Use `npm run tunnel` (installs ngrok once, works anywhere).

Emulator instead of a phone: `npm run android` (needs Android Studio + an AVD running).

## The Node-version gotcha (why `start.sh` exists)

Expo SDK 54's CLI does **not** boot under today's Node LTS lines (20.19+, 22.18+, 23, 25).
Recent Node enables `require(esm)` + TypeScript type-stripping by default, which pre-empts
Expo's own `.ts` transpile hook and then errors on packages whose `main` is a `.ts` file
(`expo-modules-core/src/index.ts`):

```
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING   (Node 22.18+/23/25)
ERR_UNKNOWN_FILE_EXTENSION ".ts"              (with stripping disabled)
```

Two things fix it, both baked into `start.sh`:

1. **Prefer a Node 20/22 keg** if Homebrew has one (`brew install node@20`).
2. **Disable `require(esm)`**: `NODE_OPTIONS=--no-experimental-require-module` so Expo's
   transpile hook handles the `.ts` entry points.

If you run `expo` directly (not via `npm start`), set both yourself:

```bash
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
export NODE_OPTIONS="--no-experimental-require-module"
npx expo start
```

## What "it runs" was proven with

```bash
npx expo export --platform web      # ✅ 1015 modules, routes: / /login /f/[id] /inbox/[id]
npx expo export --platform android  # ✅ 1377 modules, 5.35 MB Hermes bundle
```

## Notes

- **Auth on a phone:** Google sign-in is wired to tidalform's **web** OAuth client. On SDK 54
  the web client signs in from a **browser** (`npm run web`) out of the box. For native
  Google sign-in on a real Android/iOS device you need a platform OAuth client (Android/iOS)
  in the same Google Cloud project — see the repo `README` and `lib/auth.ts`.
- **Reads work everywhere with no setup:** "My forms" / form view / inbox query Sui + Walrus
  directly, so you can see live on-chain data immediately.
- A few SDK-version-sensitive calls are marked `// VERIFY` in `lib/seal.ts` and `lib/auth.ts`.
