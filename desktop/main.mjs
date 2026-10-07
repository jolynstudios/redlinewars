// Optional Electron wrapper. It serves the exact shared AppBundle on loopback;
// all simulation, rendering and the starter UI remain in engine/ and web/.
import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { waitForLocalServer } from './server-ready.mjs';

app.setName('Redline Wars Source Starter');
// Keep the existing Linux hardware path until Chromium enables it by default.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('enable-features', 'Vulkan');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
}

let server = null;
let window = null;
let quitting = false;
const repo = path.resolve(import.meta.dirname, '..');
const bundle = app.isPackaged ? path.join(process.resourcesPath, 'AppBundle') : path.join(repo, 'engine/bin-browser/AppBundle');
const serverFile = app.isPackaged ? path.join(process.resourcesPath, 'server.mjs') : path.join(repo, 'engine/OpenRA.Browser/tests/server.mjs');
// Keep this starter's profile separate from the production game.
app.setPath('userData', path.join(app.getPath('appData'), 'Redline Wars Source Starter'));

function stopServer() {
  if (server && server.exitCode === null) server.kill();
  server = null;
}

async function launch() {
  if (!existsSync(path.join(bundle, 'steelseed/index.html')))
    throw new Error('The shared AppBundle is missing. Build the browser client before starting the desktop wrapper.');
  server = spawn(process.execPath, [serverFile, '--root', bundle, '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  server.stderr.on('data', chunk => process.stderr.write(chunk));
  const port = await waitForLocalServer(server);
  const origin = `http://127.0.0.1:${port}`;
  server.on('exit', () => { if (!quitting) app.quit(); });
  window = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 600,
    title: 'Redline Wars Source Starter', backgroundColor: '#111111',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.origin === origin) return { action: 'allow', overrideBrowserWindowOptions: {
        width: 900, height: 700, autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      } };
      if (target.protocol === 'https:' && ['github.com', 'www.gnu.org', 'www.openra.net'].includes(target.hostname))
        void shell.openExternal(target.href);
    } catch { /* malformed target */ }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin !== origin) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await window.loadURL(`${origin}/steelseed/index.html`);
}

app.whenReady().then(launch).catch(error => {
  dialog.showErrorBox('Unable to start the shared game', error.message);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; stopServer(); });
process.on('exit', stopServer);
