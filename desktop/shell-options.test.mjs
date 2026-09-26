import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MULTIPLAYER,
  LEGAL_DOCS,
  LEGAL_LONG,
  LEGAL_SHORT,
  LEGAL_SOURCES,
  LEGAL_TEXT_MAX_BYTES,
  SOURCE_URL,
  WEBSITE_PAGES,
  DEFAULT_QUALITY,
  qualityParam,
  landingQuery,
  legalDocPath,
  multiplayerEnabled,
  websitePage,
  withMultiplayer,
} from './shell-options.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const main = fs.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');

// The body of a top-level `function name(` / `async function name(` in main.mjs.
function mainFunction(name) {
  const start = main.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `main.mjs has no function ${name}`);
  const end = main.indexOf('\n}\n', start);
  return main.slice(start, end + 2);
}

test('multiplayer is on by default and only an explicit boolean turns it off', () => {
  assert.equal(DEFAULT_MULTIPLAYER, true);
  assert.equal(multiplayerEnabled({}), true);
  assert.equal(multiplayerEnabled(null), true);
  assert.equal(multiplayerEnabled(undefined), true);
  assert.equal(multiplayerEnabled({ multiplayer: true }), true);
  assert.equal(multiplayerEnabled({ multiplayer: false }), false);
  // A hand-edited value that is not a boolean falls back to the default.
  assert.equal(multiplayerEnabled({ multiplayer: 'false' }), true);
  assert.equal(multiplayerEnabled({ multiplayer: 0 }), true);
});

test('--selftest and --headless always run with multiplayer on', () => {
  assert.equal(multiplayerEnabled({ multiplayer: false }, { selftest: true }), true);
  assert.equal(multiplayerEnabled({ multiplayer: false }, { headless: true }), true);
  assert.equal(multiplayerEnabled({ multiplayer: false }, { selftest: false, headless: false }), false);
});

test('the switch persists as a plain boolean next to the other settings', () => {
  const settings = { quality: 'ultra', donate: { enabled: true } };
  assert.deepEqual(withMultiplayer(settings, false), { quality: 'ultra', donate: { enabled: true }, multiplayer: false });
  assert.deepEqual(withMultiplayer(settings, true).multiplayer, true);
  assert.equal(withMultiplayer(settings, 'yes').multiplayer, false);
  assert.equal(withMultiplayer(null, true).multiplayer, true);
  assert.equal(Object.hasOwn(settings, 'multiplayer'), false, 'the input settings are not mutated');
});

test('the landing query is all strings and says whether to play the intro and the theme', () => {
  assert.deepEqual(landingQuery({ port: 18077, music: 'http://127.0.0.1:18077/steelseed/assets/theme.m4a', intro: true, visible: true }), {
    port: '18077',
    music: 'http://127.0.0.1:18077/steelseed/assets/theme.m4a',
    intro: '1',
    visible: '1',
  });
  assert.deepEqual(landingQuery({ port: 18078, music: '', intro: false, visible: false }), { port: '18078', music: '', intro: '0', visible: '0' });
  assert.deepEqual(landingQuery({ port: 18079 }), { port: '18079', music: '', intro: '0', visible: '1' });
  assert.deepEqual(landingQuery({ port: 18080, music: null }), { port: '18080', music: '', intro: '0', visible: '1' });
  for (const value of Object.values(landingQuery({ port: 1, music: 'x', intro: true, visible: false }))) assert.equal(typeof value, 'string');
});

