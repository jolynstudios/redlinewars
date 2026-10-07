import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { trackedAudioInputs } from './tracked-audio-inputs.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(t) {
 const repoRoot = mkdtempSync(join(tmpdir(), 'audio-inputs-'))
 t.after(() => rmSync(repoRoot, { recursive: true, force: true }))
 const music = { schema: 1, tracks: [{ id: 'track', title: 'Owner track', file: 'track.m4a', sha256: hash('music'), bytes: 5 }] }
 const riki = { schema: 1, provider: 'ElevenLabs', assets: [{ slug: 'ready', file: 'ready.m4a', sha256: hash('voice'), bytes: 5 }] }
 const put = (path, value) => { mkdirSync(join(repoRoot, path, '..'), { recursive: true }); writeFileSync(join(repoRoot, path), typeof value === 'object' ? JSON.stringify(value) : value) }
 put('art/music/manifest.json', music); put('art/music/track.m4a', 'music')
 put('art/voices/riki/provenance.json', riki); put('art/voices/riki/manifest.json', { schema: 1, bank: 'tanya', lines: { ready: 'ready.m4a' } }); put('art/voices/riki/ready.m4a', 'voice')
 const args = { repoRoot, gitFiles: ['art/music/manifest.json', 'art/music/track.m4a', 'art/voices/riki/provenance.json', 'art/voices/riki/manifest.json', 'art/voices/riki/ready.m4a'], musicManifestSha256: hash(readFileSync(join(repoRoot, 'art/music/manifest.json'))) }
 return { args, put, music, riki }
}
test('declared tracked outputs retain exact source labels and recorded hashes', t => {
 const f = fixture(t), entries = trackedAudioInputs(f.args)
 assert.deepEqual(entries.map(x => x.label), ['art/music/track.m4a', 'art/voices/riki/ready.m4a'])
 assert.equal(entries[0].sha256, hash('music')); assert.equal(entries[1].sha256, hash('voice'))
})
for (const bank of ['art/music/track.m4a', 'art/voices/riki/ready.m4a']) test(`changed bytes cannot inherit provenance: ${bank}`, t => {
 const f = fixture(t); f.put(bank, 'other'); assert.throws(() => trackedAudioInputs(f.args), /pinned hash/)
})
test('an unknown audio track cannot inherit a bank rule', t => {
 const f = fixture(t); f.put('art/music/new.m4a', 'new'); f.args.gitFiles.push('art/music/new.m4a')
 assert.throws(() => trackedAudioInputs(f.args), /undeclared audio/)
})
test('editing a manifest and adding valid outputs cannot inherit owner review', t => {
 const f = fixture(t); f.music.tracks.push({ id: 'new', file: 'new.m4a', sha256: hash('new'), bytes: 3 }); f.put('art/music/new.m4a', 'new'); f.put('art/music/manifest.json', f.music); f.args.gitFiles.push('art/music/new.m4a')
 assert.throws(() => trackedAudioInputs(f.args), /reviewed record/)
})
test('untracked inputs fail closed', t => {
 const f = fixture(t); f.args.gitFiles = f.args.gitFiles.filter(x => x !== 'art/voices/riki/ready.m4a')
 assert.throws(() => trackedAudioInputs(f.args), /Git-tracked/)
})
test('a source symlink cannot smuggle an output', t => {
 const f = fixture(t), path = join(f.args.repoRoot, 'art/music/track.m4a'); rmSync(path); symlinkSync(join(f.args.repoRoot, 'art/voices/riki/ready.m4a'), path)
 assert.throws(() => trackedAudioInputs(f.args), /regular file/)
})
test('Riki provider, bank mapping and byte counts stay pinned', t => {
 const f = fixture(t); f.riki.provider = 'Other'; f.put('art/voices/riki/provenance.json', f.riki)
 assert.throws(() => trackedAudioInputs(f.args), /provider/)
 f.riki.provider = 'ElevenLabs'; f.riki.assets[0].bytes = 7; f.put('art/voices/riki/provenance.json', f.riki)
 assert.throws(() => trackedAudioInputs(f.args), /pinned size/)
 f.riki.assets[0].bytes = 5; f.put('art/voices/riki/provenance.json', f.riki); f.put('art/voices/riki/manifest.json', { schema: 1, bank: 'tanya', lines: { ready: 'wrong.m4a' } })
 assert.throws(() => trackedAudioInputs(f.args), /disagree/)
})
test('unsafe metadata names fail before filesystem traversal', t => {
 const f = fixture(t); f.riki.assets[0].file = '../outside.m4a'; f.put('art/voices/riki/provenance.json', f.riki)
 assert.throws(() => trackedAudioInputs(f.args), /unsafe output name/)
})
import { existsSync } from 'node:fs'
import { assertPublicAudioStandins } from '../../tools/public-audio-standins.mjs'
const publicAudioRoot = new URL('../../', import.meta.url).pathname
test('public soundtrack has exact generated silence; no owner acceptance is claimed', {
 skip: !existsSync(join(publicAudioRoot, 'web/.forge/fallback-art.json')) && 'run tools/fallback-art.mjs to initialize the public sample',
}, () => { assert.equal(assertPublicAudioStandins(publicAudioRoot), 7) })
