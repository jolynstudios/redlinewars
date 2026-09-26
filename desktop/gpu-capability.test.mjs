import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');

test('Electron keeps acceleration enabled and uses Linux-only WebGPU recovery flags', () => {
  assert.doesNotMatch(main, /disable-gpu/);
  assert.match(main, /process\.platform === 'linux'/);
  assert.match(main, /enable-unsafe-webgpu/);
  assert.match(main, /ignore-gpu-blocklist/);
  assert.match(main, /enable-gpu-rasterization/);
});

test('desktop selftest probes real WebGPU or WebGL2 and records Electron diagnostics', () => {
  assert.match(main, /navigator\.gpu/);
  assert.match(main, /requestAdapter/);
  assert.match(main, /requestDevice/);
  assert.match(main, /getContext\('webgl2'/);
  assert.match(main, /app\.getGPUFeatureStatus\(\)/);
  assert.match(main, /app\.getGPUInfo\('complete'\)/);
  assert.match(main, /paintWhenInitiallyHidden: true/);
  assert.match(main, /Electron renderer has neither WebGPU nor WebGL2/);
});
