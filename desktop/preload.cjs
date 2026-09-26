const { contextBridge, ipcRenderer } = require('electron');

// Music preference: applied to the game origin's localStorage BEFORE the
// page scripts run, so the Music module boots in the right state.
try {
  const state = ipcRenderer.sendSync('get-music-sync');
  localStorage.setItem('steelthorn-music', state);
} catch {
  // The game origin may not exist yet on first paint; the shell retries.
}

contextBridge.exposeInMainWorld('redline', {
  start: () => ipcRenderer.send('start-game'),
  startMultiplayer: () => ipcRenderer.send('start-multiplayer'),
  showCopyright: () => ipcRenderer.send('show-copyright'),
  showLan: () => ipcRenderer.send('show-lan'),
  // The home page, or an allowlisted page name ('credits'); the shell maps
  // the name to its URL — the page never supplies one.
  openWebsite: page => ipcRenderer.send('open-website', typeof page === 'string' ? page : ''),
  // §3.2: loader, open rooms, donation, build and switch state in one read.
  getShellStateSync: () => ipcRenderer.sendSync('get-shell-state-sync'),
  // §3.3: the Multiplayer switch. setMultiplayer resolves to the effective
  // state (--selftest/--headless keep it on); hostGame opens multiplayer with
  // the host card focused.
  getMultiplayerSync: () => ipcRenderer.sendSync('get-multiplayer-sync'),
  setMultiplayer: on => ipcRenderer.invoke('set-multiplayer', on === true),
  hostGame: () => ipcRenderer.send('start-hosting'),
  // A shipped licence text by name (license, gpl, authors, notices,
  // ofl-archivo, ofl-martian-mono); null when unavailable.
  legalText: name => ipcRenderer.invoke('legal-text', String(name ?? '')),
  // Public origin only; the bearer remains encrypted in the main process.
  accountOrigin: process.env.REDLINE_ACCOUNT_ORIGIN || 'https://www.redlinewars.online',
  // Account broker: bearer/device credentials remain in the main process.
  accountStatus: () => ipcRenderer.invoke('account-status'),
  accountDeviceLogin: () => ipcRenderer.invoke('account-device-login'),
  // The code the player types on the approval page; subscribe before accountDeviceLogin.
  onAccountDeviceChallenge: callback => {
    const listener = (_event, challenge) => callback({ userCode: String(challenge?.userCode ?? ''), expiresAt: Number(challenge?.expiresAt ?? 0) });
    ipcRenderer.on('account-device-challenge', listener);
    return () => ipcRenderer.removeListener('account-device-challenge', listener);
  },
  accountAvatarUpload: request => ipcRenderer.invoke('account-avatar-upload', request),
  accountLogout: () => ipcRenderer.invoke('account-logout'),
  accountRequest: request => ipcRenderer.invoke('account-request', request),
  toggleMusic: () => ipcRenderer.send('toggle-music'),
  getMusicSync: () => ipcRenderer.sendSync('get-music-sync'),
  setMpDir: value => ipcRenderer.send('set-mp-dir', value),
  getMpDirSync: () => ipcRenderer.sendSync('get-mp-dir-sync'),
  // §5.9: the host surface. hostStart resolves {dir,key} once the local
  // node's /v2/health answers; hostStatus resolves the health body or null;
  // lanQuery asks the discovery listener to query now (`query <ip>` when a
  // value is given). openDownload opens a relay-sanctioned download page.
  hostStart: request => ipcRenderer.invoke('host-start', request),
  hostStop: () => ipcRenderer.invoke('host-stop'),
  hostStatus: () => ipcRenderer.invoke('host-status'),
  getDonateHostingSync: () => ipcRenderer.sendSync('get-donate-hosting-sync'),
  getDonateConfigSync: () => ipcRenderer.sendSync('get-donate-config-sync'),
  setDonateHosting: patch => ipcRenderer.invoke('donate-set-config', patch || {}),
  donateStatus: () => ipcRenderer.invoke('donate-status'),
  stopDonateHosting: () => ipcRenderer.invoke('donate-stop'),
  drainDonateHosting: () => ipcRenderer.invoke('donate-drain'),
  lanQuery: value => ipcRenderer.invoke('lan-query', value),
  openDownload: url => ipcRenderer.invoke('open-download', url),
});

// The in-game menu's exit button calls window.backToMain directly
// (web/src/ui/index.ts): the shell shows the landing again WITHOUT
// reloading the engine page.
contextBridge.exposeInMainWorld('backToMain', () => ipcRenderer.send('back-to-main'));
