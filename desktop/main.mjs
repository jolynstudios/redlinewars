import { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain, powerSaveBlocker, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSettings, saveSettings, settingsFile } from './settings.mjs';
import { nodeRefusalNeedsDownload, shellVerdict } from './update-gate.mjs';
import { createAccountBroker } from './account-broker.mjs';
import {
  donateHostingEnabled,
  donateConfig,
  withDonateConfig,
  rendererDonatePatch,
  donateConsentCurrent,
  DONATE_CONSENT_VERSION,
  donateNodeArgs,
  keepsNodeForEmptyRooms,
	nodeModeCanSwitch,
  S24_DONATE_CONFIRMATION,
} from './donate-hosting.mjs';
import {
  LEGAL_LONG,
  LEGAL_SHORT,
  LEGAL_TEXT_MAX_BYTES,
  legalDocPath,
  landingQuery,
  multiplayerEnabled,
  withMultiplayer,
  websitePage,
  qualityParam,
} from './shell-options.mjs';
// T3.13.6: Linux needs these until its drivers pass the standard WebGPU path.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('enable-features', 'Vulkan');
  // Some Linux Chromium builds conservatively block WebGPU/WebGL2 even when
  // the installed Mesa/NVIDIA driver is usable. This opts into the GPU path;
  // it never disables acceleration or falls back to software rendering.
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
}


const SELFTEST = process.argv.includes('--selftest');
const HEADLESS = process.argv.includes('--headless');
// T3.21.1: the result lands in the OS temp dir (a literal /tmp does not
// exist on Windows) and SELFTEST_GPU=0 selects the VM/adapter-less mode:
// readiness is the sim bridge, the render check and the UI walk are
// skipped, and the verdict rests on the multiplayer flow.
const SELFTEST_PATH = path.join(os.tmpdir(), 'electron-selftest.json');
const SELFTEST_GPU_OFF = process.env.SELFTEST_GPU === '0';
// Multiplayer: the room directory + ws mux on the local node (LAN hosting),
// the map uid the committed mp gate verified with two browser clients, and
// the public relay that internet-play lists rooms on.
const RELAY_DIR = 'https://play.redlinewars.online';
let MP_MUX_PORT = 14710;
let MP_HTTP_PORT = 14711;
let nodeKey = null;      // the per-install node API key (§5.3, <userData>/node/node.key)
let hostingEngineRoot = null; // where the running node's mod catalog lives
// The local node (T3.2): spawned on demand by host-start, never at launch.
let nodeChild = null;
let nodeStarting = false;
let nodeWatchTimer = null;
let emptyHealthPolls = 0;
let lastNodeHealth = null;   // last /v2/health body — the quit guard reads it
let playBlockerId = null;    // powerSaveBlocker while a hosted room is playing
let lanListenerChild = null; // T3.6: the discovery listener, child of the shell
let nodeMode = null;          // 'own' or 'donate'; one assembled node at a time
let donateStarting = false;
let donateStartPromise = null;
let donateError = null;
let donateTray = null;
let donateDraining = false;
let donateRestartAfterDrain = false;
let nodePlaying = false;
// T3.10: the relay's accepted-builds gate for online play.
let updateRequired = null;   // { downloadUrl, own, accepted } once required
let updateMemo = { at: 0, state: null };
const DOWNLOAD_HOSTS = new Set(['www.redlinewars.online', 'redlinewars.online']);
let quitConfirmed = false;
const WEBSITE_URL = 'https://www.redlinewars.online';
const ACCOUNT_API_ORIGIN = process.env.REDLINE_ACCOUNT_ORIGIN || WEBSITE_URL;
const ACCOUNT_TOKEN_FILE = 'account-token.bin';
let accountBearer = null;

const isPackaged = app.isPackaged;
const appBundleDir = isPackaged
  ? path.join(process.resourcesPath, 'AppBundle')
  : path.resolve(import.meta.dirname, '../engine/bin-browser/AppBundle');
const serverScript = isPackaged
  ? path.join(process.resourcesPath, 'server.mjs')
  : path.resolve(import.meta.dirname, '../engine/OpenRA.Browser/tests/server.mjs');
// §3.1: licence texts — resources/legal/ when packaged, the repo files otherwise.
const legalRoots = () => ({
  packaged: isPackaged,
  resourcesPath: process.resourcesPath,
  repoRoot: path.resolve(import.meta.dirname, '..'),
});

// §3.3: the landing's Multiplayer switch (default on; --selftest and
// --headless force it on). Read per call: the landing may flip it any time.
function mpOn() {
  return multiplayerEnabled(loadSettings(), { selftest: SELFTEST, headless: HEADLESS });
}

// One instance only: a second launch focuses the running window and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let serverChild = null;
let landingWin = null;
let gameWin = null;
let lastPort = 18077;
let lastMusicUrl = '';
// §3.2: what the landing shows, remembered so a rebuilt landing (back to the
// menu, the tray) replays it instead of starting at 0 % with default tiles.
const landingState = { loader: 'laden', pct: 0, stage: '', players: null };
let selftestLog = [];
let rendererCapability = null;
let electronGpuDiagnostics = null;


// Menu dispatchers: the mac menu lives at module scope but the actions are
// wired inside boot() (the existing startGameFn pattern).
let startGameFn = null;
let startMpFn = null;
let backToMainMenuFn = null;
let toggleMusicFn = null;
let applyQualityFn = null;
process.on('uncaughtException', err => {
  const text = String(err?.stack || err?.message || err);
  console.error('[uncaught] ' + text);
  selftestLog.push('[uncaught] ' + text.slice(0, 260));
});

// The selftest never lets a modal block the run: every box auto-confirms.
if (SELFTEST) dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });

app.on('second-instance', () => {
  const top = gameWin && !gameWin.isDestroyed() ? gameWin : landingWin;
  if (top && !top.isDestroyed()) {
    if (top.isMinimized()) top.restore();
    top.focus();
  }
});

function killServer() {
  if (serverChild) {
    serverChild.kill();
    serverChild = null;
  }
}

async function collectElectronGpuDiagnostics() {
  let featureStatus = null;
  let completeInfo = null;
  try { featureStatus = app.getGPUFeatureStatus(); } catch (error) { featureStatus = { error: String(error?.message || error) }; }
  try { completeInfo = await app.getGPUInfo('complete'); } catch (error) { completeInfo = { error: String(error?.message || error) }; }
  return { featureStatus, completeInfo };
}

