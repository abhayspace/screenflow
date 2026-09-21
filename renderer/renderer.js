const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Internet-mode signaling server. Deploy server/signaling-server.js on any
// public host (VPS, Railway, Render…), then paste its wss:// address here.
// Users never see this — pairing is still just the 6-digit code.
// LAN mode (same WiFi) works with no server and no internet at all.
const DEFAULT_SIGNAL_SERVER = 'wss://screenflow.nextforms.in/ws'; // dev: 'ws://localhost:45455' with `npm run server`
// ---------------------------------------------------------------------------

// Fallback for previewing the UI in a plain browser (no Electron preload).
if (!window.screenflow) {
  const demoThumb =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#1b1f27"/><rect x="40" y="40" width="400" height="190" rx="8" fill="#0f1115" stroke="#3a3f4a"/><text x="240" y="145" fill="#7db1ff" font-family="sans-serif" font-size="22" text-anchor="middle">Screen 1 (preview)</text></svg>'
    );
  window.screenflow = {
    isElectron: false,
    getScreenSources: async () => [{ id: 'preview', name: 'Screen 1', thumbnail: demoThumb }],
    startLanServer: async () => ({ port: 45455, addresses: ['192.168.1.20'], alreadyRunning: false }),
    stopLanServer: async () => ({ stopped: true }),
    getLanAddresses: async () => ['192.168.1.20'],
    startDiscovery: async () => true,
    stopDiscovery: async () => true,
    discoverPeer: async () => null,
    getScreenAccessStatus: async () => 'granted',
    requestScreenAccess: async () => true,
    openScreenSettings: async () => true,
    setShareSource: async () => true,
  };
}

const viewEls = [...document.querySelectorAll('.view')];
const navStack = [];

const STUN = { urls: ['stun:stun.l.google.com:19302'] };
const LAN_ICE = [];               // pure LAN needs no STUN/TURN
const NET_ICE = [STUN];           // internet mode (+ TURN from /api/turn when available)
let _turnPromise = null;
async function netIceServers() {
  if (!_turnPromise) {
    _turnPromise = api('/api/turn', {})
      .then((d) => ({ urls: d.urls, username: d.username, credential: d.credential }))
      .catch(() => null);
  }
  const turn = await _turnPromise;
  return turn ? [...NET_ICE, turn] : NET_ICE;
}

const conns = new Set();          // active signaling connections
const peers = new Map();          // peerId -> { pc, conn }

let selectedSourceId = null;
let localStream = null;
let isHost = false;
let activeCode = null;
let lanReady = false;
let netReady = false;
let shareMode = 'lan';

/* ---------- UI helpers ---------- */

function show(id) {
  viewEls.forEach((v) => v.classList.toggle('hidden', v.id !== id));
}

function go(id) {
  const current = viewEls.find((v) => !v.classList.contains('hidden'));
  if (current) navStack.push(current.id);
  show(id);
}

function back() {
  cleanupSession();
  show(navStack.pop() || 'view-home');
}

function setStatus(id, text) { $(id).textContent = text; }

function genCode6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function viewerStatusText() {
  const parts = [];
  parts.push(lanReady ? 'Same WiFi: ready' : 'Same WiFi: off');
  if (DEFAULT_SIGNAL_SERVER) parts.push(netReady ? 'Internet: ready' : 'Internet: connecting…');
  else parts.push('Internet: not configured');
  return parts.join('  ·  ');
}

// Restricted mode: only devices signed in to the same account may share.
function viewerRestricted() {
  const s = getSession();
  return !!(s && s.token && $('anyone-share') && !$('anyone-share').checked);
}
const approvedHosts = new Set();
const pendingAuth = new Set();

async function verifyPeerToken(from, data, conn) {
  const me = getSession();
  try {
    const d = await api('/api/me', { token: data.auth.token });
    const ok = !!(me && d.user && d.user.username === me.user.username);
    if (ok) approvedHosts.add(from);
    conn.send({ type: 'signal', to: from, data: { auth: ok ? 'ok' : 'deny' } });
  } catch {
    conn.send({ type: 'signal', to: from, data: { auth: 'deny' } });
  }
}

