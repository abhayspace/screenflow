// Auth + OTP email verification for ScreenFlow.
// Runs server-side only — the Resend API key must NEVER ship inside the app.
//
// Routes (all POST, JSON in/out):
//   /api/signup/begin   { name, username, email, password } -> sends OTP
//   /api/signup/resend  { email }                           -> resends OTP
//   /api/signup/verify  { email, otp }                      -> { token, user }
//   /api/signin         { id, password }   (id = email or username) -> { token, user }

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

/* ---------- storage (JSON file — fine for small deployments) ---------- */

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return { users: {}, pending: {} };
  }
}

function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2));
}

/* ---------- crypto helpers ---------- */

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), candidate);
}

const hashOtp = (email, otp) =>
  crypto.createHash('sha256').update(`${email.toLowerCase()}:${otp}`).digest('hex');

/* ---------- sessions (in-memory; restart logs everyone out) ---------- */

const sessions = new Map();
const newSession = (user) => {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, user);
  return token;
};

/* ---------- Resend ---------- */

async function sendOtpEmail(email, otp) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set on the server');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'ScreenFlow <screenflow@nextforms.in>',
      to: email,
      subject: 'Your ScreenFlow verification code',
      html: `<div style="font-family:sans-serif;padding:24px">
        <h2 style="margin:0 0 12px">ScreenFlow</h2>
        <p>Your verification code is:</p>
        <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:8px 0">${otp}</p>
        <p style="color:#888">It expires in 10 minutes.</p>
      </div>`,
    }),
  });
  if (!res.ok) throw new Error(`Email send failed (${res.status})`);
}

async function issueOtp(db, email, pending) {
  const otp = String(crypto.randomInt(100000, 1000000));
  if (process.env.SF_DEBUG_OTP) console.log(`[debug] OTP for ${email}: ${otp}`);
  pending.otpHash = hashOtp(email, otp);
  pending.expires = Date.now() + OTP_TTL_MS;
  pending.attempts = 0;
  db.pending[email.toLowerCase()] = pending;
  saveDb(db);
  await sendOtpEmail(email, otp);
}

/* ---------- HTTP handler ---------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
  res.end(JSON.stringify(obj));
  return true;
}

async function authHandler(req, res) {
  if (req.method === 'OPTIONS' && req.url.startsWith('/api/')) {
    sendJson(res, 204, {});
    return true;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/api/')) return false;

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid request body' });
    return true;
  }

  const db = loadDb();
  const err = (m, status = 400) => sendJson(res, status, { error: m });

  try {
    /* ----- sign up: begin ----- */
    if (req.url === '/api/signup/begin' || req.url === '/api/signup/resend') {
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Enter a valid email address');
      if (db.users[email]) return err('An account with this email already exists');

      if (req.url === '/api/signup/resend') {
        const pending = db.pending[email];
        if (!pending) return err('No pending signup for this email', 404);
        await issueOtp(db, email, pending);
        return sendJson(res, 200, { ok: true });
      }

      if (name.length < 2) return err('Enter your name');
      if (!/^[a-z0-9_.]{3,20}$/.test(username)) return err('Username: 3–20 chars, a–z 0–9 _ .');
      if (password.length < 6) return err('Password must be at least 6 characters');
      if (Object.values(db.users).some((u) => u.username === username)) {
        return err('Username is taken');
      }

      await issueOtp(db, email, { name, username, passHash: hashPassword(password) });
      return sendJson(res, 200, { ok: true });
    }

    /* ----- sign up: verify OTP ----- */
    if (req.url === '/api/signup/verify') {
      const email = String(body.email || '').trim().toLowerCase();
      const otp = String(body.otp || '').trim();
      const pending = db.pending[email];
      if (!pending) return err('No pending signup for this email', 404);
      if (Date.now() > pending.expires) return err('Code expired — request a new one');
      if (pending.attempts >= OTP_MAX_ATTEMPTS) return err('Too many attempts — request a new code');
      if (hashOtp(email, otp) !== pending.otpHash) {
        pending.attempts++;
        saveDb(db);
        return err('Wrong code');
      }
      const user = { name: pending.name, username: pending.username, email };
      db.users[email] = { ...user, passHash: pending.passHash, createdAt: Date.now() };
      delete db.pending[email];
      saveDb(db);
      return sendJson(res, 200, { token: newSession(user), user });
    }

    /* ----- sign in (email or username + password) ----- */
    if (req.url === '/api/signin') {
      const id = String(body.id || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user =
        db.users[id] ||
        Object.values(db.users).find((u) => u.username === id);
      if (!user || !verifyPassword(password, user.passHash)) {
        return err('Invalid credentials', 401);
      }
      const { passHash, ...safe } = user;
      return sendJson(res, 200, { token: newSession(safe), user: safe });
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
  return true;
}

module.exports = { authHandler };
