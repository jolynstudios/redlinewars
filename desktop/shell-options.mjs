// Pure desktop-shell options shared by main.mjs, package.mjs and their tests:
// the one credits text, the licence files every installer ships, the
// multiplayer switch and the landing's query. No electron import, so
// node:test runs it as is.
import path from 'node:path';

// ─── §1: one copyright and credits wording, everywhere ───

// The GPL source line. One constant: the website, the game and the notices
// carry the same value.
export const SOURCE_URL = 'github.com/jolynstudios/redlinewars';

export const LEGAL_LONG = [
  `© 2026 Jolyn Studios. The Redline Wars software is available under the GNU GPL v3 or later: the engine and our WebAssembly port, the WebGPU client, the desktop app, the multiplayer and server code and the tools. Source: ${SOURCE_URL}. Separately marked models, textures, audio, video and other creative files are under their own licences. The software licence grants no rights to our trademarks.`,
  'Engine: OpenRA © The OpenRA Developers and Contributors, GNU GPL v3 or later. Not affiliated with or endorsed by the OpenRA project.',
  'Maps from the OpenRA project, by their authors. Made with Suno (music), Cartesia (announcer voices), ElevenLabs (character voices, sound effects), Higgsfield (cinematics) and Meshy (Riki); all voices are text-to-speech. Base meshes and textures: MakeHuman, Quaternius, ambientCG (CC0); the soldiers build on the Female S.W.A.T Tactical Soldier model by pathumtharaka1998 on CGTrader (Royalty Free License). Typefaces: Archivo and Martian Mono (SIL OFL 1.1). Third-party licences and credits: see the notices.',
  'Command & Conquer and Red Alert are trademarks of Electronic Arts Inc. EA has not endorsed and does not support this product.',
].join('\n\n');

export const LEGAL_SHORT = '© 2026 Jolyn Studios · Engine: OpenRA (GPLv3) · EA has not endorsed and does not support this product.';

// ─── §3.1: the licence texts. Installers carry them in resources/legal/
// (package.mjs maps LEGAL_SOURCES → legal/LEGAL_DOCS); the credits sheet
// reads them back by name — never by a path the page chose. ───

export const LEGAL_DOCS = Object.freeze({
  license: 'LICENSE.txt',
  gpl: 'COPYING-GPLv3.txt',
  authors: 'AUTHORS-OpenRA.txt',
  notices: 'THIRD_PARTY_NOTICES.md',
  'ofl-archivo': 'fonts/archivo-OFL.txt',
  'ofl-martian-mono': 'fonts/martian-mono-OFL.txt',
  'gpl-2.0': 'GPL-2.0.txt',
  'lgpl-2.1': 'LGPL-2.1.txt',
  'lgpl-3.0': 'LGPL-3.0.txt',
});

// Where each text lives in the repository (relative to its root).
export const LEGAL_SOURCES = Object.freeze({
  license: 'LICENSE',
  gpl: 'engine/COPYING',
  authors: 'engine/AUTHORS',
  notices: 'THIRD_PARTY_NOTICES.md',
  'ofl-archivo': 'web/public/licenses/archivo-OFL.txt',
  'ofl-martian-mono': 'web/public/licenses/martian-mono-OFL.txt',
  'gpl-2.0': 'engine/licenses/GPL-2.0.txt',
  'lgpl-2.1': 'engine/licenses/LGPL-2.1.txt',
  'lgpl-3.0': 'engine/licenses/LGPL-3.0.txt',
});

// The viewer's ceiling: every shipped text is far below it.
export const LEGAL_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** Absolute path of an allowlisted legal text; null for any other name.
 *  Packaged apps read resources/legal/, a repo checkout its source files. */
export function legalDocPath(name, { packaged = false, resourcesPath = '', repoRoot = '' } = {}) {
  if (typeof name !== 'string' || !Object.hasOwn(LEGAL_DOCS, name)) return null;
  return packaged
    ? path.join(resourcesPath, 'legal', ...LEGAL_DOCS[name].split('/'))
    : path.join(repoRoot, ...LEGAL_SOURCES[name].split('/'));
}

// Pages the shell may open besides the home page: the credits, and the public issue tracker
// the alpha notice points to.
export const WEBSITE_PAGES = Object.freeze({
  credits: 'https://www.redlinewars.online/credits',
  issues: 'https://github.com/jolynstudios/redlinewars/issues',
});

/** The allowlisted page URL, or null (the caller opens the home page). */
export function websitePage(page) {
  return typeof page === 'string' && Object.hasOwn(WEBSITE_PAGES, page) ? WEBSITE_PAGES[page] : null;
}

// ─── Graphics: the page picks the default (Classic on a strong GPU, Dynamic elsewhere). ───

/** `default` leaves the preset to the page's hardware check; any other value pins it. */
export const DEFAULT_QUALITY = 'default';

/** The game URL's quality parameter: `&quality=…`, or nothing when the page should decide. */
export function qualityParam(quality) {
  return typeof quality === 'string' && quality !== '' && quality !== DEFAULT_QUALITY
    ? `quality=${encodeURIComponent(quality)}` : '';
}

// ─── §3.3: the landing's Multiplayer switch, on by default. ───

export const DEFAULT_MULTIPLAYER = true;

/** The effective switch. --selftest and --headless always run with it on:
 *  the gates exercise multiplayer, and a headless app exists to host. */
export function multiplayerEnabled(settings, { selftest = false, headless = false } = {}) {
  if (selftest || headless) return true;
  return typeof settings?.multiplayer === 'boolean' ? settings.multiplayer : DEFAULT_MULTIPLAYER;
}

export function withMultiplayer(settings, on) {
  return { ...(settings || {}), multiplayer: on === true };
}

/** loadFile() query for the landing: every value a string. intro plays the
 *  cold-start intro; visible tells the page whether its window is on screen
 *  (the theme plays only then — __redlineLandingVisible keeps it current). */
export function landingQuery({ port, music = '', intro = false, visible = true } = {}) {
  return {
    port: String(port ?? ''),
    music: typeof music === 'string' ? music : '',
    intro: intro ? '1' : '0',
    visible: visible ? '1' : '0',
  };
}
