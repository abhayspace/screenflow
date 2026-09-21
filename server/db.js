// Supabase (PostgREST) data layer — server-side only, uses the secret key.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SECRET_KEY;

async function sb(path, { method = 'GET', body, prefer } = {}) {
  if (!SB_URL || !SB_KEY) {
    throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SECRET_KEY)');
  }
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) throw new Error(data?.message || `Supabase error ${res.status}`);
  return data;
}

const enc = encodeURIComponent;

module.exports = {
  findUserByEmail: (email) =>
    sb(`/users?email=eq.${enc(email)}&select=*`).then((r) => r?.[0]),
  findUserByUsername: (username) =>
    sb(`/users?username=eq.${enc(username)}&select=*`).then((r) => r?.[0]),
  insertUser: (u) =>
    sb('/users', { method: 'POST', body: u, prefer: 'return=representation' }).then((r) => r?.[0]),
  getPending: (email) =>
    sb(`/pending_signups?email=eq.${enc(email)}&select=*`).then((r) => r?.[0]),
  upsertPending: (p) =>
    sb('/pending_signups', { method: 'POST', body: p, prefer: 'resolution=merge-duplicates' }),
  deletePending: (email) =>
    sb(`/pending_signups?email=eq.${enc(email)}`, { method: 'DELETE' }),
};
