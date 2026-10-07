import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createExportPolicy } from './export-policy.mjs'
import { REQUIRED, validatePublicSource } from './public-source-gate.mjs'
import { PUBLIC_MUSIC_FILES, PUBLIC_MUSIC_SHA256, writePublicMusicFallbacks } from './public-music-fallback.mjs'
import { assertPublicAudioStandins } from './public-audio-standins.mjs'
import { createHash } from 'node:crypto'

function fixture(fn) {
 const root = mkdtempSync(join(tmpdir(), 'redline-public-edition-'))
 const write = (path, text = '') => {
  const file = join(root, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text)
 }
 try { return fn({ root, write }) } finally { rmSync(root, { recursive: true, force: true }) }
}
function inputs(write) {
 write('RELEASE-SOURCE.json', JSON.stringify({ schema: 2, edition: 'public-source', version: '0.1.0', sourceCommit: 'a'.repeat(40) }))
 for (const path of REQUIRED) write(path)
 for (const area of ['engine', 'desktop', 'web']) {
  write(area + '/package.json', JSON.stringify({ scripts: { build: 'tsc --noEmit && vite build', compose: 'node tools/compose.mjs' } }))
  write(area + '/package-lock.json', '{}')
 }
}
test('public source inputs validate without private Git history or proprietary components', () => fixture(({ root, write }) => {
 inputs(write); assert.equal(validatePublicSource(root), 'a'.repeat(40))
}))
for (const kind of ['ordinary', 'credential', 'symlink']) test(`archive export audits committed ${kind} content before success`, () => fixture(({ root, write }) => {
 inputs(write)
 for (const file of ['export-release.mjs', 'source-audit.mjs', 'public-source-gate.mjs', 'export-policy.mjs'])
  write('tools/' + file, readFileSync(new URL('./' + file, import.meta.url)))
 const secret = 'ghp_' + 'a'.repeat(36)
 if (kind === 'credential') write('tools/unexpected.txt', secret)
 if (kind === 'symlink') symlinkSync('../LICENSE', join(root, 'tools/link.txt'))
 const git = args => {
  const result = spawnSync('git', ['-c', 'user.name=Source test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
 }
 git(['init', '-q']); git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture'])
 const out = join(root, 'export')
 const result = spawnSync(process.execPath, [join(root, 'tools/export-release.mjs'), '--commit', 'HEAD', '--out', out], { encoding: 'utf8' })
 if (kind === 'ordinary') {
  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(join(out, 'web/src/render/renderer.ts')))
 } else {
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(out), false)
  assert.ok(!result.stderr.includes(secret))
 }
}))
test('excluded UI, media dependency and missing engine input each fail the gate', () => fixture(({ root, write }) => {
 inputs(write); write('web/src/hud/index.ts', 'private UI')
 assert.throws(() => validatePublicSource(root), /excluded input present/)
 rmSync(join(root, 'web/src/hud'), { recursive: true })
 write('engine/package-lock.json', JSON.stringify({ packages: { 'node_modules/freehop': {} } }))
 assert.throws(() => validatePublicSource(root), /excluded media dependency/)
 write('engine/package-lock.json', '{}')
 rmSync(join(root, 'engine/steelseed-host/OpenRA.Browser/OpenRA.Browser.csproj'))
 assert.throws(() => validatePublicSource(root), /required input missing/)
}))
test('a legacy production export record cannot masquerade as a public edition', () => fixture(({ root, write }) => {
 inputs(write); write('RELEASE-SOURCE.json', JSON.stringify({ schema: 1, sourceCommit: 'a'.repeat(40) }))
 assert.throws(() => validatePublicSource(root), /unsupported edition/)
}))
test('the public edition cannot drop its WebGPU renderer or shader sources', () => fixture(({ root, write }) => {
 inputs(write)
 for (const path of ['web/src/render/renderer.ts', 'web/src/render/shaders.ts', 'web/src/render/cutout-shaders.ts']) {
  rmSync(join(root, path))
  assert.throws(() => validatePublicSource(root), { message: 'public source: required input missing: ' + path })
  write(path)
 }
}))
test('source archive policy rejects unknown paths, excluded features and generated binaries', () => {
 const { decide } = createExportPolicy()
 for (const path of ['web/src/hud/index.ts', 'web/src/companion/index.ts', 'web/src/core/freehop-call.ts',
  'engine/steelseed-host/tools/freehop-seat-signal.mjs', 'web/node_modules/foo/index.js',
  'engine/bin-browser/AppBundle/_framework/runtime.wasm', 'art/music/private.m4a', 'desktop/shell/landing.html',
  'web/../brand/private.svg', '/web/src/main.ts', 'web//src/main.ts', 'web\\src\\main.ts'])
  assert.equal(decide(path).publish, false, path)
 assert.equal(decide('unknown/private.txt'), null)
 for (const path of ['.github/workflows/deploy.yml', '.github/workflows/other.yml', '.github/actions/build/action.yml'])
  assert.equal(decide(path), null, path)
 for (const path of ['web/src/ui/index.ts', 'web/src/render/index.ts', 'engine/steelseed-host/tools/roomhost.mjs',
  'LICENSE', 'NOTICE.md', 'tools/build.mjs', 'release/game-version.json', '.github/workflows/public-source.yml'])
  assert.equal(decide(path).publish, true, path)
})
const silentMusic = () => Buffer.from(readFileSync(new URL('./fallback-art.mjs', import.meta.url), 'utf8').match(/const SILENT_M4A = Buffer.from\('([^']+)', 'base64'\)/)[1], 'base64')
function samples(write) {
 const bytes = silentMusic()
 assert.equal(createHash('sha256').update(bytes).digest('hex'), PUBLIC_MUSIC_SHA256)
 writePublicMusicFallbacks(write, bytes)
 write('web/.forge/fallback-art.json', JSON.stringify({ schema: 1, tool: 'tools/fallback-art.mjs',
  files: PUBLIC_MUSIC_FILES.map(path => ({ path, sha256: PUBLIC_MUSIC_SHA256 })) }))
}
test('all seven fallback songs are exact generated silence', () => fixture(({ root, write }) => {
 samples(write); assert.equal(assertPublicAudioStandins(root), 7)
}))
test('modified placeholder music fails even if its hash record is also changed', () => fixture(({ root, write }) => {
 samples(write); write(PUBLIC_MUSIC_FILES[0], 'tampered')
 assert.throws(() => assertPublicAudioStandins(root), /bytes differ/)
 const marker = JSON.parse(readFileSync(join(root, 'web/.forge/fallback-art.json'), 'utf8'))
 marker.files[0].sha256 = createHash('sha256').update('tampered').digest('hex')
 write('web/.forge/fallback-art.json', JSON.stringify(marker))
 assert.throws(() => assertPublicAudioStandins(root), /exact generated silence/)
}))
test('unknown song files do not inherit the placeholder licence record', () => fixture(({ root, write }) => {
 samples(write); write('art/music/unknown.m4a', silentMusic())
 assert.throws(() => assertPublicAudioStandins(root), /unknown files/)
}))
test('gate CLI validates through filesystem aliases and fails on a leaked HUD', () => fixture(({ root, write }) => {
 inputs(write); write('tools/public-source-gate.mjs', readFileSync(new URL('./public-source-gate.mjs', import.meta.url)))
 const run = () => spawnSync(process.execPath, [join(root, 'tools/public-source-gate.mjs')], { encoding: 'utf8' })
 assert.equal(run().status, 0)
 write('web/src/hud/index.ts', 'private UI')
 assert.notEqual(run().status, 0)
}))
test('release helper refuses production deployment flags', () => {
 const run = spawnSync(process.execPath, [new URL('./release.mjs', import.meta.url).pathname, '--deploy'], { encoding: 'utf8' })
 assert.equal(run.status, 2)
 assert.match(run.stderr, /local checks only/)
})