async function probeRendererCapability(win) {
  if (!win || win.isDestroyed()) return { ok: false, webgpu: false, webgl2: false, error: 'game window unavailable' };
  try {
    return await win.webContents.executeJavaScript(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      let webgl2 = false;
      try {
        const gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' });
        webgl2 = !!gl && gl.isContextLost() === false && typeof gl.getParameter(gl.VERSION) === 'string';
      } catch {}
      let webgpu = false;
      let adapter = null;
      let device = null;
      try {
        const gpu = navigator.gpu;
        adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
        device = adapter ? await adapter.requestDevice() : null;
        webgpu = !!device;
      } catch {}
      try { device?.destroy?.(); } catch {}
      return {
        ok: webgpu || webgl2,
        webgpu,
        webgl2,
        userAgent: navigator.userAgent,
        canvas: { width: canvas.width, height: canvas.height },
        adapter: adapter ? { name: adapter.info?.description || adapter.info?.device || '' } : null,
      };
    })()`);
  } catch (error) {
    return { ok: false, webgpu: false, webgl2: false, error: String(error?.message || error) };
  }
}

function selftestResult(pass, ms, externalHosts, nonBlackRatio, gpu = rendererCapability) {
  // T3.21.2: "gpu": false marks the adapter-less run in the result JSON.
  return { pass, ms, externalHosts, nonBlackRatio, gpu: !SELFTEST_GPU_OFF, gpuCapability: gpu, electronGpu: electronGpuDiagnostics };
}

let selftestEmitted = false;
let selftestFinished = false;

function emitSelftest(result, exitCode) {
  if (selftestEmitted) return;
  selftestEmitted = true;
  try {
    fs.writeFileSync(SELFTEST_PATH, JSON.stringify(result));
  } catch {
    // The console line below is the contract; the file is best-effort.
  }
  result.log = selftestLog;
  console.log('ELECTRON-SELFTEST ' + JSON.stringify(result));
  killServer();
  void stopNode();
  stopLanListener();
  app.exit(exitCode);
  // app.exit can hang on in-flight navigations; make the selftest exit certain.
  setTimeout(() => process.exit(exitCode), 1500);
}

function failSelftest() {
  emitSelftest(selftestResult(false, -1, [], 0), 1);
}

// T3.21.3: the dedicated servers are `OpenRA.Server[.exe]` (self-contained
// apphost) or `<dotnet> … OpenRA.Server.dll` — both match on the command
// line. Set of pids (win32: CSV rows) currently running.
function openRaServerPids() {
  return new Promise(resolve => {
    const child = process.platform === 'win32'
      ? spawn('tasklist', ['/FI', 'IMAGENAME eq OpenRA.Server.exe', '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn('pgrep', ['-f', 'OpenRA.Server'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on?.('data', chunk => { out += chunk; });
    child.on('error', () => resolve(new Set()));
    child.on('close', () => {
      resolve(new Set(out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)));
    });
  });
}

// The node's SIGTERM path tree-kills its rooms (killTree escalates after
// 3 s): give that a bounded window, then report what outlived the node.
async function waitServersGone(baseline, windowMs = 20000) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const now = await openRaServerPids();
    const orphans = [...now].filter(pid => !baseline.has(pid));
    if (orphans.length === 0) return true;
    if (Date.now() > deadline) {
      console.error('[mp] orphan OpenRA.Server: ' + orphans.join(' '));
      return false;
    }
    await new Promise(r => setTimeout(r, 750));
  }
}

function findFreePort(start = 18077, end = 18082) {
  return new Promise((resolve, reject) => {
    const tryPort = port => {
      if (port > end) {
        reject(new Error(`geen vrije poort in ${start}-${end}`));
        return;
      }
      const probe = net.createServer();
      probe.once('error', () => tryPort(port + 1));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
    };
    tryPort(start);
  });
}

function startServer(port) {
  const child = spawn(
    process.execPath,
    [serverScript, '--root', appBundleDir, '--port', String(port)],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const channel of ['stdout', 'stderr']) {
    child[channel].setEncoding('utf8');
    child[channel].on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) console.log(`[server] ${line}`);
      }
    });
  }
  serverChild = child;
  return child;
}

// ─── The local node, on demand (T3.2/L5): no node, no room, no listener
// until the player presses Host. ───

// Hosting stack resolution: the node stack packaged inside this app (a
// plain assembleNode() product) wins; otherwise an explicit settings
// override, then the repo tree. The shipped entry point is node-cli.mjs.
function resolveHostStack() {
  const settings = loadSettings();
  if (isPackaged) {
    const packagedNode = path.join(process.resourcesPath, 'steelseed-node');
    if (fs.existsSync(path.join(packagedNode, 'steelseed-host/tools/node-cli.mjs'))) {
      return { engineRoot: packagedNode, bundle: path.join(process.resourcesPath, 'AppBundle') };
    }
  }
  const engineRoot = settings.hostEngineRoot || path.resolve(import.meta.dirname, '../engine');
  return { engineRoot, bundle: path.join(engineRoot, 'bin-browser/AppBundle') };
}

const nodeApiUrl = () => `http://127.0.0.1:${MP_HTTP_PORT}`;

async function nodeHealth(timeoutMs = 2000) {
  if (!nodeChild) return null;
  return fetch(`${nodeApiUrl()}/v2/health`, { signal: AbortSignal.timeout(timeoutMs) })
    .then(res => (res.ok ? res.json() : null))
    .catch(() => null);
}

function publishLocalNode(value) {
  if (!gameWin || gameWin.isDestroyed()) return;
  void gameWin.webContents
    .executeJavaScript(`window.__redlineLocalNode && window.__redlineLocalNode(${JSON.stringify(value)})`)
    .catch(() => {});
}

function donateStatus() {
  const config = donateConfig(loadSettings());
  const health = lastNodeHealth;
  return {
    enabled: config.enabled,
    maxMatches: config.maxMatches,
    consentSeen: donateConsentCurrent(config),
    active: nodeMode === 'donate' && !!nodeChild,
    paused: config.enabled && nodeMode === 'own' && !!nodeChild,
    starting: donateStarting,
    error: donateError,
    mode: nodeMode,
    matches: Number(health?.rooms ?? 0),
    players: Number(health?.players ?? 0),
    freeMatches: Number(health?.freeMatches ?? Math.max(0, config.maxMatches - Number(health?.rooms ?? 0))),
    draining: donateDraining || health?.draining === true,
    playing: nodePlaying,
    headless: HEADLESS,
  };
}

function publishDonateStatus() {
  const status = donateStatus();
  if (landingWin && !landingWin.isDestroyed()) {
    void landingWin.webContents
      .executeJavaScript(`window.__redlineDonateStatus && window.__redlineDonateStatus(${JSON.stringify(status)})`)
      .catch(() => {});
  }
  if (donateTray) {
    const count = `${status.matches} matches · ${status.players} spelers`;
    donateTray.setToolTip(status.active ? `Redline Wars — ${count}` : 'Redline Wars');
    if (donateTray._redlineDonateMenu) {
      donateTray._redlineDonateMenu[0].label = count;
      donateTray._redlineDonateMenu[0].enabled = status.active || status.starting;
      donateTray._redlineDonateMenu[1].enabled = status.active && !status.draining;
      donateTray._redlineDonateMenu[1].label = status.draining ? 'Stoppen na huidige matches (bezig)' : 'Stoppen na huidige matches';
      donateTray._redlineDonateMenu[3].enabled = status.active || status.starting;
      donateTray._redlineDonateMenu[3].label = status.enabled ? 'Donated capacity uitschakelen' : 'Donated capacity uit';
      donateTray._redlineDonateMenu[4].enabled = true;
      donateTray.setContextMenu(Menu.buildFromTemplate(donateTray._redlineDonateMenu));
    }
  }
}

function ensureDonateTray() {
  if (donateTray || (!donateStarting && nodeMode !== 'donate')) return;
  try {
    const trayImage = nativeImage.createFromPath(path.join(import.meta.dirname, 'build', 'icon.png')).resize({ width: 18, height: 18 });
    if (trayImage.isEmpty()) throw new Error('packaged tray icon is missing');
    donateTray = new Tray(trayImage);
    donateTray.setToolTip('Redline Wars — sharing match capacity');
    const menuTemplate = [
      { label: '0 matches · 0 spelers', enabled: false },
      { label: 'Stoppen na huidige matches', click: () => { void drainDonateNode(); } },
      { type: 'separator' },
      { label: 'Donated capacity uitschakelen', click: () => { void setDonateConfig({ enabled: false }); } },
      { label: 'Openen', click: () => showLanding() },
      { label: 'Afsluiten', click: () => app.quit() },
    ];
    donateTray._redlineDonateMenu = menuTemplate;
    donateTray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
    donateTray.on('click', () => showLanding());
  } catch (err) {
    console.warn('[hosting] tray unavailable:', err?.message || err);
  }
}

function destroyDonateTray() {
  if (!donateTray) return;
  try { donateTray.destroy(); } catch { /* already destroyed */ }
  donateTray = null;
}

function keepWindowForDonation(win) {
  win.on('close', event => {
    if (quitConfirmed || (!donateStarting && nodeMode !== 'donate')) return;
    event.preventDefault();
    win.hide();
    ensureDonateTray();
  });
}

// hostStart (§5.9): validate, pick ports, spawn node-cli.mjs, wait for
// /v2/health (15 s), then hand {dir,key} to the page. lan = discoverable on
// this network only; public also registers at the relay with --mode own.
async function startLocalNode(visibility, mode = 'own') {
  if (mode === 'own' && visibility !== 'lan' && visibility !== 'public') {
    throw new Error('visibility must be "lan" or "public"');
  }
  if (mode !== 'own' && mode !== 'donate') throw new Error('unsupported node mode');
  if (nodeChild && nodeMode === mode) return { dir: nodeApiUrl(), key: nodeKey ?? '' };
  if (nodeChild && nodeMode !== mode) {
    const health = await nodeHealth();
    // A donated node that cannot answer health is not proof of zero rooms.
    // Fail safe so a transient probe failure can never kill someone else's game.
    const activeRooms = health
      ? Number(health.rooms ?? 0)
      : nodeMode === 'donate' ? Math.max(1, Number(lastNodeHealth?.rooms ?? 0)) : Number(lastNodeHealth?.rooms ?? 0);
    if (!nodeModeCanSwitch(nodeMode, mode, activeRooms)) {
      // Never tree-kill matches donated to other players just because the
      // local owner pressed Host. Drain prevents new placements; current
      // matches retain the existing node until their natural end.
      if (nodeMode === 'donate') await drainDonateNode();
      throw new Error('Shared matches are still active. The node is draining; host your own game after they finish.');
    }
    await stopNode();
  }
  if (nodeStarting) throw new Error('a host start is already in progress');
  nodeStarting = true;
  try {
    const { engineRoot, bundle } = resolveHostStack();
    const script = path.join(engineRoot, 'steelseed-host/tools/node-cli.mjs');
    if (!fs.existsSync(script)) throw new Error('node-cli script missing: ' + script);
    hostingEngineRoot = engineRoot;
    const dataDir = path.join(app.getPath('userData'), 'node');
    nodeKey = resolveNodeKey(dataDir);
    const [mux, http] = await hostPorts();
    MP_MUX_PORT = mux;
    MP_HTTP_PORT = http;
    const args = mode === 'donate'
      ? donateNodeArgs({ script, mux, http, dataDir, bundle, nodeKeyFile: path.join(dataDir, 'node.key'), spineUrl: loadSettings().spineUrl, maxMatches: donateConfig(loadSettings()).maxMatches })
      : [
        script,
        '--mode', 'own',
        '--ws', String(mux),
        '--http', String(http),
        '--data-dir', dataDir,
        '--max-matches', '1',
        '--bundle', bundle,
        '--node-key-file', path.join(dataDir, 'node.key'),
      ];
    if (mode === 'own') {
      if (visibility === 'lan') args.push('--lan');
      else args.push('--spine', loadSettings().spineUrl);
    }
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', REDLINE_NODE_KEY: nodeKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    nodeChild = child;
    nodeMode = mode;
    if (mode === 'donate') ensureDonateTray();
    publishDonateStatus();
    for (const channel of ['stdout', 'stderr']) {
      child[channel].setEncoding('utf8');
      child[channel].on('data', chunk => {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue;
          console.log(`[node] ${line}`);
          watchNodeUpdateLine(line);
        }
      });
    }
    child.on('exit', () => {
      if (nodeChild !== child) return;
      const restartDonate = donateRestartAfterDrain;
      nodeChild = null;
      nodeMode = null;
      lastNodeHealth = null;
      donateDraining = false;
      donateRestartAfterDrain = false;
      stopNodeWatch();
      setRoomPlaying(false);
      publishLocalNode(null);
      publishDonateStatus();
      if (!donateStarting) destroyDonateTray();
      if (restartDonate && donateConfig(loadSettings()).enabled) void startDonateNode();
    });
    // Ready only when /v2/health answers — never on process spawn.
    const deadline = Date.now() + 15000;
    let health = null;
    while (Date.now() < deadline && child.exitCode === null) {
      health = await nodeHealth(2000);
      if (health) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!health) {
      await stopNode();
      throw new Error('node did not start');
    }
    lastNodeHealth = health;
    donateDraining = health.draining === true;
    startNodeWatch();
    publishLocalNode({ dir: nodeApiUrl(), key: nodeKey });
    return { dir: nodeApiUrl(), key: nodeKey };
  } finally {
    nodeStarting = false;
  }
}

function stopNode() {
  stopNodeWatch();
  setRoomPlaying(false);
  lastNodeHealth = null;
  donateDraining = false;
  donateRestartAfterDrain = false;
  nodeMode = null;
  publishLocalNode(null);
  publishDonateStatus();
  const child = nodeChild;
  nodeChild = null;
  if (!child) return Promise.resolve();
  try {
    child.kill();
  } catch {
    // Already gone; the exit handler cleared the reference.
  }
  // 3 s to exit on its own, then SIGKILL — a wedged node must not hold the
  // mux ports for the next host press.
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      resolve();
    }, 3000);
  });
}

async function startDonateNode() {
  const config = donateConfig(loadSettings());
  if (!mpOn()) return { ...donateStatus(), multiplayerOff: true };
  if (!config.enabled || !donateConsentCurrent(config)) return donateStatus();
  if (nodeMode === 'own' && nodeChild) return donateStatus();
  if (donateStartPromise) return donateStartPromise;
  donateStarting = true;
  donateError = null;
  ensureDonateTray();
  publishDonateStatus();
  donateStartPromise = (async () => {
    try {
      await startLocalNode(null, 'donate');
      return donateStatus();
    } catch (err) {
      donateError = String(err?.message || err);
      console.error('[hosting] donated capacity failed:', donateError);
      return donateStatus();
    } finally {
      donateStarting = false;
      donateStartPromise = null;
      publishDonateStatus();
    }
  })();
  return donateStartPromise;
}

