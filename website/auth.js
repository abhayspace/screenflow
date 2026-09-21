// Shared auth for web pages: Sign in / Sign up in the header,
// session in localStorage, "Hi, <name>!" when signed in.
// window.sfAuth = { session(), token(), user(), onchange(cb) }

(function () {
  const SESSION_KEY = 'sf-session';

  const sess = () => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  };
  const save = (s) => { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); render(); };
  const clear = () => { localStorage.removeItem(SESSION_KEY); render(); };

  const api = async (path, body) => {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
    return d;
  };

  // ---- inject modal ----
  document.body.insertAdjacentHTML('beforeend', `
    <div id="auth-modal" class="modal hidden">
      <div class="modal-backdrop" data-close-auth></div>
      <div class="modal-card">
        <div class="modal-head">
          <h3 id="auth-title">Sign in</h3>
          <button class="modal-x" data-close-auth aria-label="Close">&times;</button>
        </div>
        <div id="auth-signin" class="contact-form">
          <input id="as-id" type="text" placeholder="Email or username" />
          <input id="as-pass" type="password" placeholder="Password" />
          <p id="as-status" class="modal-note"></p>
          <button class="btn primary cf-send" id="as-go">Sign in</button>
          <p class="auth-swap">No account? <a href="#" id="as-to-signup">Sign up</a></p>
        </div>
        <div id="auth-signup" class="contact-form hidden">
          <input id="au-name" type="text" placeholder="Name" />
          <input id="au-user" type="text" placeholder="Username" />
          <input id="au-email" type="email" placeholder="Gmail" />
          <input id="au-pass" type="password" placeholder="Password" />
          <div id="au-otp-block" class="hidden">
            <input id="au-otp" inputmode="numeric" maxlength="6" placeholder="6-digit OTP" />
          </div>
          <p id="au-status" class="modal-note"></p>
          <button class="btn primary cf-send" id="au-go">Send OTP</button>
          <p class="auth-swap">Have an account? <a href="#" id="as-to-signin">Sign in</a></p>
        </div>
      </div>
    </div>`);

  const $ = (id) => document.getElementById(id);
  const modal = $('auth-modal');
  const show = (which) => {
    $('auth-title').textContent = which === 'in' ? 'Sign in' : 'Sign up';
    $('auth-signin').classList.toggle('hidden', which !== 'in');
    $('auth-signup').classList.toggle('hidden', which !== 'up');
    modal.classList.remove('hidden');
  };
  modal.querySelectorAll('[data-close-auth]').forEach((el) => (el.onclick = () => modal.classList.add('hidden')));
  $('as-to-signup').onclick = (e) => { e.preventDefault(); show('up'); };
  $('as-to-signin').onclick = (e) => { e.preventDefault(); show('in'); };

  $('as-go').onclick = async () => {
    $('as-status').textContent = 'Signing in…';
    try {
      const d = await api('/api/signin', { id: $('as-id').value.trim(), password: $('as-pass').value });
      save(d);
      modal.classList.add('hidden');
    } catch (e) { $('as-status').textContent = e.message; }
  };

  let otpSent = false;
  $('au-go').onclick = async () => {
    if (!otpSent) {
      $('au-status').textContent = 'Sending OTP…';
      try {
        await api('/api/signup/begin', {
          name: $('au-name').value.trim(),
          username: $('au-user').value.trim(),
          email: $('au-email').value.trim(),
          password: $('au-pass').value,
        });
        otpSent = true;
        $('au-otp-block').classList.remove('hidden');
        $('au-go').textContent = 'Verify & create';
        $('au-status').textContent = 'OTP sent to your Gmail.';
      } catch (e) { $('au-status').textContent = e.message; }
    } else {
      $('au-status').textContent = 'Verifying…';
      try {
        const d = await api('/api/signup/verify', { email: $('au-email').value.trim(), otp: $('au-otp').value.trim() });
        save(d);
        modal.classList.add('hidden');
      } catch (e) { $('au-status').textContent = e.message; }
    }
  };

  // ---- header render ----
  const listeners = [];
  function render() {
    const box = document.querySelector('.header-actions');
    if (!box) return;
    const s = sess();
    if (s && s.token && s.user) {
      box.innerHTML = `<span class="hi-user">Hi, ${s.user.name || s.user.username}!</span><button class="btn ghost" id="btn-signout">Sign out</button>`;
      $('btn-signout').onclick = clear;
    } else {
      box.innerHTML = `<button class="btn ghost" id="btn-signin">Sign in</button><button class="btn primary" id="btn-signup">Sign up</button>`;
      $('btn-signin').onclick = () => show('in');
      $('btn-signup').onclick = () => show('up');
    }
    listeners.forEach((cb) => cb(s));
  }

  window.sfAuth = {
    session: sess,
    token: () => sess()?.token || null,
    user: () => sess()?.user || null,
    onchange: (cb) => listeners.push(cb),
    api,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