test('legal texts resolve by allowlisted name only', () => {
  assert.deepEqual(Object.keys(LEGAL_DOCS).sort(), ['authors', 'gpl', 'gpl-2.0', 'lgpl-2.1', 'lgpl-3.0', 'license', 'notices', 'ofl-archivo', 'ofl-martian-mono']);
  assert.deepEqual(Object.keys(LEGAL_SOURCES).sort(), Object.keys(LEGAL_DOCS).sort());
  const packaged = { packaged: true, resourcesPath: '/app/resources', repoRoot: '/repo' };
  const checkout = { packaged: false, resourcesPath: '/app/resources', repoRoot: '/repo' };
  assert.equal(legalDocPath('license', packaged), path.join('/app/resources', 'legal', 'LICENSE.txt'));
  assert.equal(legalDocPath('gpl', packaged), path.join('/app/resources', 'legal', 'COPYING-GPLv3.txt'));
  assert.equal(legalDocPath('authors', packaged), path.join('/app/resources', 'legal', 'AUTHORS-OpenRA.txt'));
  assert.equal(legalDocPath('notices', packaged), path.join('/app/resources', 'legal', 'THIRD_PARTY_NOTICES.md'));
  assert.equal(legalDocPath('ofl-archivo', packaged), path.join('/app/resources', 'legal', 'fonts', 'archivo-OFL.txt'));
  assert.equal(legalDocPath('ofl-martian-mono', packaged), path.join('/app/resources', 'legal', 'fonts', 'martian-mono-OFL.txt'));
  assert.equal(legalDocPath('lgpl-2.1', packaged), path.join('/app/resources', 'legal', 'LGPL-2.1.txt'));
  assert.equal(legalDocPath('lgpl-3.0', checkout), path.join('/repo', 'engine', 'licenses', 'LGPL-3.0.txt'));
  assert.equal(legalDocPath('license', checkout), path.join('/repo', 'LICENSE'));
  assert.equal(legalDocPath('gpl', checkout), path.join('/repo', 'engine', 'COPYING'));
  assert.equal(legalDocPath('ofl-archivo', checkout), path.join('/repo', 'web', 'public', 'licenses', 'archivo-OFL.txt'));
  for (const name of ['', 'LICENSE', '../LICENSE', '/etc/passwd', 'constructor', '__proto__', 'toString', 'hasOwnProperty', undefined, null, 42, {}, ['license']])
    assert.equal(legalDocPath(name, packaged), null, `${String(name)} must not resolve`);
  assert.equal(LEGAL_TEXT_MAX_BYTES, 2 * 1024 * 1024);
});

test('every legal text exists in this checkout and fits the viewer', () => {
  for (const name of Object.keys(LEGAL_DOCS)) {
    const file = legalDocPath(name, { packaged: false, repoRoot });
    assert.ok(fs.existsSync(file), `${name}: ${file} is missing`);
    assert.ok(fs.statSync(file).size > 0 && fs.statSync(file).size <= LEGAL_TEXT_MAX_BYTES, `${name}: ${file} is empty or too large`);
  }
  assert.match(fs.readFileSync(legalDocPath('gpl', { repoRoot }), 'utf8'), /GNU GENERAL PUBLIC LICENSE\s+Version 3/);
  assert.match(fs.readFileSync(legalDocPath('ofl-archivo', { repoRoot }), 'utf8'), /SIL Open Font License, Version 1\.1/);
  assert.match(fs.readFileSync(legalDocPath('ofl-martian-mono', { repoRoot }), 'utf8'), /SIL Open Font License, Version 1\.1/);
});

