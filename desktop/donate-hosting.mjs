// Pure donation-hosting policy shared by the Electron shell and its tests.
// The launched node is always the assembled node-cli product; this module
// only centralises the mode/setting contract so the shell cannot accidentally
// create a second hosting implementation.

export const DEFAULT_DONATE_HOSTING = false;
export const DONATE_MAX_MATCHES = 1;
export const DONATE_MAX_MATCHES_LIMIT = 2;
export const S24_DONATE_CONFIRMATION = 'Je computer host dan matches van andere spelers, ook als je zelf niet speelt. Dat kost processorkracht en een klein beetje bandbreedte. Je kunt het altijd weer uitzetten.';

// Version 2: consent recorded after the renderer lost the ability to set it.
// Consent saved before that cannot be told apart from a renderer-forged one,
// so it no longer auto-starts hosting; the S24 dialog asks once more.
export const DONATE_CONSENT_VERSION = 2;

export const DEFAULT_DONATE = Object.freeze({
  enabled: false,
  maxMatches: DONATE_MAX_MATCHES,
  consentSeen: false,
  consentVersion: 0,
});

export function normalizeDonateConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const maxMatches = Number(source.maxMatches);
  const consentVersion = Number(source.consentVersion);
  return {
    enabled: source.enabled === true,
    maxMatches: Number.isInteger(maxMatches)
      ? Math.max(1, Math.min(DONATE_MAX_MATCHES_LIMIT, maxMatches))
      : DONATE_MAX_MATCHES,
    consentSeen: source.consentSeen === true,
    consentVersion: Number.isInteger(consentVersion) && consentVersion > 0 ? consentVersion : 0,
  };
}

/** Consent given through the current S24 dialog. */
export function donateConsentCurrent(config) {
  return config?.consentSeen === true && config.consentVersion >= DONATE_CONSENT_VERSION;
}

/** What a page may ask for: the switch and the match cap. Consent is recorded
 *  only by the main-process S24 dialog, never taken from the renderer. */
export function rendererDonatePatch(patch) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const result = {};
  if (source.enabled !== undefined) result.enabled = source.enabled;
  if (source.maxMatches !== undefined) result.maxMatches = source.maxMatches;
  return result;
}

export function donateConfig(settings) {
  if (settings?.donate && typeof settings.donate === 'object') return normalizeDonateConfig(settings.donate);
  // Migrate the pre-T6.5 boolean without silently treating it as fresh consent.
  return normalizeDonateConfig({ enabled: settings?.donateHosting === true });
}

export function donateHostingEnabled(settings) {
  return donateConfig(settings).enabled;
}

export function withDonateHosting(settings, enabled) {
  return withDonateConfig(settings, { enabled: enabled === true });
}

export function withDonateConfig(settings, patch = {}) {
  const current = donateConfig(settings);
  const next = normalizeDonateConfig({ ...current, ...patch });
  const result = { ...(settings || {}), donate: next };
  delete result.donateHosting;
  return result;
}

export function donateNodeArgs({ script, mux, http, dataDir, bundle, nodeKeyFile, spineUrl, maxMatches = DONATE_MAX_MATCHES }) {
  return [
    script,
    '--mode', 'donate',
    '--ws', String(mux),
    '--http', String(http),
    '--data-dir', dataDir,
    '--max-matches', String(normalizeDonateConfig({ maxMatches }).maxMatches),
    '--bundle', bundle,
    '--node-key-file', nodeKeyFile,
    '--spine', spineUrl,
  ];
}

export function nodeModeCanSwitch(current, wanted, activeRooms = 0) {
	if (current === null || current === wanted) return true;
	return Number(activeRooms) === 0 && ((current === 'own' && wanted === 'donate') || (current === 'donate' && wanted === 'own'));
}

export function keepsNodeForEmptyRooms(mode) {
  return mode === 'donate';
}
