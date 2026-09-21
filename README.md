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

1. Deploy the signaling server somewhere public (it only needs Node.js):
   ```bash
   node server/signaling-server.js 45455
   ```
   Put it behind TLS (Caddy/nginx/Cloudflare) and use `wss://`, or use `ws://` for testing.
2. **Sharing PC:** Share my screen → *Over the internet* → enter server URL + a room code → Start sharing.
3. **Viewing PC:** View a screen → *Over the internet* → same server URL + room code → Connect.

NAT traversal uses Google's public STUN server by default. For strict corporate NATs/firewalls you may need your own TURN server (e.g. [coturn](https://github.com/coturn/coturn)) — enter it under *Advanced* on both sides.

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
