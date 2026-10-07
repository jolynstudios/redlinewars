import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const tools = 'engine/steelseed-host/tools'
const build = { schema: 1, simBuild: 'abcdef012345', modHash: 'a'.repeat(64), app: '0.0.1' }
const manifestModule = new URL('../engine/steelseed-host/tools/release-manifest.mjs', import.meta.url).href

// Execute the real packagers and manifest writer against tiny assembled inputs.
// Only native assembly and Git identity are replaced; no game build, download,
// publication, Git mutation or GPU/device access is involved.
function fixture(t, version) {
 const root = mkdtempSync(join(tmpdir(), 'redline-node-version-'))
 t.after(() => rmSync(root, { recursive: true, force: true }))
 const write = (path, value) => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
 }
 for (const path of [`${tools}/pack-node.mjs`, `${tools}/pack-npm.mjs`, 'release/game-version.mjs']) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  copyFileSync(new URL('../' + path, import.meta.url), join(root, path))
 }
 write('release/game-version.json', { schema: 1, stage: 'alpha', version })
 write('engine/package.json', { version, dependencies: { ws: '^8.21.3' }, engines: { node: '>=22' } })
 write(`${tools}/node-manifest.json`, { modules: ['ws'] })
 write(`${tools}/rooms.example.json`, { schema: 1, rooms: [] })
 for (const name of ['steelthorn-node.service', 'steelthorn-spine.service']) write(`${tools}/systemd/${name}`, '[Service]\n')
 for (const path of ['engine/COPYING', 'engine/AUTHORS', 'THIRD_PARTY_NOTICES.md',
  'engine/licenses/GPL-2.0.txt', 'engine/licenses/LGPL-2.1.txt', 'engine/licenses/LGPL-3.0.txt']) write(path, 'Fixture notice\n')
 write(`${tools}/assemble-node.mjs`, `
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { dirname, join } from 'node:path';
  export const resolveRid = rid => rid;
  export async function assembleNode({ rid, out }) {
   const build = ${JSON.stringify(build)};
   for (const [path, value] of [
    ['steelseed-host/generated/build.json', build],
    ['steelseed-host/generated/mods/ra/map-catalog.json', []],
    ['bin-standalone/' + rid + '/build.json', build],
   ]) { const file = join(out, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); }
  }
 `)
 write(`${tools}/release-manifest.mjs`, `
  import { releaseManifest as create, writeManifest, writeSidecar } from ${JSON.stringify(manifestModule)};
  export { writeManifest, writeSidecar };
  export function releaseManifest(options) {
   return create({ ...options, sourceOptions: { root: ${JSON.stringify(root)}, readGit: args => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ${JSON.stringify(root)};
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'b'.repeat(40);
    if (args[0] === 'describe') return ${JSON.stringify('v' + version)};
    if (args[0] === 'status') return '';
    throw new Error('Unexpected Git identity read');
   } } });
  }
 `)
 const run = (name, args = []) => {
  const result = spawnSync(process.execPath, [join(root, tools, name), ...args], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr + result.stdout)
 }
 return { root, run, json: path => JSON.parse(readFileSync(join(root, path), 'utf8')) }
}

for (const version of ['0.2.0', '0.7.2']) {
 test(`node ZIP and sidecar use canonical ${version}, preserving simulation identity`, t => {
  const f = fixture(t, version)
  f.run('pack-node.mjs', ['linux-x64'])
  const manifest = f.json('dist/redline-node-linux-x64.zip.release.json')
  assert.deepEqual(manifest.build, { simBuild: build.simBuild, modHash: build.modHash, app: version })
  assert.equal(manifest.product, 'Redline Wars public source edition')
  const embedded = spawnSync('unzip', ['-p', join(f.root, 'dist/redline-node-linux-x64.zip'), 'redline-node-linux-x64/RELEASE-MANIFEST.json'], { encoding: 'utf8' })
  assert.equal(embedded.status, 0, embedded.stderr)
  assert.deepEqual(JSON.parse(embedded.stdout).build, manifest.build)
 })
 test(`npm node package, install example and manifest use canonical ${version}`, t => {
  const f = fixture(t, version)
  f.run('pack-npm.mjs')
  const pkg = f.json('dist/steelthorn-node/package.json')
  const manifest = f.json('dist/steelthorn-node/RELEASE-MANIFEST.json')
  assert.equal(pkg.version, version)
  assert.equal(manifest.artifact, `steelthorn-node-${version}.tgz`)
  assert.deepEqual(manifest.build, { simBuild: build.simBuild, modHash: build.modHash, app: version })
  assert.ok(readFileSync(join(f.root, 'dist/steelthorn-node/README-NODE.md'), 'utf8').includes(`npm install -g ./steelthorn-node-${version}.tgz`))
 })
}
