# ScreenFlow

Cast your screen from one PC to another. Works on **macOS** and **Windows** from a single Electron codebase.

Two connection modes:

| Mode | When | What you need |
|------|------|---------------|
| **Same WiFi / network** | Both PCs on the same LAN | Nothing — works with **zero internet**. The sharing PC runs a built-in signaling server. |
| **Over the internet** | PCs on different networks | A reachable signaling server (included, ~1 file, deploy anywhere) + a shared room code. |

Video streams **peer-to-peer via WebRTC** in both modes — the signaling server only exchanges tiny connection messages, never screen data. Screen traffic never leaves your LAN in WiFi mode.

## Run in development

```bash
npm install
npm start
```

> macOS will ask for **Screen Recording** permission the first time you share — grant it in System Settings → Privacy & Security → Screen Recording, then restart the app.
> Windows/macOS may also ask to allow **incoming network connections** (firewall prompt) — required for LAN mode.

## How to use

### Same WiFi (no internet)

1. **Sharing PC:** Share my screen → pick screen → *Same WiFi / network*. It shows an address like `192.168.1.20:45455`.
2. **Viewing PC:** View a screen → *Same WiFi* → enter that address → Connect.

### Over the internet

Both devices pick **Over the internet** and use the same 6-digit code — no URLs for users. The app talks to `DEFAULT_SIGNAL_SERVER` in `renderer/renderer.js` (currently `wss://screenflow.nextforms.in/ws`).

The production server (`server/server.js`, port 45455) serves both the auth API (`/api/*`) and the signaling WebSocket (`/ws`) on one port. Deployed on the VPS behind nginx + Cloudflare at `screenflow.nextforms.in`; website at the domain root. NAT traversal uses Google's public STUN; add a TURN server (coturn) later if needed for strict NATs.

Website: `website/` is a static landing page — served by nginx on the VPS; download links point at GitHub Releases assets (`releases/latest/download/ScreenFlow-*`).

### Accounts (auth)

Sign up = name + username + Gmail → OTP email via **Resend** → verify → signed in. Sign in = email **or** username + password. Server keeps users in `server/data/users.json` (scrypt-hashed passwords), sessions in memory. Secrets in `.env` (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`) — never shipped in the app.

## Building installers for your website

```bash
npm run dist:mac   # → dist/ScreenFlow-1.0.0-*.dmg
npm run dist:win   # → dist/ScreenFlow Setup 1.0.0.exe   (run on Windows)
```

electron-builder can only produce a Windows `.exe` on Windows (or with Wine) and a signed/notarized `.dmg` on macOS, so the included GitHub Actions workflow (`.github/workflows/build.yml`) builds **both** and uploads them as artifacts — push a tag like `v1.0.0` or run it manually, then download the dmg/exe and upload to your site.

### Signing notes

- **macOS:** unsigned dmg → users must right-click → Open the first time (Gatekeeper). For a smooth download, sign with an Apple Developer ID cert (`CSC_LINK`/`CSC_KEY_PASSWORD` secrets in CI) and notarize.
- **Windows:** unsigned exe → SmartScreen warning ("Windows protected your PC" → More info → Run anyway). Buy a code-signing cert to remove it.

## Ports / firewall

- **45455/TCP** — signaling (LAN mode host, or your internet server)
- Random UDP — WebRTC media (handled automatically by ICE)

## Architecture

```
main.js                     Electron main: window, IPC, embedded LAN signaling server
preload.js                  Safe IPC bridge to the renderer
signaling.js                Room-based WS relay — shared by app + standalone server
renderer/                   UI + WebRTC (desktopCapturer → getUserMedia → RTCPeerConnection)
server/signaling-server.js  Standalone signaling server for internet mode
```