// Host side: restricted viewers get our token first; offer only after approval.
function handleViewerPeer(id, conn, iceServers, restricted) {
  if (peers.has(id) || pendingAuth.has(id)) return;
  if (restricted) {
    pendingAuth.add(id);
    conn.send({ type: 'signal', to: id, data: { auth: { token: getSession()?.token || null } } });
  } else {
    hostOfferTo(id, conn, iceServers);
  }
}

/* ---------- Signaling ---------- */

function addConn(url, room, role, iceServers, handlers, joinExtra = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const conn = {
      url,
      send: (m) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m)); },
      close: () => { socket.onclose = null; socket.close(); },
    };
    const timeout = setTimeout(() => {
      socket.onclose = null;
      socket.close();
      reject(new Error(`Timed out connecting to ${url}`));
    }, 8000);

    socket.onopen = () => conn.send({ type: 'join', room, role, ...joinExtra });

    socket.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'joined') {
        clearTimeout(timeout);
        conns.add(conn);
        resolve({ ...msg, conn });
      } else if (msg.type === 'error') {
        handlers.onError?.(msg.message);
      } else {
        await handlers.onMessage?.(msg, conn);
      }
    };

    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`Could not reach ${url}`));
    };

    socket.onclose = () => {
      conns.delete(conn);
      handlers.onClose?.();
    };
  });
}

/* ---------- Screen capture ---------- */

async function captureScreen(sourceId) {
  if (window.screenflow.isElectron) {
    // Hand our chosen source to the main process; the display-media request
    // handler there returns it, and macOS triggers the Screen Recording prompt.
    await window.screenflow.setShareSource(sourceId);
  }
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
  });
}

/* ---------- Quality tiers + diagnostics ---------- */
// Adapt down under congestion/CPU load, recover when clean. Sharp text first.

const SF_TIERS = [
  { maxBitrate: 8_000_000, maxFramerate: 30 },
  { maxBitrate: 4_000_000, maxFramerate: 24 },
  { maxBitrate: 2_500_000, maxFramerate: 15 },
  { maxBitrate: 1_200_000, maxFramerate: 10 },
];

async function applyTier(pc, tier) {
  const t = SF_TIERS[tier];
  for (const s of pc.getSenders()) {
    if (s.track?.kind !== 'video') continue;
    try { s.track.contentHint = 'detail'; } catch {}
    try {
      const p = s.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = t.maxBitrate;
      p.encodings[0].maxFramerate = t.maxFramerate;
      await s.setParameters(p);
    } catch { /* unsupported */ }
    try {
      const p = s.getParameters();
      p.degradationPreference = 'maintain-resolution';
      await s.setParameters(p);
    } catch { /* nonstandard field */ }
  }
}

function statsLoop(pc, cb) {
  let prev = null;
  const timer = setInterval(async () => {
    if (pc.signalingState === 'closed') return clearInterval(timer);
    let report;
    try { report = await pc.getStats(); } catch { return; }
    const m = { ts: Date.now() };
    let outV = null, inV = null, remIn = null, pair = null;
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video' && !r.isRemote) outV = r;
      else if (r.type === 'inbound-rtp' && r.kind === 'video' && !r.isRemote) inV = r;
      else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remIn = r;
      else if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
    });
    if (pair) {
      m.rtt = pair.currentRoundTripTime;
      m.availKbps = pair.availableOutgoingBitrate ? pair.availableOutgoingBitrate / 1000 : null;
      const lc = report.get(pair.localCandidateId);
      const rc = report.get(pair.remoteCandidateId);
      m.ice = lc ? `${lc.candidateType}→${rc ? rc.candidateType : '?'}` : null;
    }
    if (outV) {
      m.sent = outV.bytesSent; m.fps = outV.framesPerSecond; m.enc = outV.framesEncoded;
      m.w = outV.frameWidth; m.h = outV.frameHeight; m.qlr = outV.qualityLimitationReason;
    }
    if (inV) {
      m.recv = inV.bytesReceived; m.dfps = inV.framesPerSecond; m.dec = inV.framesDecoded;
      m.dropped = inV.framesDropped; m.lost = inV.packetsLost; m.jitter = inV.jitter;
      m.dw = inV.frameWidth; m.dh = inV.frameHeight;
    }
    if (remIn) { m.rFraction = remIn.fractionLost; m.rLost = remIn.packetsLost; m.rJitter = remIn.jitter; }
    if (prev) {
      const dt = (m.ts - prev.ts) / 1000;
      if (dt > 0) {
        if (m.sent != null && prev.sent != null) m.kbps = ((m.sent - prev.sent) * 8) / dt / 1000;
        if (m.recv != null && prev.recv != null) m.rkbps = ((m.recv - prev.recv) * 8) / dt / 1000;
        if (m.lost != null && prev.lost != null) m.lostDelta = m.lost - prev.lost;
      }
    }
    prev = m;
    cb?.(m);
  }, 2000);
  return () => clearInterval(timer);
}