test('the credits text is the one canonical wording', () => {
  assert.equal(SOURCE_URL, 'github.com/jolynstudios/redlinewars');
  assert.equal(LEGAL_LONG, [
    `© 2026 Jolyn Studios. The Redline Wars software is available under the GNU GPL v3 or later: the engine and our WebAssembly port, the WebGPU client, the desktop app, the multiplayer and server code and the tools. Source: ${SOURCE_URL}. Separately marked models, textures, audio, video and other creative files are under their own licences. The software licence grants no rights to our trademarks.`,
    'Engine: OpenRA © The OpenRA Developers and Contributors, GNU GPL v3 or later. Not affiliated with or endorsed by the OpenRA project.',
    'Maps from the OpenRA project, by their authors. Made with Suno (music), Cartesia (announcer voices), ElevenLabs (character voices, sound effects), Higgsfield (cinematics) and Meshy (Riki); all voices are text-to-speech. Base meshes and textures: MakeHuman, Quaternius, ambientCG (CC0); the soldiers build on the Female S.W.A.T Tactical Soldier model by pathumtharaka1998 on CGTrader (Royalty Free License). Typefaces: Archivo and Martian Mono (SIL OFL 1.1). Third-party licences and credits: see the notices.',
    'Command & Conquer and Red Alert are trademarks of Electronic Arts Inc. EA has not endorsed and does not support this product.',
  ].join('\n\n'));
  assert.equal(LEGAL_SHORT, '© 2026 Jolyn Studios · Engine: OpenRA (GPLv3) · EA has not endorsed and does not support this product.');
  // The engine is OpenRA's: never "original engine code". The software is GPL, so nothing in the
  // credits reserves it, and the in-game credits name nobody (the website's credits page does).
  for (const text of [LEGAL_LONG, LEGAL_SHORT, main]) assert.doesNotMatch(text, /original engine code/i);
  assert.doesNotMatch(LEGAL_LONG, /all rights reserved/i);
  assert.match(LEGAL_LONG.split('\n\n')[0], /^© 2026 Jolyn Studios\. The Redline Wars software is available under the GNU GPL v3 or later/);
  assert.doesNotMatch(LEGAL_LONG + LEGAL_SHORT, /Felixdaal|Ozler|\bIsa\b|Jermaine|Sebastiaan|Steur|Rikie|Anthony/);
});

test('the website opens only its home page or an allowlisted page', () => {
  assert.equal(websitePage('credits'), 'https://www.redlinewars.online/credits');
  assert.equal(websitePage('issues'), 'https://github.com/jolynstudios/redlinewars/issues');
  assert.deepEqual(Object.keys(WEBSITE_PAGES), ['credits', 'issues']);
  for (const page of [undefined, '', 'https://evil.example', '__proto__', 'constructor', 42]) assert.equal(websitePage(page), null);
  assert.match(main, /ipcMain\.on\('open-website', \(_e, page\) => void shell\.openExternal\(websitePage\(page\) \?\? WEBSITE_URL\)\)/);
});