async function drainDonateNode() {
  if (nodeMode !== 'donate' || !nodeChild) return donateStatus();
  donateDraining = true;
  publishDonateStatus();
  try {
    const response = await fetch(`${nodeApiUrl()}/v2/drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-redline-node-key': nodeKey ?? '' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`drain failed (${response.status})`);
    const body = await response.json();
    donateDraining = body.draining === true;
    lastNodeHealth = { ...(lastNodeHealth ?? {}), ...body, draining: true, freeMatches: 0 };
  } catch (error) {
    donateDraining = false;
    donateError = String(error?.message || error);
  }
  publishDonateStatus();
  return donateStatus();
}

async function setDonateConfig(patch = {}) {
  const current = donateConfig(loadSettings());
  const wantsEnabled = patch.enabled === undefined ? current.enabled : patch.enabled === true;
  const requestedMax = patch.maxMatches === undefined ? current.maxMatches : patch.maxMatches;
  const nextPatch = { ...patch, enabled: wantsEnabled, maxMatches: requestedMax };
  // §3.3: host-for-others is multiplayer. With the switch off it never
  // starts — the consent dialog does not even open.
  if (wantsEnabled && !mpOn()) return { ...donateStatus(), multiplayerOff: true };
  if (wantsEnabled && !donateConsentCurrent(current)) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Matches delen',
      message: S24_DONATE_CONFIRMATION,
      buttons: ['Inschakelen', 'Annuleren'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      // Declined: persist "off", so a stale opt-in neither shows as enabled
      // nor asks again at every launch. The next explicit enable asks again.
      if (current.enabled) {
        saveSettings(withDonateConfig(loadSettings(), { enabled: false }));
        publishDonateStatus();
      }
      return { ...donateStatus(), consentRequired: true };
    }
    nextPatch.consentSeen = true;
    nextPatch.consentVersion = DONATE_CONSENT_VERSION;
  }
  const next = withDonateConfig(loadSettings(), nextPatch);
  saveSettings(next);
  donateError = null;
  if (!next.donate.enabled) {
    if (donateStartPromise) await donateStartPromise;
    if (nodeMode === 'donate' || donateStarting) {
      // Ask the node itself: the last 5 s poll can miss a match that just
      // started, and a node that cannot answer is not proof of zero rooms —
      // then drain (it exits by itself once empty), never kill a shared match.
      const health = await nodeHealth();
      const rooms = health ? Number(health.rooms ?? 0) : Math.max(1, Number(lastNodeHealth?.rooms ?? 0));
      if (rooms > 0) await drainDonateNode();
      else await stopNode();
    }
    if (!nodeChild) destroyDonateTray();
  } else if (nodeMode === 'donate' && nodeChild && next.donate.maxMatches !== current.maxMatches) {
    // A running node cannot change capacity safely. Drain it, then the exit
    // handler restarts exactly the same assembled node with the new limit.
    donateRestartAfterDrain = true;
    await drainDonateNode();
  } else if (!nodeChild && !nodeStarting) {
    await startDonateNode();
  }
  publishDonateStatus();
  return donateStatus();
}

// T3.2.4: the node lives only while it hosts. Poll /v2/health every 5 s;
// 30 s (6 polls) with rooms === 0 stops it again.
function startNodeWatch() {
  stopNodeWatch();
  emptyHealthPolls = 0;
  nodeWatchTimer = setInterval(() => {
    void (async () => {
      if (!nodeChild) return stopNodeWatch();
      const health = await nodeHealth(2000);
      if (!health) return; // unreachable poll — the exit handler owns teardown
      lastNodeHealth = health;
      donateDraining = health.draining === true;
      if (Number(health.rooms ?? 0) === 0) {
        emptyHealthPolls += 1;
        if (emptyHealthPolls >= 6 && !keepsNodeForEmptyRooms(nodeMode)) {
          console.log('[hosting] no room for 30 s — stopping the node');
          await stopNode();
          return;
        }
      } else {
        emptyHealthPolls = 0;
      }
      await syncPlayBlocker();
      publishDonateStatus();
    })();
  }, 5000);
}

function stopNodeWatch() {
  if (nodeWatchTimer) {
    clearInterval(nodeWatchTimer);
    nodeWatchTimer = null;
  }
}

// T3.9: keep the machine awake while a hosted match is playing.
function setRoomPlaying(on) {
  nodePlaying = on === true;
  if (on && playBlockerId === null) playBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  else if (!on && playBlockerId !== null) {
    powerSaveBlocker.stop(playBlockerId);
    playBlockerId = null;
  }
}

async function syncPlayBlocker() {
  let playing = false;
  if (nodeChild) {
    const list = await fetch(`${nodeApiUrl()}/v2/rooms`, { signal: AbortSignal.timeout(2000) })
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null);
    playing = Array.isArray(list?.rooms) && list.rooms.some(room => room?.state === 'playing');
  }
  setRoomPlaying(playing);
  publishDonateStatus();
}

// ─── T3.10: "update required". The relay's accepted-builds list decides
// whether this build may still play online; LAN and skirmish never gate. ───

const relayDir = () => String(loadSettings().mpDir ?? '').trim() || RELAY_DIR;

// The app may open a download URL only when its host is our own site.
function sanitizeDownloadUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if ((url.protocol === 'https:' || url.protocol === 'http:') && DOWNLOAD_HOSTS.has(url.hostname)) {
      return url.toString();
    }
  } catch {
    // Not a URL — never openable.
  }
  return null;
}

function ownSimBuild() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(appBundleDir, 'steelseed/build.json'), 'utf8')).simBuild ?? '');
  } catch {
    return '';
  }
}

// The landing's build readout: the bundle cannot change under a running app.
let shellBuildId = null;
function shellBuild() {
  if (shellBuildId === null) shellBuildId = ownSimBuild();
  return shellBuildId;
}

function publishUpdateRequired() {
  if (!updateRequired) return;
  const payload = JSON.stringify(updateRequired);
  for (const win of [landingWin, gameWin]) {
    if (!win || win.isDestroyed()) continue;
    void win.webContents
      .executeJavaScript(`window.__redlineUpdateRequired && window.__redlineUpdateRequired(${payload})`)
      .catch(() => {});
  }
}

// GET <relay>/v2/config (3 s). Unreachable → no gate: LAN stays unaffected.
async function checkUpdateGate() {
  if (updateMemo.state && Date.now() - updateMemo.at < 30000) return updateMemo.state;
  let state;
  try {
    const res = await fetch(`${relayDir().replace(/\/+$/, '')}/v2/config`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`relay config HTTP ${res.status}`);
    const config = await res.json();
    const accepted = Array.isArray(config?.acceptedBuilds) ? config.acceptedBuilds.map(String) : [];
    const own = ownSimBuild();
    const required = shellVerdict(own, accepted);
    state = { required, reachable: true, own, accepted, downloadUrl: required ? sanitizeDownloadUrl(config?.app?.downloadUrl) : null };
  } catch {
    state = { required: false, reachable: false, own: ownSimBuild(), accepted: [], downloadUrl: null };
  }
  updateMemo = { at: Date.now(), state };
  return state;
}

function runUpdateCheck() {
  void checkUpdateGate().then(state => {
    if (!state?.required || updateRequired) return;
    updateRequired = { downloadUrl: state.downloadUrl ?? null, own: state.own, accepted: state.accepted };
    publishUpdateRequired();
  }).catch(() => {});
}

// The node's own stdout verdict (§5.5) triggers the same modal even when
// the relay is unreachable from the shell.
function watchNodeUpdateLine(line) {
  const marker = '[[redline-node]] ';
  if (!line.startsWith(marker)) return;
  let event = null;
  try {
    event = JSON.parse(line.slice(marker.length));
  } catch {
    return;
  }
  if (event?.event !== 'update-required') return;
  const nodeAccepted = Array.isArray(event.accepted) ? event.accepted.map(String) : [];
  void checkUpdateGate()
    .then(state => {
      if (!nodeRefusalNeedsDownload(state)) {
        // This app's own build is accepted, so a new download would change nothing: the
        // Grid refused the bundled node for another reason. Report it, don't ask for one.
        console.error(`[hosting] the Grid refused the bundled node (accepts ${nodeAccepted.join(', ') || '?'}); this app's build ${state.own} is accepted — not an update`);
        return;
      }
      updateRequired = { downloadUrl: state.downloadUrl ?? null, own: state.own, accepted: state.reachable ? state.accepted : nodeAccepted };
      publishUpdateRequired();
    })
    .catch(() => {
      updateRequired = { downloadUrl: null, own: ownSimBuild(), accepted: nodeAccepted };
      publishUpdateRequired();
    });
}

// ─── T3.6: LAN discovery as a child process. The listener (a node tool)
// owns every multicast rule; the shell only starts/stops it and forwards
// its JSON room lines to the page. ───

function startLanListener() {
  if (lanListenerChild) return;
  const { engineRoot } = resolveHostStack();
  const script = path.join(engineRoot, 'steelseed-host/tools/lan-listener.mjs');
  if (!fs.existsSync(script)) {
    console.warn('[lan] listener script missing: ' + script);
    return;
  }
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  lanListenerChild = child;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    for (const line of String(chunk).split('\n')) {
      const text = line.trim();
      if (!text) continue;
      console.log(`[lan] ${text}`);
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // not a room-set line
      }
      const rooms = Array.isArray(parsed?.rooms) ? parsed.rooms : null;
      if (!rooms || !gameWin || gameWin.isDestroyed()) continue;
      void gameWin.webContents
        .executeJavaScript(`window.__steelseedLanRooms && window.__steelseedLanRooms(${JSON.stringify(rooms)})`)
        .catch(() => {});
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) console.log(`[lan:err] ${line}`);
    }
  });
  child.on('exit', () => {
    if (lanListenerChild === child) lanListenerChild = null;
  });
}

function stopLanListener() {
  const child = lanListenerChild;
  lanListenerChild = null;
  if (child) {
    try {
      child.kill();
    } catch {
      // Already gone; the exit handler cleared the reference.
    }
  }
}

// T3.7: the page's address reveal asks the listener to query now — bare for
// a fresh multicast sweep, `query <ip>` for a unicast probe of one host.
function lanQuery(value) {
  const child = lanListenerChild;
  if (!child || !child.stdin.writable) return;
  const ip = typeof value === 'string' ? value.trim() : '';
  child.stdin.write(`${ip ? `query ${ip}` : 'query'}\n`);
}