function startAdaptive(pc) {
  let tier = 0, good = 0;
  const stop = statsLoop(pc, (m) => {
    const congested =
      (m.rFraction != null && m.rFraction > 0.06) ||
      (m.rtt != null && m.rtt > 0.35) ||
      (m.availKbps != null && m.kbps != null && m.kbps > m.availKbps * 0.95 && m.qlr === 'bandwidth');
    const cpuBound = m.qlr === 'cpu' || m.qlr === 'other';
    if ((congested || cpuBound) && tier < SF_TIERS.length - 1) {
      good = 0; tier++; applyTier(pc, tier);
    } else if (!congested && !cpuBound && tier > 0 && ++good >= 8) {
      good = 0; tier--; applyTier(pc, tier);
    }
  });
  pc._stopLoops = (pc._stopLoops || []).concat(stop);
}

function startPeerStats(pc) {
  const stop = statsLoop(pc, (m) => {
    if (m.kbps == null || !$('share-stats')) return;
    $('share-stats').textContent =
      `${m.w || '?'}×${m.h || '?'} · ${Math.round(m.fps || 0)}fps · ${(m.kbps / 1000).toFixed(1)}Mbps · ` +
      `RTT ${Math.round((m.rtt || 0) * 1000)}ms · loss ${(((m.rFraction) || 0) * 100).toFixed(1)}% · ${m.ice || 'p2p'}` +
      (m.qlr && m.qlr !== 'none' ? ` · limited by ${m.qlr}` : '');
  });
  pc._stopLoops = (pc._stopLoops || []).concat(stop);
}

/* ---------- WebRTC ---------- */

function newPeerConnection(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.onconnectionstatechange = () => {
    if (isHost) {
      setStatus('share-status', `Viewers connected: ${connectedViewerCount()}`);
    } else if (pc.connectionState === 'connected') {
      setStatus('wait-status', 'Connected');
    } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      setStatus('wait-status', `Connection ${pc.connectionState}`);
    }
  };
  return pc;
}

function connectedViewerCount() {
  let n = 0;
  for (const p of peers.values()) if (p.pc.connectionState === 'connected') n++;
  return n;
}

// Host side: a viewer appeared — offer our screen to them.
async function hostOfferTo(viewerId, conn, iceServers) {
  if (peers.has(viewerId)) return;
  const pc = newPeerConnection(iceServers);
  peers.set(viewerId, { pc, conn });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) conn.send({ type: 'signal', to: viewerId, data: { candidate: e.candidate } });
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  conn.send({ type: 'signal', to: viewerId, data: { sdp: pc.localDescription } });

  await applyTier(pc, 0); // negotiate first, then set encoding caps
  startAdaptive(pc);      // congestion/CPU-aware bitrate+fps control
  startPeerStats(pc);     // getStats diagnostics → share-stats line
}

const pendingIce = new Map(); // peerId -> candidates that arrived before the pc existed

