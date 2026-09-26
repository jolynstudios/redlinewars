import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  DEFAULT_DONATE_HOSTING,
  DONATE_MAX_MATCHES,
  DONATE_MAX_MATCHES_LIMIT,
  DEFAULT_DONATE,
  S24_DONATE_CONFIRMATION,
  donateConfig,
  normalizeDonateConfig,
  donateHostingEnabled,
  withDonateHosting,
  withDonateConfig,
  rendererDonatePatch,
  donateConsentCurrent,
  DONATE_CONSENT_VERSION,
  donateNodeArgs,
  nodeModeCanSwitch,
  keepsNodeForEmptyRooms,
} from './donate-hosting.mjs';

test('consent saved before the renderer boundary fix is asked for again', () => {
  assert.equal(donateConsentCurrent(normalizeDonateConfig({ enabled: true, consentSeen: true })), false);
  assert.equal(donateConsentCurrent(normalizeDonateConfig({ enabled: true, consentSeen: true, consentVersion: DONATE_CONSENT_VERSION })), true);
  assert.equal(donateConsentCurrent(normalizeDonateConfig({ consentVersion: DONATE_CONSENT_VERSION })), false);
  assert.deepEqual(rendererDonatePatch({ consentVersion: DONATE_CONSENT_VERSION }), {});
  const main = fs.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /if \(donateConsentCurrent\(donate\)\) void startDonateNode\(\);\s*else if \(donate\.consentSeen\) void setDonateConfig\(\{ enabled: true \}\);/);
  assert.match(main, /if \(!config\.enabled \|\| !donateConsentCurrent\(config\)\) return donateStatus\(\);/);
  assert.match(main, /nextPatch\.consentSeen = true;\s*nextPatch\.consentVersion = DONATE_CONSENT_VERSION;/);
  // Declining the renewed consent switches a stale opt-in off instead of nagging at every launch.
  assert.match(main, /if \(response !== 0\) \{[\s\S]{0,300}if \(current\.enabled\) \{\s*saveSettings\(withDonateConfig\(loadSettings\(\), \{ enabled: false \}\)\);/);
});

test('a page can toggle donation but never record consent itself', () => {
  assert.deepEqual(rendererDonatePatch({ consentSeen: true, enabled: true, maxMatches: 2, extra: 1 }), { enabled: true, maxMatches: 2 });
  assert.deepEqual(rendererDonatePatch({ consentSeen: true }), {});
  assert.deepEqual(rendererDonatePatch(null), {});
  const main = fs.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('donate-set-config', \(_e, patch\) => setDonateConfig\(rendererDonatePatch\(patch\)\)\)/);
});

test('donated hosting is default-off and persists only by explicit opt-in', () => {
  assert.equal(DEFAULT_DONATE_HOSTING, false);
  assert.equal(donateHostingEnabled({}), false);
  assert.equal(donateHostingEnabled(withDonateHosting({}, true)), true);
  assert.equal(donateHostingEnabled(withDonateHosting({ donateHosting: true }, false)), false);
});

test('T6.5 uses a bounded structured donation setting and migrates the old boolean', () => {
  assert.deepEqual(DEFAULT_DONATE, { enabled: false, maxMatches: 1, consentSeen: false, consentVersion: 0 });
  assert.deepEqual(donateConfig({}), { enabled: false, maxMatches: 1, consentSeen: false, consentVersion: 0 });
  assert.deepEqual(donateConfig({ donateHosting: true }), { enabled: true, maxMatches: 1, consentSeen: false, consentVersion: 0 });
  assert.deepEqual(normalizeDonateConfig({ enabled: true, maxMatches: 99, consentSeen: true }), { enabled: true, maxMatches: DONATE_MAX_MATCHES_LIMIT, consentSeen: true, consentVersion: 0 });
  assert.deepEqual(withDonateConfig({}, { enabled: true, maxMatches: 2, consentSeen: true }).donate, { enabled: true, maxMatches: 2, consentSeen: true, consentVersion: 0 });
  assert.match(S24_DONATE_CONFIRMATION, /ook als je zelf niet speelt/);
});

test('donated capacity launches the assembled node in donate mode', () => {
  const args = donateNodeArgs({
    script: '/engine/steelseed-host/tools/node-cli.mjs',
    mux: 14710,
    http: 14711,
    dataDir: '/user/node',
    bundle: '/engine/bin-browser/AppBundle',
    nodeKeyFile: '/user/node/node.key',
    spineUrl: 'wss://spine.redlinewars.online/node',
  });
  assert.equal(args[args.indexOf('--mode') + 1], 'donate');
  assert.equal(args[args.indexOf('--data-dir') + 1], '/user/node');
  assert.equal(args[args.indexOf('--max-matches') + 1], String(DONATE_MAX_MATCHES));
  assert.equal(args[args.indexOf('--bundle') + 1], '/engine/bin-browser/AppBundle');
  assert.equal(args[args.indexOf('--spine') + 1], 'wss://spine.redlinewars.online/node');
});

test('own and donated modes are mutually exclusive through a controlled switch', () => {
  assert.equal(nodeModeCanSwitch(null, 'donate'), true);
  assert.equal(nodeModeCanSwitch('donate', 'own'), true);
  assert.equal(nodeModeCanSwitch('own', 'donate'), true);
	assert.equal(nodeModeCanSwitch('donate', 'own', 1), false);
	assert.equal(nodeModeCanSwitch('donate', 'own', 2), false);
	assert.equal(nodeModeCanSwitch('own', 'donate', 1), false);
  assert.equal(keepsNodeForEmptyRooms('donate'), true);
  assert.equal(keepsNodeForEmptyRooms('own'), false);
});

test('every quit stops the local web server and the LAN listener', () => {
  const main = fs.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /app\.on\('will-quit', \(\) => \{\s*killServer\(\);\s*stopLanListener\(\);/);
});

test('shutdown cleans the node while donation keeps a tray-resident app alive', () => {
  const main = fs.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /app\.on\('before-quit'[\s\S]+await stopNode\(\)/);
  assert.match(main, /if \(nodeMode === 'donate' \|\| donateStarting\) \{[\s\S]+ensureDonateTray\(\)/);
  assert.match(main, /function keepWindowForDonation\(win\)/);
  assert.match(main, /const HEADLESS = process\.argv\.includes\('--headless'\)/);
  assert.match(main, /function drainDonateNode\(\)/);
  assert.match(main, /\/v2\/drain/);
  assert.match(main, /playersInHostedMatch > \(nodeMode === 'donate' \? 0 : 1\)/);
	assert.match(main, /Shared matches are still active/);
	assert.match(main, /if \(nodeMode === 'donate'\) await drainDonateNode\(\)/);
});

test('tray exposes live counts and a safe drain action', () => {
  const main = fs.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /matches · \$\{status\.players\} spelers/);
  assert.match(main, /Stoppen na huidige matches/);
  assert.match(main, /freeMatches: 0/);
});