// Players tile: open rooms on the relay ('—' while it is not deployed).
// Multiplayer off means no relay polling at all.
function refreshPlayersTile() {
  if (!mpOn()) return;
  fetch(`${RELAY_DIR}/v2/rooms`, { signal: AbortSignal.timeout(3000) })
    .then(res => (res.ok ? res.json() : null))
    .catch(() => null)
    .then(list => {
      const n = Array.isArray(list?.rooms) ? list.rooms.length : null;
      const text = n === null ? '— · relay offline' : `${n} open room${n === 1 ? '' : 's'}`;
      landingState.players = text;
      if (landingWin && !landingWin.isDestroyed()) {
        landingWin.webContents.executeJavaScript(`window.setPlayers && window.setPlayers(${JSON.stringify(text)})`).catch(() => {});
      }
    })
    .catch(() => {});
}

// §3.3: the landing's Multiplayer switch. Off: the native Multiplayer… entry
// is disabled, no LAN listener, no rooms polling, Play online / Host refuse,
// and host-for-others drains — its current matches finish, nothing is killed.
// --selftest and --headless keep it on and never persist a change.
async function setMultiplayer(on) {
  if (!SELFTEST && !HEADLESS) saveSettings(withMultiplayer(loadSettings(), on === true));
  const enabled = mpOn();
  const item = Menu.getApplicationMenu()?.getMenuItemById('menu-multiplayer');
  if (item) item.enabled = enabled;
  if (gameWin && !gameWin.isDestroyed()) {
    void gameWin.webContents
      .executeJavaScript(`window.__steelseedSetMultiplayer && window.__steelseedSetMultiplayer(${enabled})`)
      .catch(() => {});
  }
  if (landingWin && !landingWin.isDestroyed()) {
    void landingWin.webContents
      .executeJavaScript(`window.__redlineMultiplayer && window.__redlineMultiplayer(${JSON.stringify({ on: enabled })})`)
      .catch(() => {});
  }
  if (enabled) refreshPlayersTile();
  else {
    stopLanListener();
    // setDonateConfig drains a donated node that has (or may have) matches.
    if (donateConfig(loadSettings()).enabled || nodeMode === 'donate' || donateStarting) {
      await setDonateConfig({ enabled: false });
    }
  }
  return enabled;
}

// §5.3: the node key is created once per install and stored at
function resolveNodeKey(dataDir) {
  const keyPath = path.join(dataDir, 'node.key');
  try {
    const stored = fs.readFileSync(keyPath, 'utf8').trim();
    if (stored) return stored;
  } catch {
    // not there yet — create it below
  }
  const key = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyPath, key + '\n', { mode: 0o600 });
  return key;
}

function accountTokenPath() {
  return path.join(app.getPath('userData'), ACCOUNT_TOKEN_FILE);
}

function loadAccountBearer() {
  if (accountBearer) return accountBearer;
  try {
    const encrypted = fs.readFileSync(accountTokenPath());
    // Most players have never signed in. Avoid touching macOS Keychain on
    // startup when there is no encrypted token to decrypt: a locked keychain
    // can block Electron's main thread (and the game boot) indefinitely.
    if (!safeStorage.isEncryptionAvailable()) return null;
    const token = safeStorage.decryptString(encrypted).trim();
    accountBearer = token || null;
  } catch {
    accountBearer = null;
  }
  return accountBearer;
}

function storeAccountBearer(token) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('The account service returned an invalid device token.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Encrypted account storage is unavailable on this device.');
  const file = accountTokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, safeStorage.encryptString(token), { mode: 0o600 });
  accountBearer = token;
}

function forgetAccountBearer() {
  accountBearer = null;
  try { fs.rmSync(accountTokenPath(), { force: true }); } catch { /* already signed out */ }
}

const accountBroker = createAccountBroker({
  origin: ACCOUNT_API_ORIGIN,
  fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
  openExternal: url => shell.openExternal(url),
  storage: {
    load: loadAccountBearer,
    store: storeAccountBearer,
    clear: forgetAccountBearer,
  },
});

// The room-create map comes from the generated mod's gate-map.json (§5.4) —
// never a hardcoded uid. Falls back to the gate uid at HEAD when the catalog
// has not been generated yet (repo checkout before the first mod build).
function nodeGateMap() {
  const roots = [];
  if (hostingEngineRoot) roots.push(hostingEngineRoot);
  roots.push(path.resolve(import.meta.dirname, '../engine'));
  for (const root of roots) {
    try {
      const gate = JSON.parse(fs.readFileSync(path.join(root, 'steelseed-host/generated/mods/ra/gate-map.json'), 'utf8'));
      if (gate && /^[0-9a-f]{40}$/.test(gate.uid ?? '')) return gate;
    } catch { /* try the next root */ }
  }
  return { uid: 'af68f5f539b2717234b48d7fd687d3a6ae9cc916', players: 2 };
}

// Fixed LAN-ports when they are free (the documented <ip>:14711 join hint),
// otherwise scan — instances must not collide on the bind.
function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

async function hostPorts() {
  if ((await portFree(14710)) && (await portFree(14711))) return [14710, 14711];
  const mux = await findFreePort(14710, 14730);
  return [mux, await findFreePort(mux + 1, mux + 20)];
}


function trackHosts(target, hosts) {
  target.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.hostname &&
        url.hostname !== '127.0.0.1'
      ) {
        hosts.add(url.hostname);
      }
    } catch {
      // Unparseable URL cannot be an external http host.
    }
    callback({ cancel: false });
  });
}

function lanIPv4() {
  const ifaces = os.networkInterfaces();
  const pick = entries =>
    (entries || []).find(i => !i.internal && (i.family === 'IPv4' || i.family === 4));
  return (pick(ifaces.en0) || Object.values(ifaces).map(pick).find(Boolean))?.address || null;
}

// Ratio of sampled pixels with any colour channel above the quiet threshold.
function nonBlackRatioOf(image) {
  const size = image.getSize();
  const bmp = image.toBitmap();
  if (!bmp || bmp.length === 0 || size.width === 0 || size.height === 0) return 0;
  const rowStride = Math.floor(bmp.length / size.height);
  let sampled = 0;
  let lit = 0;
  for (let y = 0; y < size.height; y += 7) {
    for (let x = 0; x < size.width; x += 7) {
      const off = y * rowStride + x * 4;
      sampled += 1;
      if (bmp[off] > 24 || bmp[off + 1] > 24 || bmp[off + 2] > 24) lit += 1;
    }
  }
  return sampled > 0 ? lit / sampled : 0;
}


