// Shared WebRTC + signaling for the web pages.
// Same protocol as the desktop app: join {type,room,role} -> joined/peer-joined;
// relay {type:'signal', to, data} <-> {type:'signal', from, data}.

const SF_SIGNAL = 'wss://screenflow.nextforms.in/ws';
const SF_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

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

// Host side: offer our screen stream to a viewer.
async function sfHostOffer(conn, viewerId, stream, onState) {
  const pc = new RTCPeerConnection({ iceServers: SF_ICE });
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  pc.onicecandidate = (e) => {
    if (e.candidate) conn.send({ type: 'signal', to: viewerId, data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => onState?.(viewerId, pc.connectionState);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  conn.send({ type: 'signal', to: viewerId, data: { sdp: pc.localDescription } });

  // Screen quality: sharp text + generous bitrate (applied after negotiation).
  for (const s of pc.getSenders()) {
    if (s.track?.kind !== 'video') continue;
    try { s.track.contentHint = 'detail'; } catch {}
    try {
      const p = s.getParameters();
      p.encodings = [{ maxBitrate: 10_000_000 }];
      await s.setParameters(p);
    } catch { /* older browsers */ }
  }
  return pc;
}

// Viewer side: answer a host's offer; onTrack(stream) when video arrives.
async function sfViewerAnswer(conn, hostId, sdp, { onTrack, onState }) {
  const pc = new RTCPeerConnection({ iceServers: SF_ICE });
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
