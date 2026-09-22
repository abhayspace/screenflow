// Shared signaling server used by:
//  1. the Electron main process for LAN mode (host runs the server on the local network)
//  2. server/signaling-server.js for Internet mode (deployed on a public host)
//
// Protocol (JSON over WebSocket):
//   client -> server : { type: 'join', room: '<room>', role: 'host'|'viewer' }
//   server -> client : { type: 'joined', id, peers: [{id, role}] }
//   server -> room   : { type: 'peer-joined', id, role }
//   client -> server : { type: 'signal', to: '<peerId>', data: <any> }   // relayed
//   server -> client : { type: 'signal', from: '<peerId>', data: <any> }
//   server -> room   : { type: 'peer-left', id }
//   server -> client : { type: 'error', message }

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

function wireSignaling(wss) {
  // room -> Map(clientId -> ws)
  const rooms = new Map();

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(room, msg, exceptId) {
    const members = rooms.get(room);
    if (!members) return;
    for (const [id, ws] of members) {
      if (id !== exceptId) send(ws, msg);
    }
  }

  function leaveRoom(ws) {
    if (!ws._room) return;
    const members = rooms.get(ws._room);
    if (members) {
      members.delete(ws._id);
      if (members.size === 0) rooms.delete(ws._room);
    }
    broadcast(ws._room, { type: 'peer-left', id: ws._id });
    ws._room = null;
  }

  wss.on('connection', (ws) => {
    ws._id = crypto.randomUUID();
    ws._room = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(ws, { type: 'error', message: 'Invalid JSON' });
      }

      if (msg.type === 'join') {
        const room = String(msg.room || 'default').slice(0, 128);
        leaveRoom(ws);
        let members = rooms.get(room);
        if (!members) {
          members = new Map();
          rooms.set(room, members);
        }
        const peers = [...members.entries()].map(([id, m]) => ({ id, role: m._role, restricted: !!m._restricted }));
        ws._room = room;
        ws._role = msg.role === 'host' ? 'host' : 'viewer';
        ws._restricted = !!msg.restricted;
        members.set(ws._id, ws);
        console.log(`[signal] join room=${room} role=${ws._role} restricted=${ws._restricted} peers=${members.size}`);
        send(ws, { type: 'joined', id: ws._id, room, role: ws._role, peers });
        broadcast(room, { type: 'peer-joined', id: ws._id, role: ws._role, restricted: ws._restricted }, ws._id);
        return;
      }

      if (msg.type === 'signal') {
        const members = ws._room && rooms.get(ws._room);
        const target = members && members.get(String(msg.to));
        if (!target) return send(ws, { type: 'error', message: 'Unknown peer' });
        return send(target, { type: 'signal', from: ws._id, data: msg.data });
      }

      if (msg.type === 'leave') {
        leaveRoom(ws);
        return;
      }

      send(ws, { type: 'error', message: 'Unknown message type' });
    });

    ws.on('close', () => {
      if (ws._room) console.log(`[signal] leave room=${ws._room} role=${ws._role}`);
      leaveRoom(ws);
    });
    ws.on('error', () => leaveRoom(ws));
  });

  return wss;
}

// Standalone mode: the WebSocketServer owns its port (used for LAN mode in the
// Electron app and by server/signaling-server.js).
function createSignalingServer({ port = 45455, host = '0.0.0.0', onListening } = {}) {
  const wss = wireSignaling(new WebSocketServer({ port, host }));
  wss.on('listening', () => {
    const addr = wss.address();
    if (onListening) onListening(addr);
  });
  return {
    wss,
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

// Attached mode: share an existing http.Server's port (used by
// server/server.js so auth HTTP + signaling WS run on one port).
function attachSignalingServer(httpServer, path = '/') {
  return wireSignaling(new WebSocketServer({ server: httpServer, path }));
}

module.exports = { createSignalingServer, attachSignalingServer };