async function boot() {
  const t0 = Date.now();

  electronGpuDiagnostics = await collectElectronGpuDiagnostics();
  console.log('[gpu] Electron capability diagnostics:', JSON.stringify(electronGpuDiagnostics));

  if (!fs.existsSync(path.join(appBundleDir, 'steelseed/index.html'))) {
    if (SELFTEST) failSelftest();
    else {
      dialog.showErrorBox('Redline Wars', 'AppBundle ontbreekt: ' + appBundleDir);
      app.quit();
    }
    return;
  }

  const settings = loadSettings();
  if (!fs.existsSync(settingsFile())) saveSettings(settings);

  let port;
  lastPort = 18077; // Module scope: showLanding() recreates the window later.
  try {
    port = await findFreePort();
    lastPort = port;
  } catch (err) {
    if (SELFTEST) failSelftest();
    else dialog.showErrorBox('Redline Wars', String(err?.message || err));
    return;
  }

  startServer(port);
  // T3.2: hosting is on demand — no node at launch, no ports reserved
  // before the player presses Host.

  // Landing music: song 1, the Theme — the game-start song of the desktop start
  // menu (the website plays it too) — out of the AppBundle, served by the local
  // server. Missing asset only costs the audio, never the app.
  let musicUrl = '';
  try {
    const assets = path.join(appBundleDir, 'steelseed/assets');
    const theme = fs.readdirSync(assets).find(f => /^theme-.*\.m4a$/.test(f));
    if (theme) musicUrl = `http://127.0.0.1:${port}/steelseed/assets/${encodeURIComponent(theme)}`;
    else console.warn('[music] no theme-*.m4a in ' + assets);
  } catch (err) {
    console.warn('[music] theme lookup failed:', err?.message || err);
  }
  lastMusicUrl = musicUrl;

  // §3.1: one credits and licence text everywhere (shell-options.mjs); the
  // second button opens the licence the installer ships in resources/legal/.
  const showCopyright = () => {
    void dialog.showMessageBox({
      type: 'info',
      title: 'Credits & licenties',
      message: 'Redline Wars: Fractured Order',
      detail: LEGAL_LONG,
      buttons: ['OK', 'Licenties bekijken'],
      defaultId: 0,
      cancelId: 0,
    }).then(({ response }) => {
      if (response === 1) {
        const file = legalDocPath('license', legalRoots());
        void shell.openPath(file).then(error => {
          if (error) console.warn(`[legal] cannot open ${file}: ${error}`);
        });
      }
    }).catch(() => {});
  };
  // The console landing has its own Credits sheet; anywhere else (in game,
  // or a landing without the sheet) the native dialog carries the same text.
  const openCredits = () => {
    if (landingWin && !landingWin.isDestroyed() && landingWin.isVisible()) {
      void landingWin.webContents
        .executeJavaScript('(() => { if (!window.__redlineOpenCredits) return false; window.__redlineOpenCredits(); return true; })()')
        .then(opened => { if (opened !== true) showCopyright(); })
        .catch(() => showCopyright());
      return;
    }
    showCopyright();
  };
  app.setAboutPanelOptions({
    applicationName: 'Redline Wars',
    applicationVersion: app.getVersion(),
    copyright: LEGAL_SHORT,
    credits: 'Engine: OpenRA © The OpenRA Developers and Contributors (GPLv3)',
  });
  const showLanInfo = () => {
    const ip = lanIPv4();
    const settings = loadSettings();
    void dialog.showMessageBox({
      type: 'info',
      title: 'Multiplayer',
      message: 'Play with friends — entirely inside the app',
      detail:
        (ip
          ? `Friends open Redline Wars, go to Multiplayer and press Host — your room appears in their list automatically. Should discovery fail, they can enter your address (${ip}) on the multiplayer screen.\n`
          : 'LAN: no network address found.\n') +
        (settings.spineUrl
          ? `Relay: hosting with "Anyone online" registers the room at ${settings.spineUrl} for players on the internet.`
          : 'Relay: not configured.') +
        (settings.mpDir ? `\nJoin directory currently set to: ${settings.mpDir}` : ''),
    });
  };
  // ─── state shared by the ipc handlers, menu and flows ───
  let visualsReady = false;
  let enteredGame = false;
  let queuedTab = null;
  let queuedMpDir = null;
  let queuedFocus = false; // Host a game: focus the host card once mp is up

  ipcMain.on('show-copyright', () => showCopyright());
  ipcMain.on('show-lan', () => showLanInfo());
  // The home page, or one allowlisted page (shell-options.mjs) — never a URL
  // the page supplies.
  ipcMain.on('open-website', (_e, page) => void shell.openExternal(websitePage(page) ?? WEBSITE_URL));
  // §3.3: the credits sheet reads the shipped licence texts by allowlisted
  // name only; an unknown name, a missing or oversized file answers null.
  ipcMain.handle('legal-text', async (_e, name) => {
    const file = legalDocPath(name, legalRoots());
    if (!file) return null;
    try {
      const { size } = await fs.promises.stat(file);
      if (size > LEGAL_TEXT_MAX_BYTES) return null;
      return await fs.promises.readFile(file, 'utf8');
    } catch {
      return null;
    }
  });
  // §3.2: everything the landing shows, in one synchronous read at page load.
  ipcMain.on('get-shell-state-sync', e => {
    e.returnValue = {
      multiplayer: mpOn(),
      loader: { state: landingState.loader, pct: landingState.pct, stage: landingState.stage },
      players: landingState.players,
      donate: donateStatus(),
      build: shellBuild(),
      version: app.getVersion(),
      port: lastPort,
    };
  });
  ipcMain.on('get-multiplayer-sync', e => {
    e.returnValue = mpOn();
  });
  ipcMain.handle('set-multiplayer', (_e, on) => setMultiplayer(on === true));
  // Account broker: device credentials never cross the preload boundary. The
  // renderer receives only profile/status JSON and allowlisted API results.
  ipcMain.handle('account-status', () => accountBroker.status());
  // One browser sign-in at a time; its code goes only to the page that asked.
  let deviceLoginPending = null;
  ipcMain.handle('account-device-login', event => {
    if (deviceLoginPending) throw new Error('A browser sign-in is already waiting for its code.');
    const sender = event.sender;
    deviceLoginPending = accountBroker.deviceLogin({
      onChallenge: challenge => { if (!sender.isDestroyed()) sender.send('account-device-challenge', challenge); },
    }).finally(() => { deviceLoginPending = null; });
    return deviceLoginPending;
  });
  ipcMain.handle('account-avatar-upload', (_event, request) => accountBroker.avatarUpload(request));
  ipcMain.handle('account-logout', () => accountBroker.logout());
  ipcMain.handle('account-request', (_event, request) => {
    const pathname = typeof request?.path === 'string' ? request.path : '';
    const method = typeof request?.method === 'string' ? request.method.toUpperCase() : 'GET';
    if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') throw new Error('Account method is not allowed.');
    return accountBroker.scopedRequest(pathname, method, request?.body);
  });
  ipcMain.on('get-music-sync', e => {
    e.returnValue = loadSettings().music === false ? 'off' : 'on';
  });
  const syncMusicUi = on => {
    if (landingWin && !landingWin.isDestroyed()) {
      landingWin.webContents
        .executeJavaScript(`window.setMusicIcon && window.setMusicIcon(${on ? 'true' : 'false'})`)
        .catch(() => {});
    }
  };
  const toggleMusic = () => {
    const on = loadSettings().music !== false;
    saveSettings({ ...loadSettings(), music: !on });
    syncMusicUi(!on);
    const item = Menu.getApplicationMenu()?.getMenuItemById('music-toggle');
    if (item) item.checked = !on;
  };
  ipcMain.on('toggle-music', () => toggleMusic());
  // §5.9: a directory override may only name the relay host, a private/
  // loopback/link-local IP or a .local name — never an arbitrary host.
  ipcMain.on('set-mp-dir', (_e, value) => {
    const raw = String(value ?? '').trim();
    if (raw === '') {
      saveSettings({ ...loadSettings(), mpDir: '' });
      return;
    }
    try {
      const url = new URL(raw);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && isDirectoryHost(url.hostname)) {
        saveSettings({ ...loadSettings(), mpDir: raw });
      } else {
        console.warn('[mp] rejected directory override: ' + raw);
      }
    } catch {
      console.warn('[mp] rejected directory override: ' + raw);
    }
  });
  ipcMain.on('get-mp-dir-sync', e => {
    e.returnValue = loadSettings().mpDir ?? '';
  });
  ipcMain.on('get-donate-hosting-sync', e => {
    e.returnValue = donateHostingEnabled(loadSettings());
  });
  ipcMain.on('get-donate-config-sync', e => {
    e.returnValue = donateConfig(loadSettings());
  });
  // ─── T3.2/§5.9: the host surface. hostStart validates, spawns the node
  // and resolves {dir,key}; one start at a time; public hosting is gated by
  // the relay's accepted-builds list (T3.10). ───
  ipcMain.handle('host-start', async (_e, request) => {
    // §3.3: with the Multiplayer switch off nothing hosts.
    if (!mpOn()) throw new Error('multiplayer-off');
    const visibility = request?.visibility;
    if (donateStartPromise) await donateStartPromise;
    if (visibility === 'public') {
      const gate = await checkUpdateGate();
      if (gate.required) {
        if (!updateRequired) {
          updateRequired = { downloadUrl: gate.downloadUrl ?? null, own: gate.own, accepted: gate.accepted };
          publishUpdateRequired();
        }
        throw new Error('update-required');
      }
      return startLocalNode('public', 'own');
    }
    // LAN never blocks on the relay; the check only feeds the S14 modal.
    runUpdateCheck();
    return startLocalNode(visibility, 'own');
  });
  ipcMain.handle('host-stop', async () => {
    const result = await stopNode();
    if (donateConfig(loadSettings()).enabled) void startDonateNode();
    return result;
  });
  ipcMain.handle('host-status', () => nodeHealth());
  ipcMain.handle('donate-status', () => donateStatus());
  ipcMain.handle('donate-set-config', (_e, patch) => setDonateConfig(rendererDonatePatch(patch)));
  ipcMain.handle('donate-stop', () => setDonateConfig({ enabled: false }));
  ipcMain.handle('donate-drain', () => drainDonateNode());
  ipcMain.handle('lan-query', (_e, value) => lanQuery(value));
  // T3.10: the S14 button may only open our own download page.
  ipcMain.handle('open-download', (_e, url) => {
    const clean = sanitizeDownloadUrl(url);
    if (clean) void shell.openExternal(clean);
  });

  const menu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Spel',
      submenu: [
        { label: 'Skirmish…', click: () => enterGame('skirmish') },
        // setMultiplayer() keeps this entry in step with the landing's switch.
        { id: 'menu-multiplayer', label: 'Multiplayer…', enabled: mpOn(), click: () => enterMp() },
        { type: 'separator' },
        { label: 'Terug naar hoofdmenu', click: () => backToMain() },
        { type: 'separator' },
        {
          id: 'music-toggle',
          label: 'Muziek',
          type: 'checkbox',
          checked: settings.music !== false,
          click: item => {
            toggleMusic();
            item.checked = loadSettings().music !== false;
          },
        },
        {
          label: 'Kwaliteit (herstart de grafische modus)',
          submenu: [
            ...[
              ['default', 'Default — Classic on a strong GPU, otherwise Dynamic'],
              ['detect', 'Auto'],
              ['dynamic', 'Dynamic — adjusts to your performance'],
              ['low', 'Low'],
              ['medium', 'Medium'],
              ['high', 'High'],
              ['turbo', 'Turbo 60'],
              ['classic', 'Classic'],
              ['ultra', 'Ultra'],
              ['ultra-max', 'Ultra+'],
            ].map(([q, label]) => ({
              id: `quality-${q}`,
              label,
              type: 'radio',
              checked: settings.quality === q,
              click: () => applyQuality(q),
            })),
          ],
        },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Website — www.redlinewars.online', click: () => void shell.openExternal(WEBSITE_URL) },
        { label: 'Multiplayer & LAN-info…', click: () => showLanInfo() },
        { type: 'separator' },
        { label: 'Credits & licenties…', click: () => openCredits() },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  // §3.2: the cold-start landing plays the intro (never under --headless);
  // openLanding() gives it — and every landing rebuilt later — the quit
  // hook, the visibility wiring and the state replay.
  openLanding({ intro: !HEADLESS, visible: !SELFTEST && !HEADLESS });
  gameWin = createGameWindow();
  // One boot per app session: the page loads unpinned — both session tabs
  // live in it — and every later navigation is an in-page screen switch.
  void gameWin.loadURL(
    `http://127.0.0.1:${port}/steelseed/index.html?${qualityParam(settings.quality)}`,
  );
  // A persisted opt-in resumes the same assembled node on launch. It is
  // deliberately absent from the default settings, so first launch remains
  // completely local and quiet.
  // Consent from before DONATE_CONSENT_VERSION is asked for once more instead.
  // With the Multiplayer switch off nothing resumes (§3.3).
  if (donateHostingEnabled(settings) && !SELFTEST && mpOn()) {
    const donate = donateConfig(settings);
    if (donateConsentCurrent(donate)) void startDonateNode();
    else if (donate.consentSeen) void setDonateConfig({ enabled: true });
  }
  const notifyLoader = state => {
    // §3.2: remembered before the push, so a rebuilt landing replays it.
    landingState.loader = state;
    if (state === 'klaar') landingState.pct = 100;
    if (landingWin.isDestroyed()) return Promise.resolve();
    return landingWin.webContents
      .executeJavaScript(`window.setLoader(${JSON.stringify(state)})`)
      .catch(() => {});
  };
  const notifyProgress = (pct, stage) => {
    landingState.pct = Number(pct) || 0;
    landingState.stage = String(stage ?? '');
    if (landingWin.isDestroyed()) return Promise.resolve();
    return landingWin.webContents
      .executeJavaScript(`window.setLoaderProgress && window.setLoaderProgress(${JSON.stringify(pct)}, ${JSON.stringify(stage)})`)
      .catch(() => {});
  };
  const presentGame = () => {
    if (gameWin.isDestroyed()) return false;
    // Take over the landing's exact frame so the swap reads as one window.
    // Fullscreen is NEVER restored here: only the user's own menu action
    // (View ▸ Toggle Full Screen) may change it.
    try {
      if (landingWin && !landingWin.isDestroyed()) gameWin.setBounds(landingWin.getBounds());
    } catch { /* landing already gone: keep the default frame */ }
    gameWin.show();
    gameWin.moveTop();
    return true;
  };
  const swapToGame = () => {
    if (gameWin.isDestroyed()) return false;
    enteredGame = true;
    // ready-to-show never fires for a never-shown window in this Electron
    // build, so the swap shows the window explicitly.
    presentGame();
    gameWin.moveTop();
    if (!landingWin.isDestroyed()) landingWin.close();
    return true;
  };
  const gameJs = code =>
    gameWin.isDestroyed()
      ? Promise.resolve()
      : gameWin.webContents.executeJavaScript(code).catch(() => {});
  const selectSession = tab =>
    void gameJs(`window.__steelseedSelectSession && window.__steelseedSelectSession(${JSON.stringify(tab)})`);
  const enterGame = tab => {
    if (gameWin.isDestroyed()) return false;
    if (!visualsReady) {
      // Early click: the engine's own 0–100 % boot meter IS the loader, and
      // the switch completes the moment the first visuals present.
      queuedTab = tab;
      queuedFocus = false;
      notifyLoader('wachten');
      swapToGame();
      return false;
    }
    swapToGame();
    selectSession(tab);
    return true;
  };
  // §3.3: Host a game opens the same screen with the host card focused.
  const focusHost = () => void gameJs('window.__steelseedFocusHost && window.__steelseedFocusHost()');
  const enterMp = ({ focusHost: focus = false } = {}) => {
    if (gameWin.isDestroyed()) return false;
    // §3.3: the Multiplayer switch is off — no screen, no listener, no relay.
    if (!mpOn()) return false;
    const dir = String(loadSettings().mpDir ?? '').trim() || RELAY_DIR;
    // T3.6: the discovery listener runs while the multiplayer screen is up.
    startLanListener();
    // T3.10: the relay's accepted-builds gate is checked on every
    // start-multiplayer — fire and forget, the screen never waits for it.
    runUpdateCheck();
    if (visualsReady) {
      void gameJs(`window.__steelseedSetMpDir && window.__steelseedSetMpDir(${JSON.stringify(dir)})`);
      selectSession('mp');
      swapToGame();
      if (focus === true) focusHost();
    } else {
      queuedTab = 'mp';
      queuedMpDir = dir;
      queuedFocus = focus === true;
      notifyLoader('wachten');
      swapToGame();
    }
    return true;
  };
  const backToMain = () => {
    // In-page return: the engine stays booted, re-entry is instant, and the
    // landing (music included) comes straight back. Mirror of presentGame:
    // the landing takes the game's frame and shows BEFORE the game hides, so
    // there is never a moment without a window.
    enteredGame = false;
    stopLanListener();
    // A start queued while the engine booted ends with the game screen.
    queuedTab = null;
    queuedMpDir = null;
    queuedFocus = false;
    if (landingState.loader === 'wachten') void notifyLoader('laden');
    let bounds = null;
    try {
      if (gameWin && !gameWin.isDestroyed() && gameWin.isVisible()) bounds = gameWin.getBounds();
    } catch { /* game window already gone: the landing keeps its own frame */ }
    if (landingWin && !landingWin.isDestroyed()) {
      try {
        if (bounds) landingWin.setBounds(bounds);
      } catch { /* keep the landing's frame */ }
      landingWin.show();
    } else openLanding({ intro: false, bounds });
    landingWin.moveTop();
    if (gameWin && !gameWin.isDestroyed()) gameWin.hide();
  };
  const applyQuality = q => {
    saveSettings({ ...loadSettings(), quality: q });
    // The ONLY reload in the app: a graphics-mode change rebuilds the GPU
    // pipelines, so the page reboots into the chosen quality (assets come
    // from the service-worker cache).
    if (gameWin && !gameWin.isDestroyed() && gameWin.isVisible()) {
      visualsReady = false;
      queuedTab = null;
      landingState.pct = 0;
      landingState.stage = '';
      notifyLoader('laden');
      void gameWin.loadURL(
        `http://127.0.0.1:${port}/steelseed/index.html?${qualityParam(q)}`,
      );
      startBootWatch();
    }
  };
  startGameFn = () => enterGame('skirmish');
  startMpFn = enterMp;
  backToMainMenuFn = backToMain;
  toggleMusicFn = toggleMusic;
  applyQualityFn = applyQuality;
  ipcMain.on('start-game', () => enterGame('skirmish'));
  ipcMain.on('start-multiplayer', () => enterMp());
  // §3.3: Host a game — the multiplayer screen with the host card focused.
  ipcMain.on('start-hosting', () => enterMp({ focusHost: true }));
  ipcMain.on('back-to-main', () => backToMain());

  // Watches the engine page's boot meter and mirrors stage + percentage on
  // the landing; re-armable (quality change reloads the page on purpose).
  function startBootWatch() {
    const deadline = Date.now() + 240000;
    const timer = setInterval(() => {
      if (gameWin.isDestroyed()) {
        clearInterval(timer);
        return;
      }
      gameWin.webContents
        .executeJavaScript(
          `(() => { const b = document.getElementById('boot'); return { done: !b || b.classList.contains('done') || b.hidden === true, stage: document.getElementById('boot-status')?.textContent ?? '', fraction: Number(b?.dataset.fraction ?? 0) }; })()`,
        )
        .then(state => {
          if (state.done) {
            clearInterval(timer);
            visualsReady = true;
            // Let a few frames present before the queued switch fires, so
            // the player never watches the pipeline-compile stall.
            setTimeout(() => {
              notifyLoader('klaar');
              if (queuedTab) {
                const tab = queuedTab;
                const mpDir = queuedMpDir;
                const focus = queuedFocus;
                queuedTab = null;
                queuedMpDir = null;
                queuedFocus = false;
                if (tab === 'mp' && mpDir) {
                  void gameJs(`window.__steelseedSetMpDir && window.__steelseedSetMpDir(${JSON.stringify(mpDir)})`);
                }
                selectSession(tab);
                if (tab === 'mp' && focus) focusHost();
              }
            }, 1200);
          } else if (Date.now() > deadline) {
            clearInterval(timer);
            notifyLoader('fout');
          } else {
            void notifyProgress(Math.round((state.fraction ?? 0) * 100), state.stage);
          }
        })
        .catch(() => {});
    }, 500);
  }
  startBootWatch();

  // Players tile (refreshPlayersTile skips while multiplayer is off): once
  // now, then every 30 s while the landing is on screen; a landing that
  // shows again refreshes at once (openLanding).
  refreshPlayersTile();
  setInterval(() => {
    if (landingWin && !landingWin.isDestroyed() && landingWin.isVisible()) refreshPlayersTile();
  }, 30000);

  // ─── mp selftest gate: a room on the local node joined through the ws mux
  // — the committed, verified path. Gates may reload the game page; user
  // flows never do. ───
  let mpInFlight = false;
  let mpOrphanBaseline = new Set();
  const selftestMpGate = async () => {
    if (mpInFlight) return { ok: false, error: 'already running' };
    mpInFlight = true;
    if (gameWin.isDestroyed()) return { ok: false, error: 'window gone' };
    try {
      // T3.21.3: snapshot any pre-existing OpenRA.Server processes first —
      // a stray from an earlier run must never count as this run's orphan.
      const orphanBaseline = await openRaServerPids();
      // T3.2: the node exists only on demand — the mp gate starts it here
      // (the packaged selftest T3.15 goes through the real Host dialog).
      if (process.env.SELFTEST_MP === '1') await startLocalNode('lan');
      mpOrphanBaseline = orphanBaseline;
    } catch (err) {
      mpInFlight = false;
      return { ok: false, error: String(err?.message || err) };
    }
    const mpDir = `http://127.0.0.1:${MP_HTTP_PORT}`;
    try {
      const gate = nodeGateMap();
      const create = await fetch(`${mpDir}/v2/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-redline-node-key': nodeKey ?? '' },
        body: JSON.stringify({ map: gate.uid, slots: Math.min(5, gate.players ?? 2), name: 'Redline Wars host', solo: true }),
        signal: AbortSignal.timeout(5000),
      }).catch(err => {
        throw new Error(`room create fetch failed: ${err?.cause?.code || err?.cause?.message || err?.message}`);
      });
      let room;
      if (!create.ok) {
        if (create.status !== 503) throw new Error(`room create HTTP ${create.status}`);
        // 503 = the single match slot is taken: reuse the live room so a
        // second click never breaks the flow.
        const list = await fetch(`${mpDir}/v2/rooms`, { signal: AbortSignal.timeout(3000) })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null);
        room = (Array.isArray(list?.rooms) && list.rooms.length > 0) ? list.rooms[0] : null;
        if (!room) throw new Error('room create HTTP 503 and no live room');
        console.log(`[mp] reusing live room ${room.roomId} (${room.wsUrl})`);
      } else {
        room = (await create.json()).room;
      }
      if (!room?.wsUrl) throw new Error(`room create answered no wsUrl: ${JSON.stringify(room ?? null)}`);
      console.log(`[mp] room ${room.roomId} at ${room.wsUrl} (state ${room.state})`);
      // T3.21.3: `reserved` means the room's dedicated server accepts on
      // its port (booting ──accept probe──▶ reserved) — only then does a
      // join through the mux have something to dial.
      {
        const reservedDeadline = Date.now() + 60000;
        for (;;) {
          const list = await fetch(`${mpDir}/v2/rooms`, { signal: AbortSignal.timeout(3000) })
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null);
          const live = Array.isArray(list?.rooms) ? list.rooms.find(r => r.roomId === room.roomId) : null;
          if (live && ['reserved', 'lobby', 'playing'].includes(live.state)) break;
          if (Date.now() > reservedDeadline) throw new Error(`room never reached reserved (state ${live?.state ?? 'gone'})`);
          await new Promise(r => setTimeout(r, 500));
        }
        console.log('[mp] room reserved');
      }
      const quality = loadSettings().quality;
      const gameUrl = `http://127.0.0.1:${port}/steelseed/index.html?session=mp&mp=1&Player.Name=Host&${qualityParam(quality)}`;
      const preflight = await fetch(`http://127.0.0.1:${port}/steelseed/index.html`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.status)
        .catch(e => `FAIL ${e?.cause?.code || e?.message || e}`);
      console.log(`[mp] server preflight ${preflight}`);
      if (typeof preflight !== 'number' || preflight >= 400) {
        throw new Error(`game server not serving (preflight ${preflight})`);
      }
      await gameWin
        .loadURL(gameUrl)
        .catch(err => {
          // ERR_ABORTED (-3): a superseded provisional navigation is benign —
          // the boot poll below decides when the page is really up.
          if (!String(err?.message || err).includes('ERR_ABORTED')) throw err;
        });
      // The join runs visibly: the gate watches the same styled boot meter.
      presentGame();
      if (landingWin && !landingWin.isDestroyed()) landingWin.close();
      const bootDeadline = Date.now() + 240000;
      let booted = false;
      while (Date.now() < bootDeadline && !booted && !gameWin.isDestroyed()) {
        booted = await gameWin.webContents
          .executeJavaScript(SELFTEST_GPU_OFF
            // T3.21.2: no adapter — the sim host's bridge is readiness.
            ? '(() => !!globalThis.steelseedBridge)()'
            : `(() => { const b = document.getElementById('boot'); return !!b && (b.classList.contains('done') || b.hidden === true); })()`)
          .catch(() => false);
        if (!booted) await new Promise(r => setTimeout(r, 500));
      }
      mpInFlight = false;
      if (!booted) throw new Error('engine boot timed out');
      const js = code => gameWin.webContents.executeJavaScript(code);
      const muxPort = Number(new URL(room.wsUrl.replace(/^ws/, 'http')).port);
      console.log(`[mp] joining mux 127.0.0.1:${muxPort} via ${room.wsUrl} (room ${room.roomId})`);
      console.log('[mp] ' + await js(`globalThis.ora.SetWsEndpoint(${JSON.stringify(room.wsUrl)})`));
      const joined = await js(`globalThis.ora.JoinMultiplayer('127.0.0.1', ${muxPort}, '')`);
      console.log('[mp] ' + joined);
      const probe = () => js('globalThis.ora.GetConnectionProbe()');
      const until = async (re, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const s = String(await probe());
          if (re.test(s)) return s;
          await new Promise(r => setTimeout(r, 750));
        }
        return '';
      };
      await until(/state=Connected/, 60000);
      console.log('[mp] ' + (await js('globalThis.ora.LobbyClaimPlayerSlot()')));
      await until(/clientstate=(NotReady|Ready)/, 30000);
      console.log('[mp] ' + (await js('globalThis.ora.LobbyAddBots()')));
      await js('globalThis.ora.LobbySetReady()');
      await until(/clientstate=Ready/, 30000);
      let probeText = String(await probe());
      if (!/started=True/.test(probeText)) await js('globalThis.ora.LobbyStartGame()');
      probeText = await until(/started=True/, 120000);
      // Let lockstep run: the gate demands 50+ advanced netframes, not a start.
      const settleEnd = Date.now() + 60000;
      while (Date.now() < settleEnd) {
        probeText = String(await probe());
        if (Number(/netframe=([^ ]+)/.exec(probeText)?.[1] ?? 0) >= 50) break;
        await new Promise(r => setTimeout(r, 750));
      }
      const netframe = Number(/netframe=([^ ]+)/.exec(probeText)?.[1] ?? 0);
      const outofsync = /outofsync=False/.test(probeText) ? 'False' : String(/outofsync=([^ ]+)/.exec(probeText)?.[1] ?? 'unknown');
      console.log(`[mp] started, netframe=${netframe}, outofsync=${outofsync}`);
      // T3.21.3: host-stop (the same stopNode() the host-stop IPC handler
      // runs), then prove no OpenRA.Server outlived the node.
      await stopNode();
      const noOrphan = await waitServersGone(mpOrphanBaseline);
      console.log(`[mp] node stopped, orphans: ${noOrphan ? 'none' : 'LEFT BEHIND'}`);
      return { ok: /started=True/.test(probeText), netframe, outofsync, noOrphan };
    } catch (err) {
      const message = String(err?.message || err);
      console.error('[mp] ' + message);
      if (!SELFTEST && !gameWin.isDestroyed()) dialog.showErrorBox('Multiplayer', message);
      mpInFlight = false;
      return { ok: false, error: message };
    }
  };

  // SELFTEST_WALK gate: proves boot-once navigation — the landing returns,
  // both session tabs switch in-page, and the game page never reloads. The
  // mp step pins the LOCAL node directory so the external-hosts check
  // stays honest (the relay is not part of this gate).
  const walkFlow = async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const js = code => gameWin.webContents.executeJavaScript(code).catch(() => null);
    const loadsBefore = gameLoads;
    console.log('[walk] start');
    enterGame('skirmish');
    await sleep(1500);
    const skirm = await js(`(() => { const r = document.getElementById('session-ui'); return { shown: !!r && r.hidden === false, tab: document.getElementById('session-tab-skirmish')?.getAttribute('aria-selected') ?? '' }; })()`);
    console.log('[walk] skirmish state', JSON.stringify(skirm));
    if (!skirm || skirm.shown !== true || skirm.tab !== 'true') throw new Error('skirmish screen not shown in-page');
    if (await js(`(() => document.getElementById('session-tab-mp')?.hidden === true)()`) !== true) throw new Error('mp tab not hidden in skirmish mode');
    backToMain();
    await sleep(900);
    const landingBack = !!landingWin && !landingWin.isDestroyed() && landingWin.isVisible();
    console.log('[walk] landing back', landingBack);
    if (!landingBack) throw new Error('landing not visible after back-to-main');
    if (!gameWin.isDestroyed() && gameWin.isVisible()) throw new Error('game window still visible after back-to-main');
    const localDir = `http://127.0.0.1:${MP_HTTP_PORT}`;
    console.log('[walk] entering mp');
    await js(`window.__steelseedSetMpDir && window.__steelseedSetMpDir(${JSON.stringify(localDir)})`);
    await js(`window.__steelseedSelectSession && window.__steelseedSelectSession('mp')`);
    swapToGame();
    await sleep(1500);
    const mp = await js(`(() => { return { tab: document.getElementById('session-tab-mp')?.getAttribute('aria-selected') ?? '' }; })()`);
    console.log('[walk] mp state', JSON.stringify(mp));
    if (!mp || mp.tab !== 'true') throw new Error('mp tab not selected in-page');
    if (await js(`(() => document.getElementById('session-tab-skirmish')?.hidden === true)()`) !== true) throw new Error('skirmish tab not hidden in mp mode');
    if (gameLoads !== loadsBefore) throw new Error(`game page reloaded during walk (${loadsBefore} -> ${gameLoads})`);
    return { ok: true, loads: gameLoads };
  };

  notifyLoader('laden');

  if (SELFTEST) {
    const withMp = process.env.SELFTEST_MP === '1';
    const mpOnce = () => {
      if (!mpFlowPromise) {
        mpFlowPromise = selftestMpGate().catch(err => ({ ok: false, error: String(err?.message || err) }));
      }
      return mpFlowPromise;
    };
    // T3.21.2: SELFTEST_GPU=0 skips the UI walk — no adapter, no presented
    // session UI to click through.
    runSelftest({ gameWin }, t0, withMp ? mpOnce : null,
      process.env.SELFTEST_WALK === '1' && !SELFTEST_GPU_OFF ? walkFlow : null);
  }
}

