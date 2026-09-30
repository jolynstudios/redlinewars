// Test the existing, packaged app through visible controls. This never builds.
// Run after shared gates, the source commit and desktop/package.mjs:
// node desktop/tools/packaged-uigate.mjs [path/to/Redline Wars.app]
// PACKAGED_UI_OUTPUT selects the evidence directory; timeout defaults to 10 min.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'web/package.json'));
const { _electron } = require('playwright');
const appPath = path.resolve(process.argv[2] ?? path.join(root, 'desktop/dist/mac-arm64/Redline Wars.app'));
const executablePath = appPath.endsWith('.app') ? path.join(appPath, 'Contents/MacOS/Redline Wars') : appPath;
const resources = appPath.endsWith('.app') ? path.join(appPath, 'Contents/Resources') : path.join(path.dirname(appPath), 'resources');
assert(fs.existsSync(executablePath), `packaged executable missing: ${executablePath}`);
const build = JSON.parse(fs.readFileSync(path.join(resources, 'AppBundle/steelseed/build.json'), 'utf8'));
const sharedBuild = JSON.parse(fs.readFileSync(path.join(root, 'engine/bin-browser/AppBundle/steelseed/build.json'), 'utf8'));
assert(build.simBuild === sharedBuild.simBuild && build.modHash === sharedBuild.modHash, 'packaged app differs from the tested shared AppBundle');
const output = path.resolve(process.env.PACKAGED_UI_OUTPUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'redline-packaged-ui-evidence-')));
fs.mkdirSync(output, { recursive: true });
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'redline-packaged-ui-profile-')));
const report = { status: 'running', appPath, build, profile, checks: [], screenshots: [], rendererErrors: [], console: [], blockedRenderer: [], mainFetch: [], cleanup: {} };
const timeout = Number(process.env.PACKAGED_UI_TIMEOUT ?? 600_000);
assert(Number.isFinite(timeout) && timeout >= 120_000 && timeout <= 1_800_000, 'timeout must be between 2 and 30 minutes');
let electron;
let watchdog;
let childWatcher;
let closed = false;
const ownedPids = new Map(); // PID -> birth time, so a reused PID is never killed.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const loopback = url => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
const fixture = http.createServer((request, response) => {
  response.setHeader('access-control-allow-origin', request.headers.origin ?? '*');
  response.setHeader('access-control-allow-credentials', 'true');
  response.setHeader('access-control-allow-headers', 'content-type,authorization');
  response.setHeader('content-type', 'application/json');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  const url = new URL(request.url, 'http://localhost');
  const body = url.pathname === '/v2/config' ? { acceptedBuilds: [build.simBuild], capacity: { own: 0, donated: 0 } }
    : url.pathname === '/v2/rooms' ? { rooms: [] }
    : url.pathname === '/api/me' ? { user: null }
    : null;
  response.writeHead(body === null ? 404 : 200);
  response.end(JSON.stringify(body ?? { error: 'local fixture: unavailable' }));
});