test('the credits dialog and About panel carry the shared text', () => {
  assert.match(main, /detail: LEGAL_LONG,/);
  assert.match(main, /buttons: \['OK', 'Licenties bekijken'\]/);
  assert.match(main, /shell\.openPath\(file\)/);
  assert.match(main, /app\.setAboutPanelOptions\(\{[\s\S]{0,200}copyright: LEGAL_SHORT,[\s\S]{0,120}credits: 'Engine: OpenRA © The OpenRA Developers and Contributors \(GPLv3\)'/);
  assert.match(main, /label: 'Credits & licenties…', click: \(\) => openCredits\(\)/);
  assert.match(main, /window\.__redlineOpenCredits\(\)/);
  assert.match(main, /ipcMain\.handle\('legal-text', async \(_e, name\) => \{\s*const file = legalDocPath\(name, legalRoots\(\)\);\s*if \(!file\) return null;/);
});

test('multiplayer off: nothing hosts, nothing listens, donation drains', () => {
  // The guard sits right after startDonateNode's first line, before the regex-tested one.
  assert.match(mainFunction('startDonateNode'), /^async function startDonateNode\(\) \{\n  const config = donateConfig\(loadSettings\(\)\);\n  if \(!mpOn\(\)\) return \{ \.\.\.donateStatus\(\), multiplayerOff: true \};\n  if \(!config\.enabled \|\| !donateConsentCurrent\(config\)\) return donateStatus\(\);/);
  // setDonateConfig refuses enabling BEFORE the consent dialog can open.
  const setDonate = mainFunction('setDonateConfig');
  const refusal = setDonate.indexOf('if (wantsEnabled && !mpOn()) return { ...donateStatus(), multiplayerOff: true };');
  assert.ok(refusal > 0 && refusal < setDonate.indexOf('dialog.showMessageBox'), 'the multiplayer refusal must precede the consent dialog');
  // Disabling asks the node itself; no answer is not proof of zero rooms.
  assert.match(setDonate, /const health = await nodeHealth\(\);\s*const rooms = health \? Number\(health\.rooms \?\? 0\) : Math\.max\(1, Number\(lastNodeHealth\?\.rooms \?\? 0\)\);\s*if \(rooms > 0\) await drainDonateNode\(\);\s*else await stopNode\(\);/);
  // Boot resumes donation only with the switch on.
  assert.match(main, /if \(donateHostingEnabled\(settings\) && !SELFTEST && mpOn\(\)\) \{/);
  const setMp = mainFunction('setMultiplayer');
  assert.match(setMp, /saveSettings\(withMultiplayer\(loadSettings\(\), on === true\)\)/);
  assert.match(setMp, /getMenuItemById\('menu-multiplayer'\)/);
  assert.match(setMp, /window\.__steelseedSetMultiplayer && window\.__steelseedSetMultiplayer\(/);
  assert.match(setMp, /window\.__redlineMultiplayer && window\.__redlineMultiplayer\(\$\{JSON\.stringify\(\{ on: enabled \}\)\}\)/);
  assert.match(setMp, /stopLanListener\(\);[\s\S]*await setDonateConfig\(\{ enabled: false \}\);/);
  assert.match(main, /\{ id: 'menu-multiplayer', label: 'Multiplayer…', enabled: mpOn\(\), click: \(\) => enterMp\(\) \}/);
  assert.match(main, /const enterMp = \(\{ focusHost: focus = false \} = \{\}\) => \{\s*if \(gameWin\.isDestroyed\(\)\) return false;[\s\S]{0,120}if \(!mpOn\(\)\) return false;/);
  assert.match(main, /ipcMain\.handle\('host-start', async \(_e, request\) => \{[\s\S]{0,100}if \(!mpOn\(\)\) throw new Error\('multiplayer-off'\);/);
  assert.match(mainFunction('refreshPlayersTile'), /^function refreshPlayersTile\(\) \{\n  if \(!mpOn\(\)\) return;/);
  assert.match(main, /window\.__steelseedSetMultiplayer && window\.__steelseedSetMultiplayer\(\$\{mpOn\(\) \? 'true' : 'false'\}\)/);
});

test('Host a game opens multiplayer with the host card focused, also when queued', () => {
  assert.match(main, /ipcMain\.on\('start-hosting', \(\) => enterMp\(\{ focusHost: true \}\)\);/);
  assert.match(main, /selectSession\('mp'\);\s*swapToGame\(\);\s*if \(focus === true\) focusHost\(\);/);
  assert.match(main, /queuedFocus = focus === true;/);
  assert.match(main, /selectSession\(tab\);\s*if \(tab === 'mp' && focus\) focusHost\(\);/);
  assert.match(main, /window\.__steelseedFocusHost && window\.__steelseedFocusHost\(\)/);
});

test('every landing gets the quit hook, visibility wiring and the state replay', () => {
  const open = mainFunction('openLanding');
  assert.match(open, /createLandingWindow\(lastPort, lastMusicUrl, \{ intro, visible, bounds \}\)/);
  assert.match(open, /landingWin = win;/);
  assert.match(open, /win\.on\('closed', \(\) => \{[\s\S]*if \(!gameWin \|\| gameWin\.isDestroyed\(\) \|\| !gameWin\.isVisible\(\)\) app\.quit\(\);/);
  assert.match(open, /win\.on\('show', \(\) => \{\s*landingVisible\(win, true\);/);
  assert.match(open, /win\.on\('hide', \(\) => landingVisible\(win, false\)\);/);
  assert.match(open, /win\.webContents\.on\('did-finish-load', \(\) => replayLandingState\(win\)\);/);
  assert.match(mainFunction('landingVisible'), /window\.__redlineLandingVisible && window\.__redlineLandingVisible\(/);
  const replay = mainFunction('replayLandingState');
  for (const hook of ['setMusicIcon', '__redlineDonateStatus', '__redlineUpdateRequired', '__redlineMultiplayer', 'setLoader', 'setLoaderProgress', 'setPlayers', '__redlineLandingVisible'])
    assert.ok(replay.includes(`window.${hook} && window.${hook}(`), `the replay does not push ${hook}`);
  assert.match(mainFunction('createLandingWindow'), /query: landingQuery\(\{ port, music: musicUrl, intro, visible \}\)/);
  // Boot plays the intro (never headless); menu and tray landings never do.
  assert.match(main, /openLanding\(\{ intro: !HEADLESS, visible: !SELFTEST && !HEADLESS \}\);/);
  assert.match(main, /else openLanding\(\{ intro: false, bounds \}\);/);
  assert.match(mainFunction('showLanding'), /openLanding\(\{ intro: false \}\)/);
  // No landing is ever built outside openLanding (it would miss the hooks).
  assert.equal(main.match(/createLandingWindow\(/g).length, 2, 'createLandingWindow: one definition, one caller');
  // Back to the menu: the landing shows before the game hides.
  const back = main.slice(main.indexOf('const backToMain = () => {'), main.indexOf('const applyQuality = q => {'));
  assert.ok(back.lastIndexOf('landingWin.show()') < back.lastIndexOf('gameWin.hide()'), 'backToMain must show the landing before hiding the game');
  assert.ok(back.indexOf('openLanding(') < back.lastIndexOf('gameWin.hide()'), 'backToMain must build the landing before hiding the game');
  // The loader, progress and players tile are remembered before each push.
  assert.match(main, /const landingState = \{ loader: 'laden', pct: 0, stage: '', players: null \};/);
  assert.match(main, /const notifyLoader = state => \{[\s\S]{0,160}landingState\.loader = state;/);
  assert.match(main, /const notifyProgress = \(pct, stage\) => \{\s*landingState\.pct = Number\(pct\) \|\| 0;\s*landingState\.stage = String\(stage \?\? ''\);/);
  assert.match(mainFunction('refreshPlayersTile'), /landingState\.players = text;/);
  assert.match(main, /ipcMain\.on\('get-shell-state-sync', e => \{\s*e\.returnValue = \{\s*multiplayer: mpOn\(\),\s*loader: \{ state: landingState\.loader, pct: landingState\.pct, stage: landingState\.stage \},\s*players: landingState\.players,\s*donate: donateStatus\(\),\s*build: shellBuild\(\),\s*version: app\.getVersion\(\),\s*port: lastPort,/);
});

test('the preload exposes the shell bridge without credentials', () => {
  assert.match(preload, /getShellStateSync: \(\) => ipcRenderer\.sendSync\('get-shell-state-sync'\)/);
  assert.match(preload, /getMultiplayerSync: \(\) => ipcRenderer\.sendSync\('get-multiplayer-sync'\)/);
  assert.match(preload, /setMultiplayer: on => ipcRenderer\.invoke\('set-multiplayer', on === true\)/);
  assert.match(preload, /hostGame: \(\) => ipcRenderer\.send\('start-hosting'\)/);
  assert.match(preload, /legalText: name => ipcRenderer\.invoke\('legal-text', String\(name \?\? ''\)\)/);
  assert.match(preload, /openWebsite: page => ipcRenderer\.send\('open-website', typeof page === 'string' \? page : ''\)/);
  assert.match(main, /ipcMain\.on\('get-multiplayer-sync', e => \{\s*e\.returnValue = mpOn\(\);/);
  assert.match(main, /ipcMain\.handle\('set-multiplayer', \(_e, on\) => setMultiplayer\(on === true\)\);/);
  assert.doesNotMatch(preload, /accessToken|Bearer/);
});

test('by default the page picks the preset; a chosen one is pinned in the URL', () => {
  assert.equal(DEFAULT_QUALITY, 'default');
  assert.equal(qualityParam('default'), '', 'the page decides: Classic on a strong GPU, otherwise Dynamic');
  assert.equal(qualityParam(undefined), '');
  assert.equal(qualityParam('classic'), 'quality=classic');
  assert.equal(qualityParam('ultra-max'), 'quality=ultra-max');
  assert.doesNotMatch(main, /quality=\$\{encodeURIComponent/, 'every game URL goes through qualityParam');
});