// Shared signal handling for both roles.
async function handleSignal(from, data, conn, iceServers) {
  let entry = peers.get(from);

  if (data.sdp && data.sdp.type === 'offer' && !isHost) {
    if (viewerRestricted() && !approvedHosts.has(from)) return; // same-account only
    // Viewer side: host is offering its screen.
    if (!entry) {
      const pc = newPeerConnection(iceServers);
      entry = { pc, conn };
      peers.set(from, entry);
      pc.onicecandidate = (e) => {
        if (e.candidate) conn.send({ type: 'signal', to: from, data: { candidate: e.candidate } });
      };
      pc.ontrack = (e) => {
        try { if (e.receiver) e.receiver.playoutDelayHint = 0; } catch {}
        $('remote-video').srcObject = e.streams[0];
        $('remote-video').classList.remove('hidden');
        $('btn-fullscreen').classList.remove('hidden');
        setStatus('wait-status', 'Receiving stream…');
        const stop = statsLoop(pc, (m) => {
          if (m.rkbps == null || !$('wait-stats')) return;
          $('wait-stats').textContent =
            `${m.dw || '?'}×${m.dh || '?'} · ${Math.round(m.dfps || 0)}fps · ${(m.rkbps / 1000).toFixed(1)}Mbps · ` +
            `RTT ${Math.round((m.rtt || 0) * 1000)}ms · loss ${m.lostDelta || 0} pkts · dropped ${m.dropped || 0} · ${m.ice || 'p2p'}`;
        });
        pc._stopLoops = (pc._stopLoops || []).concat(stop);
      };
    }
    await entry.pc.setRemoteDescription(data.sdp);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    conn.send({ type: 'signal', to: from, data: { sdp: entry.pc.localDescription } });
    // flush ICE candidates that arrived before the pc existed
    for (const c of pendingIce.get(from) || []) {
      try { await entry.pc.addIceCandidate(c); } catch { /* stale */ }
    }
    pendingIce.delete(from);
    return;
  }

  if (data.candidate && !entry) {
    if (!pendingIce.has(from)) pendingIce.set(from, []);
    pendingIce.get(from).push(data.candidate);
    return;
  }

  if (!entry) return;
  if (data.sdp && data.sdp.type === 'answer') {
    await entry.pc.setRemoteDescription(data.sdp);
    for (const c of entry.earlyIce || []) {
      try { await entry.pc.addIceCandidate(c); } catch { /* stale */ }
    }
    entry.earlyIce = null;
  } else if (data.candidate) {
    // buffer candidates that arrive before the answer is applied
    if (entry.pc.remoteDescription) {
      try { await entry.pc.addIceCandidate(data.candidate); } catch { /* stale candidate */ }
    } else {
      (entry.earlyIce = entry.earlyIce || []).push(data.candidate);
    }
  }
}

function closePeer(id) {
  const entry = peers.get(id);
  if (entry) {
    (entry.pc._stopLoops || []).forEach((fn) => fn());
    entry.pc.close();
    peers.delete(id);
  }
}

/* ---------- Session lifecycle ---------- */

function cleanupSession() {
  for (const conn of [...conns]) {
    conn.send({ type: 'leave' });
    conn.close();
  }
  conns.clear();
  for (const id of [...peers.keys()]) closePeer(id);
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  // The viewer hosts the LAN signaling server + discovery responder.
  window.screenflow.stopLanServer?.();
  window.screenflow.stopDiscovery?.();
  isHost = false;
  activeCode = null;
  lanReady = netReady = false;
  approvedHosts.clear();
  pendingAuth.clear();
  pendingIce.clear();
  $('share-preview').srcObject = null;
  $('remote-video').srcObject = null;
  $('remote-video').classList.add('hidden');
  $('btn-fullscreen').classList.add('hidden');
}

/* ---------- Host flow ---------- */

async function startShare({ url, room, iceServers }) {
  isHost = true;

  const status = await window.screenflow.getScreenAccessStatus?.().catch(() => 'granted');
  if (status === 'denied') {
    isHost = false;
    if (confirm('ScreenFlow needs Screen Recording permission to share your screen.\n\nOpen System Settings to grant it?')) {
      window.screenflow.openScreenSettings();
    }
    return false;
  }

  try {
    localStream = await captureScreen(selectedSourceId);
  } catch (err) {
    isHost = false;
    if (confirm(`Could not capture the screen: ${err.message}\n\nOn macOS, grant Screen Recording permission to this app in System Settings, then relaunch. Open settings now?`)) {
      window.screenflow.openScreenSettings?.();
    }
    return false;
  }
  $('share-preview').srcObject = localStream;

  try {
    const joinedMsg = await addConn(url, room, 'host', iceServers, {
      onMessage: async (msg, conn) => {
        if (msg.type === 'peer-joined' && msg.role === 'viewer') {
          handleViewerPeer(msg.id, conn, iceServers, msg.restricted);
        } else if (msg.type === 'signal') {
          if (msg.data?.auth === 'ok') {
            pendingAuth.delete(msg.from);
            await hostOfferTo(msg.from, conn, iceServers);
          } else if (msg.data?.auth === 'deny') {
            pendingAuth.delete(msg.from);
            setStatus('share-status', getSession()
              ? 'That device only accepts shares from its own account.'
              : 'That device only accepts same-account shares — sign in on both devices.');
          } else {
            await handleSignal(msg.from, msg.data, conn, iceServers);
          }
        } else if (msg.type === 'peer-left') {
          closePeer(msg.id);
          pendingAuth.delete(msg.id);
          setStatus('share-status', `Viewers connected: ${connectedViewerCount()}`);
        }
      },
      onError: (m) => setStatus('share-status', `Signaling error: ${m}`),
      onClose: () => setStatus('share-status', 'Signaling connection closed'),
    });

    $('share-info').innerHTML = `Sharing screen to code <code>${room}</code>`;
    setStatus('share-status', 'Waiting for the viewer to connect…');
    show('view-share-live');

    // Offer to viewers already waiting in the room.
    for (const p of joinedMsg.peers || []) {
      if (p.role === 'viewer') handleViewerPeer(p.id, joinedMsg.conn, iceServers, p.restricted);
    }
    return true;
  } catch (err) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    isHost = false;
    $('share-error').textContent = err.message;
    return false;
  }
}