async function until(fn, label, ms = 60_000) {
  const end = Date.now() + ms;
  let last;
  while (!closed && Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timeout: ${label}; last=${JSON.stringify(last)}`);
}
async function check(name, fn) {
  const start = Date.now();
  const evidence = await fn();
  report.checks.push({ name, status: 'passed', milliseconds: Date.now() - start, evidence });
  console.log(`PASS ${name}`);
}
async function pageFor(predicate, label) {
  return until(() => electron.windows().find(page => !page.isClosed() && predicate(page.url())), label);
}
async function focus(page) {
  const win = await electron.browserWindow(page);
  await win.evaluate(window => { window.show(); window.focus(); });
  await win.dispose();
  await page.bringToFront();
}
async function capture(page, name, world = false) {
  await focus(page);
  // Let the shell/dialog CSS hand-off settle before a native window capture.
  await sleep(450);
  const win = await electron.browserWindow(page);
  const result = await win.evaluate(async (window, cropWorld) => {
    let rect;
    if (cropWorld) rect = await window.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector('#viewport');
      if (!canvas) throw new Error('world canvas missing');
      const r = canvas.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.floor(r.width), height: Math.floor(r.height) };
    })()`);
    const image = await window.webContents.capturePage(rect);
    const pixels = image.toBitmap();
    const count = pixels.length / 4;
    let lit = 0, samples = 0;
    const buckets = new Set();
    for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 4096))) {
      samples++;
      if (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2] > 30) lit++;
      buckets.add(`${pixels[i * 4] >> 3},${pixels[i * 4 + 1] >> 3},${pixels[i * 4 + 2] >> 3}`);
    }
    return { size: image.getSize(), nonBlack: samples ? lit / samples : 0, buckets: buckets.size, png: image.toPNG().toString('base64') };
  }, world);
  await win.dispose();
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(result.png, 'base64'));
  report.screenshots.push({ name, size: result.size, nonBlack: result.nonBlack, buckets: result.buckets, method: 'webContents.capturePage', world });
  // The credits overlay deliberately dims most of this dark landing. Pixel
  // variation proves it rendered; a majority-bright rule rejects valid sheets.
  assert(result.size.width > 0 && result.size.height > 0 && result.buckets >= 8 && result.nonBlack > (world ? 0.5 : 0.1), `blank capture ${name}: ${JSON.stringify({ ...result, png: undefined })}`);
}
function watch(page) {
  page.on('pageerror', error => report.rendererErrors.push({ url: page.url(), error: String(error) }));
  page.on('console', message => { if (report.console.length < 200) report.console.push({ type: message.type(), text: message.text().slice(0, 700) }); });
}
async function lobby(page) {
  return page.evaluate(async () => JSON.parse(await globalThis.ora.GetLobbySnapshotProbe() || 'null'));
}
const local = snapshot => snapshot?.clients.find(client => client.index === snapshot.localClientIndex);
const action = (page, name) => page.locator('#mp-setup .mp-lobby-actions').getByRole('button', { name, exact: true });
async function match(page, network) {
  await page.waitForFunction(() => globalThis.steelseed?.ctx.snapshot?.actors?.count > 0 && document.querySelector('#session-ui')?.hidden === true && document.querySelector('#game-ui')?.hidden === false, undefined, { timeout: 120_000 });
  const initial = await page.evaluate(() => globalThis.steelseed.ctx.snapshot.tick);
  await page.waitForFunction(({ initial, network }) => globalThis.steelseed.ctx.snapshot.tick >= initial + 50 && (!network || globalThis.steelseed.ctx.get('ui')?.mpPhase === 'playing'), { initial, network }, { timeout: 90_000 });
  if (network) await until(async () => {
    const probe = await page.evaluate(() => globalThis.ora.GetConnectionProbe());
    assert(!/outofsync=True/.test(probe), `desync while awaiting network frames: ${probe}`);
    return /started=True/.test(probe) && Number(/netframe=(\d+)/.exec(probe)?.[1] ?? 0) >= 50;
  }, 'fifty authoritative network frames', 90_000);
  const truth = await page.evaluate(async () => ({ tick: globalThis.steelseed.ctx.snapshot.tick, actors: globalThis.steelseed.ctx.snapshot.actors.count, probe: await globalThis.ora.GetConnectionProbe() }));
  assert(!/outofsync=True/.test(truth.probe), `desync: ${truth.probe}`);
  if (network) assert(/started=True/.test(truth.probe) && Number(/netframe=(\d+)/.exec(truth.probe)?.[1] ?? 0) >= 50, `network match did not advance: ${truth.probe}`);
  return { initialTick: initial, ...truth };
}
function processRows() {
  const lines = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,lstart='], { encoding: 'utf8' }).trim().split('\n');
  return new Map(lines.map(line => {
    const parts = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    assert(parts, `unexpected ps row: ${line}`);
    return [Number(parts[1]), { ppid: Number(parts[2]), state: parts[3], birth: parts[4] }];
  }));
}
function rememberChildren() {
  if (!electron?.process()?.pid) return;
  const rows = processRows();
  const rootPid = electron.process().pid;
  if (!ownedPids.has(rootPid) && electron.process().exitCode == null && rows.has(rootPid)) ownedPids.set(rootPid, rows.get(rootPid).birth);
  let found;
  do {
    found = false;
    for (const [pid, row] of rows) {
      const parent = rows.get(row.ppid);
      if (parent && ownedPids.get(row.ppid) === parent.birth && !ownedPids.has(pid)) { ownedPids.set(pid, row.birth); found = true; }
    }
  } while (found);
}
async function run() {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  // Multiplayer starts off: no hardcoded public players-tile poll can run before
  // the main-process guard is installed. Only this disposable profile is written.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ multiplayer: false, music: false, quality: 'default', mpDir: origin, spineUrl: origin.replace('http:', 'ws:') + '/node', donate: { enabled: false, maxMatches: 1, consentSeen: false } }));
  const env = { ...process.env, REDLINE_ACCOUNT_ORIGIN: origin };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.SELFTEST_MP;
  delete env.SELFTEST_WALK;
  delete env.SELFTEST_GPU;
  electron = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`, '--disable-background-networking'], env, timeout: 45_000 });
  rememberChildren();
  childWatcher = setInterval(rememberChildren, 1000);
  const actual = await electron.evaluate(({ app }) => ({ userData: app.getPath('userData'), packaged: app.isPackaged, lock: app.hasSingleInstanceLock() }));
  assert(actual.packaged, 'gate requires the real packaged app');
  assert(fs.realpathSync(actual.userData) === profile, `isolation failed: actual userData=${actual.userData}, expected=${profile}; refusing all UI actions`);
  assert(actual.lock, 'isolated app did not acquire its own instance lock');
  report.isolation = actual;
  // Browser routes cannot intercept Node fetch in Electron main. A test-only
  // guard prevents the hardcoded room-count poll from reaching public services.
  await electron.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.__packagedUiFetch = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      const allowed = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      globalThis.__packagedUiFetch.push({ url: url.href, allowed });
      if (!allowed) return new Response('{"rooms":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      return original(input, init);
    };
  });
  const context = electron.context();
  context.setDefaultTimeout(30_000);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.pathname.endsWith('/net-config.json')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schema: 1, browserMultiplayer: 'full', relay: origin, accountOrigin: origin, companionEnabled: false }) });
    if (url.pathname === '/api/me') return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': route.request().headers().origin ?? '*', 'access-control-allow-credentials': 'true' }, body: '{"user":null}' });
    if (!loopback(url)) { report.blockedRenderer.push(url.href); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  for (const page of electron.windows()) watch(page);
  electron.on('window', watch);
  let landing = await pageFor(url => url.startsWith('file:') && url.includes('landing.html'), 'landing window');
  await landing.waitForLoadState('domcontentloaded');
  await focus(landing);
  await landing.keyboard.press('Space');
  await landing.locator('#intro').waitFor({ state: 'hidden' });
  await check('isolated packaged landing keyboard, focus and resizing', async () => {
    await landing.locator('#credits-open').focus();
    await landing.keyboard.press('Enter');
    await landing.locator('#credits-sheet').waitFor({ state: 'visible' });
    // Visibility changes synchronously; the overlay's normal initial focus is
    // assigned on the next animation frame. Observe it rather than forcing it.
    report.focus = { immediatelyVisible: await landing.evaluate(() => document.activeElement?.id) };
    await landing.waitForFunction(() => document.activeElement === document.querySelector('#credits-close'), undefined, { timeout: 5000 });
    const focusables = await landing.locator('#credits-sheet').evaluate(sheet => [...sheet.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(el => el.getClientRects().length).length);
    assert(focusables > 1, 'credits focus controls missing');
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 0; i < focusables; i++) {
        await landing.keyboard.press(key);
        assert(await landing.evaluate(() => document.querySelector('#credits-sheet').contains(document.activeElement)), `credits lost trapped focus on ${key}`);
      }
      assert(await landing.evaluate(() => document.activeElement === document.querySelector('#credits-close')), `credits did not wrap on ${key}`);
    }
    report.focus.controls = focusables;
    await capture(landing, '00-credits-keyboard');
    await landing.keyboard.press('Escape');
    await landing.locator('#credits-sheet').waitFor({ state: 'hidden' });
    assert(await landing.locator('#credits-open').evaluate(el => el === document.activeElement), 'credits did not restore focus');
    for (const [width, height] of [[980, 700], [1440, 950]]) {
      const win = await electron.browserWindow(landing);
      await win.evaluate((window, size) => window.setSize(...size), [width, height]);
      await win.dispose();
      await landing.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await capture(landing, `landing-${width}x${height}`);
    }
    await landing.locator('#mp-switch [data-mp="off"]').focus();
    await landing.keyboard.press('ArrowRight');
    await until(() => landing.locator('#mp-switch [data-mp="on"]').getAttribute('aria-checked').then(v => v === 'true'), 'multiplayer switch');
    await until(() => landing.locator('#start-multiplayer').isEnabled(), 'engine preloaded', 240_000);
  });
  const game = await pageFor(url => url.includes('/steelseed/index.html'), 'shared game window');
  await check('visible LAN Host dialog creates one human plus AI and advances gameplay', async () => {
    await landing.click('#host-game');
    await focus(game);
    await game.locator('#session-mp-panel').waitFor({ state: 'visible' });
    await game.fill('#session-mp-name', 'Packaged UI Host');
    await game.selectOption('#session-mp-slots', '2');
    await game.locator('#session-mp-spectate').uncheck();
    await game.click('#session-mp-host');
    await game.locator('#mp-host-dialog').waitFor({ state: 'visible' });
    await game.locator('#mp-host-vis-lan').check();
    await game.selectOption('#mp-host-players', '2');
    await game.click('#mp-host-create');
    await game.locator('#mp-setup').waitFor({ state: 'visible', timeout: 90_000 });
    await until(async () => local(await lobby(game))?.slot != null, 'host has playing seat');
    await action(game, 'Add AI').click();
    await until(async () => (await lobby(game))?.clients.some(client => client.bot), 'AI present');
    await capture(game, 'host-lobby');
    await action(game, 'Ready').click();
    // OpenRA may auto-start a full human/AI lobby on Ready. Optional-seat
    // lobbies expose Start instead; use the visible button only while still open.
    const ready = await until(async () => {
      const state = await lobby(game);
      return state?.started || state?.startAllowed ? state : false;
    }, 'ready human and AI allow the match');
    let startPath = 'auto-start on Ready';
    if (!ready.started) {
      if (await action(game, 'Start match').isVisible() && await action(game, 'Start match').isEnabled()) {
        await action(game, 'Start match').click();
        startPath = 'Start match button';
      } else await until(async () => (await lobby(game))?.started, 'engine auto-start after Ready');
    }
    const truth = await match(game, true);
    await capture(game, 'multiplayer-match', true);
    rememberChildren();
    return { startPath, ...truth };
  });
  await check('visible Menu returns to landing and Skirmish starts afterward', async () => {
    await game.click('#hud-menu');
    await game.locator('#game-menu').waitFor({ state: 'visible' });
    await game.click('#menu-main');
    landing = await pageFor(url => url.startsWith('file:') && url.includes('landing.html'), 'returned landing');
    await focus(landing);
    await until(async () => !/state=Connected/.test(await game.evaluate(() => globalThis.ora.GetConnectionProbe())), 'Main leaves the previous network connection');
    assert(await game.locator('#game-menu').isHidden(), 'old game menu survived Return Main');
    await until(() => landing.locator('#start-skirmish').isEnabled(), 'skirmish engine ready', 240_000);
    await landing.click('#start-skirmish');
    await focus(game);
    await game.locator('#session-skirmish-panel').waitFor({ state: 'visible' });
    await until(() => game.locator('#session-start').isEnabled(), 'skirmish start enabled');
    await game.click('#session-start');
    const truth = await match(game, false);
    assert(await game.locator('#game-menu').isHidden(), 'old game menu covered new Skirmish');
    await capture(game, 'skirmish-after-multiplayer', true);
    await game.click('#hud-menu');
    await game.keyboard.press('Escape');
    await game.locator('#game-menu').waitFor({ state: 'hidden' });
    return truth;
  });
  report.mainFetch = await electron.evaluate(() => globalThis.__packagedUiFetch);
  assert(report.rendererErrors.length === 0, `renderer errors: ${JSON.stringify(report.rendererErrors)}`);
  report.status = 'passed';
}

try {
  await Promise.race([run(), new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(`packaged UI gate exceeded ${timeout}ms`)), timeout); })]);
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  clearInterval(childWatcher);
  closed = true;
  rememberChildren();
  if (electron) {
    try {
      // Leave the active game through the real UI before closing so the normal
      // hosting quit guard can complete without a native confirmation modal.
      const game = electron.windows().find(page => page.url().includes('/steelseed/index.html'));
      if (game && !game.isClosed() && await game.locator('#hud-menu').isVisible()) {
        await game.click('#hud-menu', { timeout: 3000 });
        await game.click('#menu-main', { timeout: 3000 });
        await sleep(2000);
      }
    } catch { /* failed pages are cleaned through their owned process tree */ }
    try { await Promise.race([electron.close(), sleep(10_000).then(() => { throw new Error('app close timeout'); })]); report.cleanup.normalClose = true; }
    catch (error) { report.cleanup.normalClose = false; report.cleanup.closeError = String(error); }
  }
  const alive = pid => {
    const row = processRows().get(pid);
    return row?.birth === ownedPids.get(pid) && !row.state.startsWith('Z');
  };
  const remaining = [...ownedPids.keys()].filter(alive);
  report.cleanup.forcedOwnedPids = remaining;
  for (const pid of remaining.reverse()) if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  if (remaining.length) await sleep(1000);
  for (const pid of remaining) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  report.cleanup.survivors = [...ownedPids.keys()].filter(alive);
  if (report.cleanup.survivors.length || remaining.length) { report.status = 'failed'; process.exitCode = 1; }
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
  report.cleanup.profileRemoved = !fs.existsSync(profile);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`packaged-uigate: ${report.status}; evidence ${output}`);
}
