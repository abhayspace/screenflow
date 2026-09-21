// Combined ScreenFlow server: auth (HTTP API) + signaling (WebSocket) on ONE port.
//
//   node server/server.js [port]
//
// Put it on a public host (VPS, Railway, Render…) behind TLS, then set in
// renderer/renderer.js:  DEFAULT_SIGNAL_SERVER = 'wss://your-domain'
// The app derives the auth API base automatically (wss:// -> https://).
//
// Secrets live in .env (never shipped to the app):
//   RESEND_API_KEY=...
//   RESEND_FROM_EMAIL=ScreenFlow <screenflow@nextforms.in>

const path = require('path');
const http = require('http');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch { /* .env optional */ }

const { attachSignalingServer } = require('../signaling');
const { authHandler } = require('./auth');

const port = Number(process.argv[2] || process.env.PORT || 45455);

const server = http.createServer(async (req, res) => {
  if (await authHandler(req, res)) return;
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

attachSignalingServer(server, '/ws');

server.listen(port, () => {
  console.log(`ScreenFlow server listening on port ${port} (auth API at /api/*, signaling WS at /ws)`);
});