async function onShareConnect() {
  const code = $('share-code').value.trim();
  const errEl = $('share-error');
  errEl.textContent = '';
  if (!/^\d{6}$/.test(code)) {
    errEl.textContent = 'Enter the 6-digit code shown on the other device.';
    return;
  }
  activeCode = code;
  $('btn-share-connect').disabled = true;
  try {
    if (shareMode === 'lan') {
      // Same WiFi: find the viewer by code via UDP broadcast.
      setStatus('share-finding', 'Looking for the device on this network…');
      const found = await window.screenflow.discoverPeer(code);
      setStatus('share-finding', '');
      if (found) {
        await startShare({ url: `ws://${found.ip}:${found.port}`, room: code, iceServers: LAN_ICE });
      } else {
        errEl.textContent = `No device with code ${code} found on this network. Make sure the other device tapped “View a screen → Same WiFi” and both are on the same network.`;
      }
      return;
    }

    // Over the internet: the code is the room on the signaling server.
    if (!DEFAULT_SIGNAL_SERVER) {
      errEl.textContent = 'Internet server is not configured in this build.';
      return;
    }
    setStatus('share-finding', 'Connecting over the internet…');
    const ok = await startShare({ url: DEFAULT_SIGNAL_SERVER, room: code, iceServers: await netIceServers() });
    setStatus('share-finding', '');
    if (!ok && !errEl.textContent) errEl.textContent = 'Could not reach the internet server.';
  } finally {
    $('btn-share-connect').disabled = false;
  }
}

/* ---------- Viewer flow ---------- */

function viewerHandlers(iceServers) {
  return {
    onMessage: async (msg, conn) => {
      if (msg.type === 'signal') {
        if (msg.data?.auth) {
          if (viewerRestricted()) await verifyPeerToken(msg.from, msg.data, conn);
          return;
        }
        await handleSignal(msg.from, msg.data, conn, iceServers);
      } else if (msg.type === 'peer-left') {
        closePeer(msg.from || msg.id);
        if (!$('remote-video').srcObject) setStatus('wait-status', 'Waiting — sharer left before connecting');
        else setStatus('wait-status', 'Peer disconnected');
      }
    },
    onError: () => {},
    onClose: () => {
      lanReady = conns.size > 0 && lanReady;
      netReady = conns.size > 0 && netReady;
      if (!$('remote-video').srcObject) setStatus('wait-status', viewerStatusText());
    },
  };
}

async function startViewer(mode) {
  const code = genCode6();
  activeCode = code;
  isHost = false;
  lanReady = netReady = false;
  $('wait-code').textContent = code;
  go('view-waiting');
  setStatus('wait-status', 'Starting…');

  if (mode === 'lan') {
    // Same-WiFi listener: local signaling server + UDP discovery responder.
    try {
      const { port } = await window.screenflow.startLanServer();
      await window.screenflow.startDiscovery(code);
      await addConn(`ws://127.0.0.1:${port}`, code, 'viewer', LAN_ICE, viewerHandlers(LAN_ICE), { restricted: viewerRestricted() });
      lanReady = true;
      setStatus('wait-status', 'Same WiFi: ready — sharer picks “Same WiFi” and enters this code');
    } catch (err) {
      setStatus('wait-status', `Could not start: ${err.message}`);
    }
    return;
  }

  // Internet listener: the code is the room on the signaling server.
  if (!DEFAULT_SIGNAL_SERVER) {
    setStatus('wait-status', 'Internet server is not configured in this build.');
    return;
  }
  try {
    const netIce = await netIceServers();
    await addConn(DEFAULT_SIGNAL_SERVER, code, 'viewer', netIce, viewerHandlers(netIce), { restricted: viewerRestricted() });
    netReady = true;
    setStatus('wait-status', 'Internet: ready — sharer picks “Over the internet” and enters this code');
  } catch (err) {
    setStatus('wait-status', `Could not reach the internet server: ${err.message}`);
  }
}