// §5.9: a directory override may only name the relay host, a private/
// loopback/link-local IP or a .local name — never an arbitrary host.
function isDirectoryHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (host === new URL(RELAY_DIR).hostname) return true;
  if (host.endsWith('.local')) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const bare = host.slice(1, -1);
    return bare === '::1' || bare === '::'
      || /^f[cd][0-9a-f]{2}:/.test(bare)
      || /^fe[89ab][0-9a-f]:/.test(bare);
  }
  return false;
}

// T3.11: pages navigate only inside the app — the game origin and the
// landing file. Page-initiated popups are always denied.
function hardenWebContents(win) {
  const landingFile = pathToFileURL(path.join(import.meta.dirname, 'shell', 'landing.html')).toString();
  win.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      const target = new URL(url);
      allowed = target.origin === `http://127.0.0.1:${lastPort}`
        || (target.protocol === 'file:' && target.toString().split('?')[0] === landingFile);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      console.warn('[shell] blocked navigation: ' + url);
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createLandingWindow(port, musicUrl, { intro = false, visible = !SELFTEST && !HEADLESS, bounds = null } = {}) {
  const win = new BrowserWindow({
    width: 1512,
    height: 982,
    // A landing rebuilt after a game takes the game's frame (backToMain).
    ...(bounds && { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#090D11',
    title: 'Redline Wars',
    show: visible, // --headless keeps the app in the tray.
    webPreferences: {
      backgroundThrottling: false,
      // The theme plays the moment the landing opens — the launch click is
      // the only gesture, and it happened before this window existed.
      autoplayPolicy: 'no-user-gesture-required',
      // T3.11: every window runs isolated and sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
    },
  });
  // A hidden landing stays silent (--headless, a donating app in the tray):
  // the theme is for a menu someone can see. 'show' unmutes it (openLanding).
  if (!visible) win.webContents.setAudioMuted(true);
  keepWindowForDonation(win);
  hardenWebContents(win);
  void win.loadFile(path.join(import.meta.dirname, 'shell', 'landing.html'), {
    query: landingQuery({ port, music: musicUrl, intro, visible }),
  });
  return win;
}

// §3.2: one way to make a landing — the first at boot and every one rebuilt
// later (back to the menu, the tray). Each gets the quit hook, the
// visibility wiring and a replay of the shell state on every load.
function openLanding({ intro = false, visible = true, bounds = null } = {}) {
  const win = createLandingWindow(lastPort, lastMusicUrl, { intro, visible, bounds });
  landingWin = win;
  win.on('closed', () => {
    // The game window preloads hidden. Closing the visible menu must quit unless
    // a game was actually presented; swapToGame shows it before closing here.
    // A donating app stays tray-resident instead (keepWindowForDonation).
    if (donateStarting || nodeMode === 'donate') {
      ensureDonateTray();
      return;
    }
    if (!gameWin || gameWin.isDestroyed() || !gameWin.isVisible()) app.quit();
  });
  win.on('show', () => {
    landingVisible(win, true);
    refreshPlayersTile();
  });
  win.on('hide', () => landingVisible(win, false));
  win.webContents.on('did-finish-load', () => replayLandingState(win));
  return win;
}

// The page plays the theme only while its window is on screen; the mute is
// the shell's own guarantee for pages that do not listen.
function landingVisible(win, visible) {
  try {
    if (win.isDestroyed()) return;
    win.webContents.setAudioMuted(!visible);
    void win.webContents
      .executeJavaScript(`window.__redlineLandingVisible && window.__redlineLandingVisible(${visible ? 'true' : 'false'})`)
      .catch(() => {});
  } catch { /* the window is closing */ }
}

// Everything the shell already knows, handed to a landing that (re)loaded.
function replayLandingState(win) {
  if (win.isDestroyed()) return;
  const run = code => void win.webContents.executeJavaScript(code).catch(() => {});
  run(`window.__redlineLandingVisible && window.__redlineLandingVisible(${win.isVisible() ? 'true' : 'false'})`);
  run(`window.setMusicIcon && window.setMusicIcon(${loadSettings().music !== false ? 'true' : 'false'})`);
  run(`window.__redlineMultiplayer && window.__redlineMultiplayer(${JSON.stringify({ on: mpOn() })})`);
  run(`window.__redlineDonateStatus && window.__redlineDonateStatus(${JSON.stringify(donateStatus())})`);
  // Any update verdict already known.
  if (updateRequired) run(`window.__redlineUpdateRequired && window.__redlineUpdateRequired(${JSON.stringify(updateRequired)})`);
  // setLoader('laden') resets the stage caption, 'klaar' and 'fout' are final:
  // the progress goes after a running state and before a final one.
  const { loader, pct, stage } = landingState;
  const state = `window.setLoader && window.setLoader(${JSON.stringify(loader)})`;
  const progress = pct > 0 || stage
    ? `window.setLoaderProgress && window.setLoaderProgress(${JSON.stringify(pct)}, ${JSON.stringify(stage)})`
    : '';
  const final = loader === 'klaar' || loader === 'fout';
  for (const code of final ? [progress, state] : [state, progress]) if (code) run(code);
  if (landingState.players !== null) run(`window.setPlayers && window.setPlayers(${JSON.stringify(landingState.players)})`);
}

// The tray's Openen: the landing as it is, or a rebuilt one — never an intro.
function showLanding() {
  if (!landingWin || landingWin.isDestroyed()) openLanding({ intro: false });
  landingWin.show();
}

let gameLoads = 0;

function createGameWindow() {
  const win = new BrowserWindow({
    width: 1512,
    height: 982,
    minWidth: 1024,
    minHeight: 700,
    title: 'Redline Wars',
    // Hidden while it boots: the landing stays on top until the first visuals.
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      // The soundtrack must start with the first visuals; the click that
      // launched the app happened on the landing window, so media needs no
      // further gesture in this one. The preload publishes
      // window.backToMain: the in-game menu exits WITHOUT a page reload.
      autoplayPolicy: 'no-user-gesture-required',
      // T3.11: every window runs isolated and sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the preloaded game renderer painted while the landing window is
      // visible; a hidden zero-surface renderer can otherwise report neither
      // WebGPU nor WebGL2 on some Electron/Linux drivers.
      paintWhenInitiallyHidden: true,
      webgl: true,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
    },
  });
  keepWindowForDonation(win);
  hardenWebContents(win);
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[game] renderer gone:', details.reason, details.exitCode);
  });
  win.webContents.on('did-finish-load', () => {
    gameLoads += 1;
    if (SELFTEST) console.log(`[selftest] game page did-finish-load (${gameLoads})`);
    void probeRendererCapability(win).then(capability => {
      rendererCapability = capability;
      if (!capability.ok) console.error('[gpu] Renderer capability probe failed:', JSON.stringify({ capability, electron: electronGpuDiagnostics }));
      else console.log('[gpu] Renderer capability:', JSON.stringify(capability));
    });
    // A quality change reboots the page: hand the fresh page the shell
    // state it feature-detects (§5.9).
    if (nodeChild && nodeKey) publishLocalNode({ dir: nodeApiUrl(), key: nodeKey });
    publishUpdateRequired();
    // §3.3: the landing's Multiplayer switch (the page also reads it through
    // redline.getMultiplayerSync()).
    void win.webContents
      .executeJavaScript(`window.__steelseedSetMultiplayer && window.__steelseedSetMultiplayer(${mpOn() ? 'true' : 'false'})`)
      .catch(() => {});
  });
  // The game window stays hidden until a flow shows it explicitly
  // (swapToGame for skirmish, the mp flow for multiplayer): ready-to-show
  // never fires for a never-shown window in this Electron build.
  return win;
}


