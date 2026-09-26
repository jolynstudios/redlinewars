// The desktop landing (shell/landing.html + landing.js): the contract main.mjs and the selftest
// rely on, and the rules the console lives by — local assets only, no blur over the game, the
// intro skippable and calm under reduced motion.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const shell = path.join(import.meta.dirname, 'shell');
const html = fs.readFileSync(path.join(shell, 'landing.html'), 'utf8');
const js = fs.readFileSync(path.join(shell, 'landing.js'), 'utf8');

test('the ids and globals the shell and the selftest use are all there', () => {
  for (const id of ['landing-music', 'loader', 'loader-bar', 'loader-pct', 'loader-text', 'players-value', 'start-skirmish',
    'start-multiplayer', 'host-game', 'donate-toggle', 'donate-max', 'donate-status', 'donate-drain', 'website-link', 'sound-btn',
    'port-label', 'update-modal', 'update-builds', 'update-download', 'update-close', 'mp-switch', 'credits-sheet', 'intro'])
    assert.match(html, new RegExp(`id="${id}"`), `#${id}`);
  for (const fn of ['setLoader', 'setLoaderProgress', 'setPlayers', 'setMusicIcon', '__redlineDonateStatus',
    '__redlineUpdateRequired', '__redlineMultiplayer', '__redlineLandingVisible', '__redlineOpenCredits'])
    assert.match(js, new RegExp(`window\\.${fn} = `), `window.${fn}`);
  // The update dialog shows only through [hidden] (a display rule on the tag once covered every launch).
  assert.match(html, /<div id="update-modal" class="dialog" hidden/);
});

test('everything is local: no remote URL in markup or styles', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"|url\(['"]?([^'")]+)/g)].map(m => m[1] ?? m[2]);
  for (const ref of refs) assert.doesNotMatch(ref, /^(https?:)?\/\//, `${ref} would leave the machine`);
  for (const file of ['archivo-latin-standard-normal.woff2', 'martian-mono-latin-standard-normal.woff2', 'archivo-OFL.txt', 'martian-mono-OFL.txt'])
    assert.ok(fs.existsSync(path.join(shell, 'fonts', file)), `fonts/${file}`);
  assert.match(html, /<script src="landing\.js"><\/script>/);
  assert.doesNotMatch(html, /type="module"/, 'file:// cannot load ES modules');
});

test('the console is calm: no blur, no autofocus, reduced motion honoured, compositor-only keyframes', () => {
  assert.doesNotMatch(html, /backdrop-filter/);
  assert.doesNotMatch(html, /\bautofocus\b/, 'Enter during the intro must never start a match');
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /html\[data-motion="reduced"\]/);
  const frames = [...html.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\}\s*(?=\n|@|\.|html|\/)/g)];
  assert.equal(frames.length, (html.match(/@keyframes/g) ?? []).length, 'every @keyframes is checked');
  for (const [, name, body] of frames) {
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]);
    for (const prop of props) assert.ok(['opacity', 'transform'].includes(prop), `@keyframes ${name} animates ${prop}`);
  }
});

test('the intro runs once per cold start and can always be skipped', () => {
  assert.match(html, /q\.get\('intro'\) === '1' && !seen/);
  assert.match(js, /window\.addEventListener\('keydown', skip, \{ capture: true, once: true \}\)/);
  assert.match(js, /if \(skippedByKey\) focusStart\(\)/);
});