/* ---------- Source list ---------- */

async function loadSources() {
  const list = $('source-list');
  list.innerHTML = '';

  let sources = [];
  let loadError = null;
  try {
    sources = await window.screenflow.getScreenSources();
  } catch (err) {
    loadError = err;
  }

  const status = await window.screenflow.getScreenAccessStatus?.().catch(() => 'granted');
  const needsPermission =
    window.screenflow.isElectron && (status === 'denied' || status === 'not-determined');
  $('perm-box').classList.toggle('hidden', !needsPermission);

  for (const s of sources) {
    const el = document.createElement('button');
    el.className = 'source';
    el.innerHTML = `<img src="${s.thumbnail}" alt=""><span>${s.name}</span>`;
    el.onclick = () => {
      [...list.children].forEach((c) => c.classList.remove('selected'));
      el.classList.add('selected');
      selectedSourceId = s.id;
      go('view-share-mode');
    };
    list.appendChild(el);
  }
  if (loadError) {
    list.innerHTML = `<p class="error">Could not list screens: ${loadError.message}</p>`;
  } else if (!sources.length && !needsPermission) {
    list.innerHTML = '<p class="hint">No screens found. If you already granted permission, quit and reopen the app.</p>';
  }
}

/* ---------- Wiring ---------- */

/* ---------- Auth ---------- */

function authBase() {
  if (!DEFAULT_SIGNAL_SERVER) return null;
  try {
    const u = new URL(DEFAULT_SIGNAL_SERVER);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/';
    u.search = '';
    return u.origin;
  } catch {
    return null;
  }
}

