// Shared WebRTC + signaling for the web pages.
// Same protocol as the desktop app: join {type,room,role} -> joined/peer-joined;
// relay {type:'signal', to, data} <-> {type:'signal', from, data}.
// Media is peer-to-peer only — the signaling server never sees video.

const SF_SIGNAL = 'wss://screenflow.nextforms.in/ws';
const SF_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
// Optional TURN fallback for restrictive NATs — provision coturn/CF Calls and add:
// { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
const SF_TURN = [];

function sfIceServers() {
  return SF_TURN.length ? [...SF_ICE, ...SF_TURN] : SF_ICE;
}

function sfConnect(code, role, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SF_SIGNAL);
    const conn = {
      ws,
      id: null,
      peers: [],
      onPeerJoined: null,
      onPeerLeft: null,
      onSignal: null,
      onError: null,
      send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)),
      close: () => ws.close(),
    };
    const timer = setTimeout(() => reject(new Error('Connection timed out')), 10000);
    ws.onopen = () => conn.send({ type: 'join', room: code, role, ...extra });
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'joined') {
        conn.id = m.id;
        conn.peers = m.peers || [];
        clearTimeout(timer);
        resolve(conn);
      } else if (m.type === 'peer-joined') conn.onPeerJoined?.(m);
      else if (m.type === 'peer-left') conn.onPeerLeft?.(m.id);
      else if (m.type === 'signal') conn.onSignal?.(m.from, m.data);
      else if (m.type === 'error') conn.onError?.(m.message);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Cannot reach the ScreenFlow server')); };
    ws.onclose = () => conn.onError?.('Disconnected from server');
  });
}

/* ---------- Quality tiers (adapt down under load, recover up when clean) ---------- */

const SF_TIERS = [
  { maxBitrate: 8_000_000, maxFramerate: 30 }, // good: 1080p, headroom for motion/video
  { maxBitrate: 4_000_000, maxFramerate: 24 }, // moderate
  { maxBitrate: 2_500_000, maxFramerate: 15 }, // poor
  { maxBitrate: 1_200_000, maxFramerate: 10 }, // very poor
];

async function sfApplyTier(pc, tier) {
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
      p.degradationPreference = 'maintain-resolution'; // sharp text > fps
      await s.setParameters(p);
    } catch { /* nonstandard field */ }
  }
}

/* ---------- getStats diagnostics ---------- */
// Every 2s reports: fps, resolution, send/recv kbps, packet loss, jitter, RTT,
// frames encoded/decoded/dropped, QP, quality limitation reason, ICE pair type.

function sfStatsLoop(pc, cb) {
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
      m.w = outV.frameWidth; m.h = outV.frameHeight;
      m.qlr = outV.qualityLimitationReason;
    }
    if (inV) {
      m.recv = inV.bytesReceived; m.dfps = inV.framesPerSecond; m.dec = inV.framesDecoded;
      m.dropped = inV.framesDropped; m.lost = inV.packetsLost; m.jitter = inV.jitter;
      m.dw = inV.frameWidth; m.dh = inV.frameHeight;
    }
    if (remIn) {
      m.rFraction = remIn.fractionLost; m.rLost = remIn.packetsLost;
      m.rJitter = remIn.jitter; m.rRtt = remIn.roundTripTime;
    }

    if (prev) {
      const dt = (m.ts - prev.ts) / 1000;
      if (dt > 0) {
        if (m.sent != null && prev.sent != null) m.kbps = ((m.sent - prev.sent) * 8) / dt / 1000;
        if (m.recv != null && prev.recv != null) m.rkbps = ((m.recv - prev.recv) * 8) / dt / 1000;
        if (m.lost != null && prev.lost != null) m.lostDelta = m.lost - prev.lost;
        if (m.enc != null && prev.enc != null) m.encDelta = m.enc - prev.enc;
        if (m.dec != null && prev.dec != null) m.decDelta = m.dec - prev.dec;
      }
    }
    prev = m;
    cb?.(m);
  }, 2000);
  return () => clearInterval(timer);
}

/* ---------- Adaptive controller (sender side) ---------- */
// Down a tier on real congestion (loss >6%, RTT >350ms, encoder bandwidth-capped
// while saturated) or CPU limits; recover one tier after ~16s clean.

function sfAdaptive(pc, onTier) {
  let tier = 0;
  let goodStreak = 0;
  return sfStatsLoop(pc, (m) => {
    const congested =
      (m.rFraction != null && m.rFraction > 0.06) ||
      (m.rtt != null && m.rtt > 0.35) ||
      (m.availKbps != null && m.kbps != null && m.kbps > m.availKbps * 0.95 && m.qlr === 'bandwidth');
    const cpuBound = m.qlr === 'cpu' || m.qlr === 'other';

    if ((congested || cpuBound) && tier < SF_TIERS.length - 1) {
      goodStreak = 0;
      tier++;
      sfApplyTier(pc, tier);
      onTier?.(tier, m);
    } else if (!congested && !cpuBound && tier > 0 && ++goodStreak >= 8) {
      goodStreak = 0;
      tier--;
      sfApplyTier(pc, tier);
      onTier?.(tier, m);
    }
  });
}

/* ---------- Peer helpers ---------- */

// Host side: offer our screen stream to a viewer.
// registry (optional Map) registers the pc BEFORE any await, so early
// answers/candidates from the viewer are never dropped.
async function sfHostOffer(conn, viewerId, stream, onState, registry) {
  const pc = new RTCPeerConnection({ iceServers: sfIceServers() });
  registry?.set(viewerId, pc);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  pc.onicecandidate = (e) => {
    if (e.candidate) conn.send({ type: 'signal', to: viewerId, data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => onState?.(viewerId, pc.connectionState);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  conn.send({ type: 'signal', to: viewerId, data: { sdp: pc.localDescription } });

  await sfApplyTier(pc, 0); // negotiate first, then set encoding caps
  return pc;
}

// Viewer side: answer a host's offer; onTrack(stream) when video arrives.
async function sfViewerAnswer(conn, hostId, sdp, { onTrack, onState }) {
  const pc = new RTCPeerConnection({ iceServers: sfIceServers() });
  pc.onicecandidate = (e) => {
    if (e.candidate) conn.send({ type: 'signal', to: hostId, data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => onState?.(hostId, pc.connectionState);
  pc.ontrack = (e) => {
    try { if (e.receiver) e.receiver.playoutDelayHint = 0; } catch {} // realtime, no buffer
    onTrack?.(e.streams[0]);
  };
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  conn.send({ type: 'signal', to: hostId, data: { sdp: pc.localDescription } });
  return pc;
}

function genCode6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
