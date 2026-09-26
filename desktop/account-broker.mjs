// Main-process-only account broker. No bearer token or password is returned to
// the renderer; callers receive profile/status JSON and allowlisted API data.

export const ACCOUNT_REQUEST_PATHS = new Set([
  '/api/me', '/api/me/profile', '/api/leaderboard',
  '/api/auth/logout', '/api/auth/verify-email/resend', '/api/ranked/queue',
  // A finished skirmish's report. Without it no desktop match ever reached the leaderboard:
  // the renderer has no browser session, and this broker is the only authenticated path.
  '/api/matches',
]);
const RANKED_SETTLEMENT_PATH = /^\/api\/ranked\/settlement\?matchId=[A-Za-z0-9_.:-]{6,128}$/;
const AVATAR_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_AVATAR_BYTES = 1024 * 1024;

export function createAccountBroker({ origin, fetchImpl = fetch, openExternal, storage, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let bearer = null;
  const load = () => {
    if (bearer) return bearer;
    bearer = storage.load() || null;
    return bearer;
  };
  const store = token => {
    storage.store(token);
    bearer = token;
  };
  const clear = () => {
    bearer = null;
    storage.clear();
  };
  async function http(pathname, { method = 'GET', body, authenticated = true, multipart = false } = {}) {
    const headers = { accept: 'application/json' };
    if (pathname === '/api/auth/device/start') headers['x-client'] = 'desktop';
    if (authenticated && load()) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined && !multipart) headers['content-type'] = 'application/json';
    const response = await fetchImpl(new URL(pathname, origin), {
      method,
      headers,
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }
  async function scopedRequest(pathname, method = 'GET', body) {
    if (!ACCOUNT_REQUEST_PATHS.has(pathname) && !RANKED_SETTLEMENT_PATH.test(pathname)) throw new Error('Account request is outside the desktop allowlist.');
    if (!load()) throw new Error('Not signed in.');
    const { response, data } = await http(pathname, { method, body });
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Account request failed (${response.status}).`);
    return data;
  }
  async function avatarUpload({ bytes, mime, name } = {}) {
    if (!load()) throw new Error('Not signed in.');
    const contentType = typeof mime === 'string' ? mime.trim().toLowerCase() : '';
    if (!AVATAR_MIMES.has(contentType)) throw new Error('Avatar must be a PNG, JPEG, or WebP image.');
    let view;
    if (bytes instanceof Uint8Array) view = bytes;
    else if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
    else if (ArrayBuffer.isView(bytes)) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else throw new Error('Avatar data is invalid.');
    if (view.byteLength === 0 || view.byteLength > MAX_AVATAR_BYTES) throw new Error('Avatar must be 1 MiB or smaller.');
    const safeName = typeof name === 'string' ? name.replace(/[\\/\0]/g, '_').slice(0, 80) || 'avatar' : 'avatar';
    const form = new FormData();
    form.append('avatar', new Blob([view], { type: contentType }), safeName);
    const { response, data } = await http('/api/me/avatar', { method: 'POST', body: form, multipart: true });
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? `${data.error} (${response.status})` : `Avatar upload failed (${response.status}).`);
    return data;
  }
  async function status() {
    if (!load()) return { authenticated: false, user: null };
    try {
      const data = await scopedRequest('/api/me/profile');
      return { authenticated: Boolean(data?.user), user: data?.user ?? null, profile: data?.profile ?? null };
    } catch { return { authenticated: false, user: null }; }
  }
  async function deviceLogin({ onChallenge } = {}) {
    const started = await http('/api/auth/device/start', { method: 'POST', body: { clientId: 'redline-wars-desktop' }, authenticated: false });
    if (!started.response.ok) throw new Error(typeof started.data?.error === 'string' ? started.data.error : `Could not start device login (${started.response.status}).`);
    const deviceCode = typeof started.data?.deviceCode === 'string' ? started.data.deviceCode : '';
    const userCode = typeof started.data?.userCode === 'string' ? started.data.userCode.trim().toUpperCase() : '';
    // The plain page, without the code: the player types the code this app
    // shows, so a forwarded link can never approve somebody else's desktop.
    const verificationUri = typeof started.data?.verificationUri === 'string' ? started.data.verificationUri : '';
    if (!deviceCode || !/^[A-Z0-9]{8}$/.test(userCode) || !verificationUri) throw new Error('The account service returned an incomplete device-login challenge.');
    const verification = new URL(verificationUri);
    if (verification.protocol !== 'https:') throw new Error('The verification link was refused because it was not HTTPS.');
    const expiry = Date.parse(String(started.data?.expiresAt ?? ''));
    const deadline = Number.isFinite(expiry) ? expiry : Date.now() + 600_000;
    // Only the code the player must type reaches the UI, never deviceCode.
    onChallenge?.({ userCode, expiresAt: deadline });
    await openExternal(verification.toString());
    let interval = Math.max(1000, Number(started.data?.interval ?? 5) * 1000);
    while (Date.now() < deadline) {
      await sleep(interval);
      const polled = await http('/api/auth/device/token', { method: 'POST', body: { deviceCode }, authenticated: false });
      const accessToken = polled.data?.accessToken ?? polled.data?.access_token;
      if (polled.response.ok && typeof accessToken === 'string') {
        store(accessToken);
        return status();
      }
      if (polled.data?.pending === true || polled.data?.error === 'authorization_pending') {
        if (Number.isFinite(Number(polled.data?.interval))) interval = Math.max(1000, Number(polled.data.interval) * 1000);
        continue;
      }
      if (polled.data?.error === 'slow_down') { interval += 5000; continue; }
      throw new Error(typeof polled.data?.error === 'string' ? polled.data.error : `Device login failed (${polled.response.status}).`);
    }
    throw new Error('Device login expired. Start again when you are ready.');
  }
  async function logout() {
    try {
      if (load()) await http('/api/auth/device/revoke', { method: 'POST', body: {} });
    } finally { clear(); }
    return { ok: true };
  }
  return { status, deviceLogin, scopedRequest, avatarUpload, logout };
}