async function api(path, body) {
  const base = authBase();
  if (!base) throw new Error('Accounts need the internet server — not configured in this build.');
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function saveSession(data) {
  localStorage.setItem('screenflow.session', JSON.stringify(data));
  updateAuthUI();
}

function getSession() {
  try { return JSON.parse(localStorage.getItem('screenflow.session') || 'null'); }
  catch { return null; }
}

function updateAuthUI() {
  const s = getSession();
  const signedIn = !!(s && s.token);
  $('user-chip').classList.toggle('hidden', !signedIn);
  $('btn-signout').classList.toggle('hidden', !signedIn);
  $('btn-signin').classList.toggle('hidden', signedIn);
  $('btn-signup').classList.toggle('hidden', signedIn);
  $('viewer-privacy')?.classList.toggle('hidden', !signedIn);
  if (signedIn) $('user-chip').textContent = `Hi, ${s.user.name || s.user.username}!`;
}

async function doSignin() {
  const id = $('signin-id').value.trim();
  const password = $('signin-pass').value;
  if (!id || !password) return setStatus('signin-status', 'Enter your email/username and password.');
  setStatus('signin-status', 'Signing in…');
  try {
    const data = await api('/api/signin', { id, password });
    saveSession(data);
    navStack.length = 0;
    show('view-home');
  } catch (err) {
    setStatus('signin-status', err.message);
  }
}

async function doSignupSend() {
  const name = $('signup-name').value.trim();
  const username = $('signup-username').value.trim();
  const email = $('signup-email').value.trim();
  const password = $('signup-pass').value;
  if (!name || !username || !email || !password) {
    return setStatus('signup-status', 'Fill in name, username, email and password.');
  }
  setStatus('signup-status', 'Sending OTP…');
  try {
    await api('/api/signup/begin', { name, username, email, password });
    $('signup-email-echo').textContent = email;
    $('signup-form').classList.add('hidden');
    $('signup-otp-block').classList.remove('hidden');
    setStatus('signup-status', '');
  } catch (err) {
    setStatus('signup-status', err.message);
  }
}

async function doSignupVerify() {
  const email = $('signup-email').value.trim();
  const otp = $('signup-otp').value.trim();
  if (!/^\d{6}$/.test(otp)) return setStatus('signup-status', 'Enter the 6-digit code from the email.');
  setStatus('signup-status', 'Verifying…');
  try {
    const data = await api('/api/signup/verify', { email, otp });
    saveSession(data);
    navStack.length = 0;
    show('view-home');
  } catch (err) {
    setStatus('signup-status', err.message);
  }
}

async function doOtpResend() {
  const email = $('signup-email').value.trim();
  setStatus('signup-status', 'Resending…');
  try {
    await api('/api/signup/resend', { email });
    setStatus('signup-status', 'New code sent.');
  } catch (err) {
    setStatus('signup-status', err.message);
  }
}

function init() {
  updateAuthUI();

  $('btn-signin').onclick = () => { setStatus('signin-status', ''); go('view-signin'); };
  $('btn-signup').onclick = () => {
    setStatus('signup-status', '');
    $('signup-form').classList.remove('hidden');
    $('signup-otp-block').classList.add('hidden');
    go('view-signup');
  };
  $('btn-signin-go').onclick = doSignin;
  $('btn-signup-send').onclick = doSignupSend;
  $('btn-signup-verify').onclick = doSignupVerify;
  $('btn-otp-resend').onclick = doOtpResend;
  $('btn-signout').onclick = () => {
    localStorage.removeItem('screenflow.session');
    updateAuthUI();
  };
  $('link-to-signup').onclick = (e) => { e.preventDefault(); go('view-signup'); };
  $('signup-otp').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });

  $('btn-share').onclick = () => { go('view-share-pick'); loadSources(); };
  $('btn-view').onclick = () => go('view-view-mode');

  $('btn-share-lan').onclick = () => {
    shareMode = 'lan';
    $('share-code-hint').textContent =
      'The device that tapped “View a screen → Same WiFi” shows a 6-digit code.';
    go('view-share-code');
  };
  $('btn-share-internet').onclick = () => {
    shareMode = 'internet';
    $('share-code-hint').textContent =
      'The device that tapped “View a screen → Over the internet” shows a 6-digit code.';
    go('view-share-code');
  };
  $('btn-view-lan').onclick = () => startViewer('lan');
  $('btn-view-internet').onclick = () => startViewer('internet');

  $('btn-refresh-sources').onclick = loadSources;

  // Trigger the macOS Screen Recording prompt, then reload the source list.
  $('btn-grant-perm').onclick = async () => {
    await window.screenflow.requestScreenAccess?.().catch(() => false);
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
    } catch { /* prompt shown or denied — reload either way */ }
    await loadSources();
  };
  $('btn-open-settings').onclick = () => window.screenflow.openScreenSettings?.();

  // Re-check sources when the user comes back from System Settings.
  window.addEventListener('focus', () => {
    if (!$('view-share-pick').classList.contains('hidden')) loadSources();
  });

  $('share-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
  $('btn-share-connect').onclick = () => onShareConnect();
  $('btn-stop-share').onclick = () => { cleanupSession(); show('view-home'); navStack.length = 0; };

  $('btn-stop-view').onclick = () => { cleanupSession(); show('view-home'); navStack.length = 0; };
  $('btn-fullscreen').onclick = () => {
    const v = $('remote-video');
    if (v.requestFullscreen) v.requestFullscreen();
  };
  document.addEventListener('fullscreenchange', () => {
    const v = $('remote-video');
    const t = v.srcObject?.getVideoTracks?.()[0];
    const s = t?.getSettings?.() || {};
    console.log(
      `[fs ${document.fullscreenElement ? 'enter' : 'exit'}] video ${v.videoWidth}×${v.videoHeight} → element ${v.clientWidth}×${v.clientHeight}` +
      ` | track ${s.width}×${s.height}@${s.frameRate}fps`
    );
  });

  document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = back; });
}

/* ---------- Theme ---------- */

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('screenflow.theme', t);
  $('btn-light').classList.toggle('on', t === 'light');
  $('btn-dark').classList.toggle('on', t !== 'light');
  const icon = document.querySelector('.brand-icon');
  if (icon) icon.src = t === 'light' ? 'assets/webside.png' : 'assets/icon.png';
}
$('btn-light').onclick = () => setTheme('light');
$('btn-dark').onclick = () => setTheme('dark');
setTheme(localStorage.getItem('screenflow.theme') || 'light');

init();
