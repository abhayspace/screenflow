# ScreenFlow — project notes

## Commands
- Dev run: `npm start` — must unset `ELECTRON_RUN_AS_NODE` in this environment: `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron .`
- Build: `npm run dist:mac` (dmg), `npm run dist:win` (nsis exe, Windows only)
- Signaling server (internet mode): `npm run signal-server` or `node server/signaling-server.js <port>`
- Smoke-test signaling: node script connecting two `ws` clients to `createSignalingServer` on a test port

## Gotchas
- `ELECTRON_RUN_AS_NODE=1` is set in the Devin shell env — must unset to launch the app.
- Electron postinstall (binary download) needs `npm install-scripts approve electron` in this env.
- If `electron/dist` extracts incompletely, extract the cached zip from `~/Library/Caches/electron/` with system `unzip` and write `path.txt` containing `Electron.app/Contents/MacOS/Electron`.
- `WebRtcHideLocalIpsWithMdns` is disabled in main.js so LAN ICE uses real IPs — don't remove.
- Signaling port: 45455 (TCP/WS, runs on the VIEWER's machine). UDP discovery port: 45456 (`SF_DISCOVER:<code>` → `SF_HERE:<code>:<port>`).
- Pairing flow: viewer generates 6-digit code = WS room name + discovery key; sharer enters code → UDP broadcast finds viewer IP on LAN, or internet mode uses code as room on signaling server.