let mpFlowPromise = null;
let mpConsoleTail = null;

function runSelftest({ gameWin }, t0, startMp, walkFn) {
  const hosts = new Set();
  const consoleTail = [];
  mpConsoleTail = consoleTail;
  for (const w of [landingWin, gameWin]) {
    trackHosts(w, hosts);
    w.webContents.on('console-message', event => {
      const text = String(event?.message ?? '').slice(0, 200);
      if (text) {
        consoleTail.push(text);
        if (consoleTail.length > 12) consoleTail.shift();
      }
    });
  }
  landingWin.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        fs.writeFileSync('/tmp/electron-landing.png', (await landingWin.webContents.capturePage()).toPNG());
      } catch {
        // Landing proof is best-effort; the game capture decides the verdict.
      }
      try {
        const landing = await landingWin.webContents.executeJavaScript(`(() => ({ music: (() => { const a = document.getElementById('landing-music'); return a ? { src: (a.src || '').split('/').pop(), paused: a.paused, vol: a.volume } : null; })(), loader: (() => { const p = document.getElementById('loader-pct'); const t = document.getElementById('loader-text'); return { pct: p ? p.textContent : null, text: t ? t.textContent : null }; })() }))()`);
        console.log('[selftest] landing probe', JSON.stringify(landing));
      } catch {
        // Probe is best-effort evidence, never a gate.
      }
    }, 4000);
  });

  const deadline = Date.now() + 240000;
  const finish = async booted => {
    if (selftestFinished) return;
    selftestFinished = true;
    console.log(`[selftest] finish booted=${booted} at ${Math.round(Date.now() - t0)}ms`);
    const ms = booted ? Date.now() - t0 : -1;
    if (booted) {
      rendererCapability = rendererCapability ?? await probeRendererCapability(gameWin);
      if (!SELFTEST_GPU_OFF && !rendererCapability.ok) {
        const result = selftestResult(false, -1, [...hosts].sort(), 0, rendererCapability);
        result.error = 'Electron renderer has neither WebGPU nor WebGL2';
        result.consoleTail = consoleTail;
        emitSelftest(result, 1);
        return;
      }
      // Multiplayer gate: room on the local node, join via the mux, bots,
      // ready, start, lockstep frames advancing without desync.
      let mp = null;
      if (startMp) {
        try {
          mp = await startMp();
        } catch (err) {
          mp = { ok: false, error: String(err?.message || err) };
        }
        if (!mp.ok) {
          const result = selftestResult(false, -1, [...hosts].sort(), 0);
          result.mp = mp;
          result.consoleTail = consoleTail;
          emitSelftest(result, 1);
          return;
        }
      }
      // Walk gate (SELFTEST_WALK=1): landing → skirmish → back → mp with
      // zero page loads — the boot-once navigation contract.
      let walk = null;
      if (walkFn) {
        try {
          walk = await walkFn();
        } catch (err) {
          walk = { ok: false, error: String(err?.message || err) };
        }
        if (!walk.ok) {
          const result = selftestResult(false, -1, [...hosts].sort(), 0);
          result.walk = walk;
          result.consoleTail = consoleTail;
          emitSelftest(result, 1);
          return;
        }
      }
      // T3.21.2: without a GPU there is nothing to capture — the bridge is
      // the whole readiness story and the verdict rests on the mp flow.
      let nonBlackRatio = 0;
      if (!SELFTEST_GPU_OFF) {
        // A few frames must present before capture, so the world is on screen.
        for (let attempt = 0; attempt < 4 && nonBlackRatio < 0.5; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          try {
            nonBlackRatio = nonBlackRatioOf(await gameWin.webContents.capturePage());
          } catch {
            // Failed capture counts as black; the retry loop keeps going.
          }
        }
      }
      const externalHosts = [...hosts].sort();
      const mpOk = !startMp || (mp.ok && mp.netframe >= 50 && mp.outofsync === 'False');
      const noOrphan = !startMp || mp.noOrphan === true;
      const walkOk = !walkFn || (walk && walk.ok === true);
      const pass = SELFTEST_GPU_OFF
        // T3.21.4: adapter-less verdict — hosting hygiene + the full match.
        ? externalHosts.length === 0 && mpOk && noOrphan
        : externalHosts.length === 0 && nonBlackRatio > 0.5 && mpOk && walkOk;
      const result = selftestResult(
        pass,
        ms,
        externalHosts,
        nonBlackRatio,
      );
      if (mp) result.mp = mp;
      if (walk) result.walk = walk;
      if (!result.pass) result.consoleTail = consoleTail;
      emitSelftest(result, result.pass ? 0 : 1);
    } else {
      const result = selftestResult(false, -1, [...hosts].sort(), 0);
      result.consoleTail = consoleTail;
      emitSelftest(result, 1);
    }
  };

  const timer = setInterval(() => {
    if (gameWin.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    gameWin.webContents
      .executeJavaScript(
        SELFTEST_GPU_OFF
          // T3.21.2: no adapter — the sim host boots in its worker and the
          // bridge appears regardless of the presentation, unlike #boot.
          ? '(() => !!globalThis.steelseedBridge)()'
          : `(() => { const b = document.getElementById('boot'); return !b || b.classList.contains('done') || b.hidden === true; })()`,
      )
      .then(value => {
        if (value === true) {
          clearInterval(timer);
          void finish(true);
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          void finish(false);
        }
      })
      .catch(() => {});
  }, 500);
  // A wedged renderer can leave executeJavaScript() pending forever. The
  // interval's deadline is checked only after that promise resolves, so keep
  // an independent wall-clock watchdog that always records a failed gate and
  // tears down the app instead of hanging release validation indefinitely.
  setTimeout(() => {
    if (selftestEmitted) return;
    clearInterval(timer);
    const result = selftestResult(false, -1, [...hosts].sort(), 0);
    result.error = 'engine boot/selftest exceeded 240 seconds';
    result.consoleTail = consoleTail;
    emitSelftest(result, 1);
  }, 240000);
}

