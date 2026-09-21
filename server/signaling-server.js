// Standalone signaling server for "Over the internet" mode.
// Deploy this on any public host (VPS, Render, Railway, a home server with a
// forwarded port, etc.) — it only relays small JSON messages, never video.
//
//   node server/signaling-server.js [port]
//
// Then in the app use ws://<host>:<port> (or wss://<domain> behind TLS).
// For production, put it behind a TLS-terminating proxy (Caddy/nginx/Cloudflare)
// and use wss://.

const { createSignalingServer } = require('../signaling');

const port = Number(process.argv[2] || process.env.PORT || 45455);

createSignalingServer({
  port,
  onListening: (addr) => {
    console.log(`ScreenFlow signaling server listening on port ${addr.port}`);
  },
});
