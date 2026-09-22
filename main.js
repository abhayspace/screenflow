const { app, BrowserWindow, ipcMain, desktopCapturer, session, systemPreferences, shell, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const dgram = require('dgram');
const { createSignalingServer } = require('./signaling');

// Startup/crash logging → userData/screenflow.log (helps debug silent launches).
function logLine(...args) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'screenflow.log'),
      `${new Date().toISOString()} ${args.join(' ')}\n`
    );
  } catch { /* not ready yet */ }
}
process.on('uncaughtException', (e) => logLine('uncaughtException:', e.stack || String(e)));
process.on('unhandledRejection', (e) => logLine('unhandledRejection:', (e && e.stack) || String(e)));

// Some Windows GPU drivers kill the window before it ever shows.
app.disableHardwareAcceleration();

const SIGNAL_PORT = 45455;
const DISCOVERY_PORT = 45456;

// Exchange real LAN IPs in ICE candidates instead of obfuscated *.local names,
// which makes peer-to-peer connections on local networks far more reliable.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

let win = null;
let lanServer = null;
let pendingSourceId = null;
let discoverySocket = null;
let discoveryCode = null;

function getLanAddresses() {
  const addrs = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

function broadcastAddresses() {
  const list = ['255.255.255.255'];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal && net.netmask) {
        const a = net.address.split('.').map(Number);
        const m = net.netmask.split('.').map(Number);
        list.push(a.map((v, i) => v | (255 - m[i])).join('.'));
      }
    }
  }
  return [...new Set(list)];
}

function createWindow() {
  win = new BrowserWindow({
    icon: nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')),
    width: 1024,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#080808',
    title: 'ScreenFlow',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  logLine('app ready', app.getVersion(), process.platform, os.release());
  // Route getDisplayMedia() through our own source picker choice instead of
  // Chromium's picker. On macOS this uses ScreenCaptureKit, which is what
  // triggers the system Screen Recording permission prompt.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        const src = sources.find((s) => s.id === pendingSourceId) || sources[0];
        // 'loopback' captures system audio (Windows + macOS via ScreenCaptureKit);
        // platforms without loopback support simply return no audio track.
        if (src) callback({ video: src, audio: 'loopback' });
        else callback();
      })
      .catch(() => callback());
  });

  ipcMain.handle('set-share-source', (_e, id) => {
    pendingSourceId = id;
    return true;
  });

  ipcMain.handle('get-screen-access-status', () => {
    if (process.platform === 'darwin') {
      return systemPreferences.getMediaAccessStatus('screen');
    }
    return 'granted';
  });

  ipcMain.handle('request-screen-access', async () => {
    if (process.platform !== 'darwin') return true;
    try {
      return await systemPreferences.askForMediaAccess('screen');
    } catch {
      // Older Electron/macOS may not support 'screen' here; the renderer falls
      // back to a real capture attempt, which also triggers the prompt.
      return false;
    }
  });

  ipcMain.handle('open-screen-settings', () => {
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
    return true;
  });

  // Show the app icon in the Dock during development too (dev runs the raw
  // Electron binary, which otherwise shows the default Electron icon).
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')));
  }

  ipcMain.handle('get-screen-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 480, height: 270 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle('lan-server-start', () => {
    if (lanServer) {
      return { port: SIGNAL_PORT, addresses: getLanAddresses(), alreadyRunning: true };
    }
    return new Promise((resolve, reject) => {
      try {
        lanServer = createSignalingServer({
          port: SIGNAL_PORT,
          onListening: () =>
            resolve({ port: SIGNAL_PORT, addresses: getLanAddresses(), alreadyRunning: false }),
        });
        lanServer.wss.on('error', (err) => {
          lanServer = null;
          reject(new Error(`Could not start LAN server on port ${SIGNAL_PORT}: ${err.message}`));
        });
      } catch (err) {
        lanServer = null;
        reject(err);
      }
    });
  });

  ipcMain.handle('lan-server-stop', async () => {
    if (!lanServer) return { stopped: false };
    const s = lanServer;
    lanServer = null;
    await s.close();
    return { stopped: true };
  });

  ipcMain.handle('get-lan-addresses', () => getLanAddresses());

  // ---- LAN discovery -----------------------------------------------------
  // Viewer side: answer "who has code X?" broadcasts so the sharer can find
  // this device by code alone. Sharer side: broadcast and await the reply.

  ipcMain.handle('discovery-start', (_e, code) => {
    discoveryCode = String(code);
    if (discoverySocket) return true;
    discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    discoverySocket.on('message', (msg, rinfo) => {
      if (msg.toString() === `SF_DISCOVER:${discoveryCode}`) {
        const reply = Buffer.from(`SF_HERE:${discoveryCode}:${SIGNAL_PORT}`);
        discoverySocket.send(reply, rinfo.port, rinfo.address);
      }
    });
    discoverySocket.on('error', () => {});
    discoverySocket.bind(DISCOVERY_PORT);
    return true;
  });

  ipcMain.handle('discovery-stop', () => {
    if (discoverySocket) {
      try { discoverySocket.close(); } catch {}
      discoverySocket = null;
      discoveryCode = null;
    }
    return true;
  });

  ipcMain.handle('discover-peer', (_e, code) =>
    new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch {}
        resolve(v);
      };
      const send = () => {
        const payload = Buffer.from(`SF_DISCOVER:${code}`);
        for (const b of broadcastAddresses()) {
          try { sock.send(payload, DISCOVERY_PORT, b); } catch {}
        }
      };
      sock.on('message', (msg, rinfo) => {
        if (msg.toString() === `SF_HERE:${code}:${SIGNAL_PORT}`) {
          done({ ip: rinfo.address, port: SIGNAL_PORT });
        }
      });
      sock.on('error', () => done(null));
      sock.bind(() => {
        try { sock.setBroadcast(true); } catch {}
        send();
        setTimeout(() => !settled && send(), 800); // one retry
      });
      setTimeout(() => done(null), 3000);
    })
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (discoverySocket) {
    try { discoverySocket.close(); } catch {}
    discoverySocket = null;
  }
  if (lanServer) {
    await lanServer.close();
    lanServer = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