app.whenReady().then(() => void boot());

// T3.9: quit guard — a hosted match with other players in it asks first.
app.on('before-quit', event => {
  if (quitConfirmed || !nodeChild) return;
  // Decide asynchronously: hold the quit, ask, then either continue or stay.
  event.preventDefault();
  void (async () => {
    const health = await nodeHealth(1500);
    // A donated node has no local owner seat: one connected player is enough
    // to make quitting destructive. Own hosting retains the legacy two-player
    // guard because a lone owner can still close an empty lobby safely.
    const playersInHostedMatch = Number(health?.players ?? 0);
    if (playersInHostedMatch > (nodeMode === 'donate' ? 0 : 1)) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Redline Wars',
        message: 'Er zitten spelers in jouw match — afsluiten beëindigt het spel voor iedereen.',
        buttons: ['Toch afsluiten', 'Annuleren'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return; // stay in the match
    }
    quitConfirmed = true;
    killServer();
    stopLanListener();
    await stopNode();
    app.quit();
  })();
});
app.on('before-quit', () => {
  if (SELFTEST) console.log('[selftest] before-quit, windows:', landingWin && !landingWin.isDestroyed(), gameWin && !gameWin.isDestroyed());
});
app.on('window-all-closed', () => {
  if (SELFTEST) console.log('[selftest] window-all-closed, page console tail:', JSON.stringify(mpConsoleTail ?? null));
  if (nodeMode === 'donate' || donateStarting) {
    ensureDonateTray();
    return;
  }
  killServer();
  stopLanListener();
  void stopNode();
  app.quit();
});
// Every real quit (Cmd+Q, the menu, the tray) ends here. window-all-closed does
// not fire for app.quit(), and the quit guard returns early when nothing is
// hosted, so without this the web server and LAN listener outlive the app and
// hold 18077-18082 until a later launch finds no free port.
app.on('will-quit', () => {
  killServer();
  stopLanListener();
});
