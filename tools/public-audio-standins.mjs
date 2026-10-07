// Evidence only for the public sample's generated silence, never owner music.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLIC_MUSIC_FILES, PUBLIC_MUSIC_SHA256 } from './public-music-fallback.mjs'
export function assertPublicAudioStandins(root) {
 const canonical = realpathSync(root), metadata = JSON.parse(readFileSync(join(root, 'web/.forge/fallback-art.json'), 'utf8'))
 assert.equal(metadata.schema, 1); assert.equal(metadata.tool, 'tools/fallback-art.mjs')
 assert.ok(Array.isArray(metadata.files))
 const rows = metadata.files.filter(row => typeof row.path === 'string' && row.path.startsWith('art/music/'))
 assert.deepEqual(rows.map(row => row.path).sort(), [...PUBLIC_MUSIC_FILES].sort(), 'public soundtrack must declare exactly seven known sample paths')
 assert.deepEqual(readdirSync(join(root, 'art/music')).sort(), PUBLIC_MUSIC_FILES.map(path => path.split('/').at(-1)).sort(), 'public soundtrack contains unknown files or owner metadata')
 for (const row of rows) {
  const file = join(root, row.path)
  assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'public soundtrack input must be a real file')
  assert.equal(realpathSync(file), join(canonical, row.path), 'public soundtrack path escapes through a symlink')
  assert.equal(row.sha256, PUBLIC_MUSIC_SHA256, 'public soundtrack marker must identify the exact generated silence')
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), PUBLIC_MUSIC_SHA256, 'public soundtrack bytes differ from the generated silence')
 }
 return rows.length
}
