import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeDonateConfig } from './donate-hosting.mjs';

const DEFAULT_SETTINGS = {
  // The relay the node registers with when hosting "Anyone online" (T3.4).
  spineUrl: 'wss://spine.redlinewars.online/node',
  // Shared AppBundle default for both Skirmish and Multiplayer. Existing explicit
  // player choices in settings.json still win.
  quality: 'default',
  // Community hosting is an explicit opt-in and never starts by default.
  donate: { enabled: false, maxMatches: 1, consentSeen: false },
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

export function loadSettings() {
  let parsed = {};
  try {
    parsed = JSON.parse(readFileSync(settingsFile(), 'utf8'));
  } catch {
    parsed = {};
  }
  // One-time migrations from earlier schemas.
  if (parsed.sound === false) parsed.music = parsed.music ?? false;
  // The pre-relay dev default pointed at a local spine that no longer runs.
  if (parsed.spineUrl === 'wss://127.0.0.1:14601/node') parsed.spineUrl = DEFAULT_SETTINGS.spineUrl;
  // T3.2/T3.4: hosting is on demand and registration needs no secret — the
  // persisted hostMode and spineToken are obsolete by design.
  delete parsed.hosting;
  delete parsed.hostMode;
  delete parsed.spineToken;
  delete parsed.sound;
  delete parsed.fullscreen;
  const donate = normalizeDonateConfig(parsed.donate ?? { enabled: parsed.donateHosting === true });
  delete parsed.donateHosting;
  // §3.3: the multiplayer switch is a plain boolean, written only once the
  // player flips it; anything else falls back to the default (on).
  if (typeof parsed.multiplayer !== 'boolean') delete parsed.multiplayer;
  return { ...DEFAULT_SETTINGS, ...parsed, donate };
}

export function saveSettings(next) {
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}

export { settingsFile };
