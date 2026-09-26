import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountBroker } from './account-broker.mjs';

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('desktop device login polls pending, stores encrypted-side token, survives restart, and revokes', async () => {
  const accessToken = 'desktop-access-token-123456789';
  const deviceCode = 'device-code-123456789';
  const verificationUri = 'https://www.redlinewars.online/auth/device';
  const userCode = 'ABCDEFGH';
  let storedToken = null;
  let claimed = false;
  let tokenPolls = 0;
  const opened = [];
  const requests = [];
  const storage = {
    load: () => storedToken,
    store: token => { storedToken = token; },
    clear: () => { storedToken = null; },
  };
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    requests.push({ pathname, method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (pathname === '/api/auth/device/start') {
      assert.equal(headers['x-client'], 'desktop');
      assert.equal(headers.authorization, undefined);
      return response(200, { deviceCode, userCode, verificationUri, verificationUriComplete: `${verificationUri}?user_code=${userCode}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), interval: 0 });
    }
    if (pathname === '/api/auth/device/token') {
      assert.equal(headers.authorization, undefined);
      tokenPolls += 1;
      return tokenPolls === 1
        ? response(428, { pending: true, interval: 0 })
        : response(200, { accessToken, claimed });
    }
    if (pathname === '/api/me/profile') {
      assert.equal(headers.authorization, `Bearer ${accessToken}`);
      return response(200, {
        user: { id: 'u1', callsign: 'DeviceOwner', kind: 'account' },
        profile: { username: 'device-owner', email: 'owner@example.test', emailVerified: true },
      });
    }
    if (pathname === '/api/auth/device/revoke') {
      assert.equal(headers.authorization, `Bearer ${accessToken}`);
      return response(200, { ok: true });
    }
    throw new Error(`unexpected request ${pathname}`);
  };
  const broker = createAccountBroker({
    origin: 'https://www.redlinewars.online',
    fetchImpl,
    openExternal: async url => { opened.push(url); },
    storage,
    sleep: async () => { claimed = true; },
  });

  const challenges = [];
  const signedIn = await broker.deviceLogin({ onChallenge: challenge => challenges.push({ ...challenge, openedBefore: opened.length }) });
  assert.deepEqual(signedIn.user, { id: 'u1', callsign: 'DeviceOwner', kind: 'account' });
  assert.equal(signedIn.profile.username, 'device-owner');
  assert.equal(signedIn.authenticated, true);
  assert.deepEqual(opened, [verificationUri]);
  // The code is shown in the app before the browser opens, and the opened page never carries it.
  assert.deepEqual(challenges.map(({ userCode: code, openedBefore }) => ({ code, openedBefore })), [{ code: userCode, openedBefore: 0 }]);
  assert.equal(opened.some(url => url.includes(userCode)), false);
  assert.equal(Object.hasOwn(challenges[0], 'deviceCode'), false);
  assert.equal(storedToken, accessToken);
  assert.equal(tokenPolls, 2);
  assert.equal(opened.some(url => url.includes(accessToken)), false);

  // A fresh broker instance must use the encrypted-store abstraction rather
  // than requiring another device challenge after app restart.
  const restarted = createAccountBroker({ origin: 'https://www.redlinewars.online', fetchImpl, openExternal: async () => {}, storage });
  assert.equal((await restarted.status()).authenticated, true);
  await restarted.logout();
  assert.equal(storedToken, null);

  const afterLogout = createAccountBroker({ origin: 'https://www.redlinewars.online', fetchImpl, openExternal: async () => {}, storage });
  assert.equal((await afterLogout.status()).authenticated, false);
  assert.equal(requests.filter(request => request.pathname === '/api/auth/device/revoke').length, 1);
});

test('desktop broker keeps revoke and avatar upload outside the renderer allowlist', async () => {
  let avatarRequest = null;
  const broker = createAccountBroker({
    origin: 'https://www.redlinewars.online',
    fetchImpl: async (url, init) => {
      avatarRequest = { url: new URL(url).pathname, headers: init.headers, body: init.body };
      return response(200, { user: { callsign: 'Owner', avatarUrl: '/api/avatars/u1.webp' } });
    },
    openExternal: async () => {},
    storage: { load: () => 'stored-access-token-123456', store: () => {}, clear: () => {} },
  });
  const avatar = await broker.avatarUpload({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/webp', name: 'pilot.webp' });
  assert.equal(avatar.user.callsign, 'Owner');
  assert.equal(avatarRequest.url, '/api/me/avatar');
  assert.equal(avatarRequest.headers.authorization, 'Bearer stored-access-token-123456');
  assert.equal(avatarRequest.headers['content-type'], undefined);
  assert.equal(avatarRequest.body instanceof FormData, true);
  assert.equal(avatarRequest.body.get('avatar').name, 'pilot.webp');
  await broker.scopedRequest('/api/ranked/queue');
  await broker.scopedRequest('/api/ranked/settlement?matchId=match-1');
  await broker.scopedRequest('/api/matches', 'POST', { matchId: 'sk-desktop-1' });
  await assert.rejects(() => broker.scopedRequest('/api/matches/mine'), /outside the desktop allowlist/);
  await assert.rejects(() => broker.scopedRequest('/api/ranked/settlements/match-1'), /outside the desktop allowlist/);
  await assert.rejects(() => broker.avatarUpload({ bytes: new Uint8Array([1]), mime: 'image/svg+xml', name: 'x.svg' }), /PNG, JPEG, or WebP/);
  await assert.rejects(() => broker.avatarUpload({ bytes: new Uint8Array(1024 * 1024 + 1), mime: 'image/png', name: 'x.png' }), /1 MiB/);
  await assert.rejects(() => broker.scopedRequest('/api/auth/device/revoke', 'POST', {}), /outside the desktop allowlist/);
  await assert.rejects(() => broker.scopedRequest('/api/me/avatar', 'POST', {}), /outside the desktop allowlist/);
});
