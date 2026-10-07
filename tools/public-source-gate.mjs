// Public-edition inventory check, not a legal opinion about another product.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export const EXCLUDED = [
 'web/src/hud', 'web/src/companion', 'web/src/core/tactical',
 'web/src/core/freehop-call.ts', 'web/src/core/freehop-call.css',
 'web/src/core/freehop-video.ts', 'web/src/freehop.d.ts',
 'web/companion.html', 'web/public-companion.html', 'web/public/phone.html',
 'desktop/shell/landing.html', 'desktop/freehop-main.mjs',
 'engine/steelseed-host/tools/companion-service.mjs',
 'engine/steelseed-host/tools/freehop-ticket-service.mjs',
 'art/voices/riki', 'brand', 'landing', 'deploy',
 'release/consolidation.json', 'release/qualification-selection.json',
]
export function validatePublicSource(root) {
 const record = JSON.parse(readFileSync(resolve(root, 'RELEASE-SOURCE.json'), 'utf8'))
 assert.equal(record.schema, 2, 'public source: unsupported edition record')
 assert.equal(record.edition, 'public-source', 'public source: wrong edition')
 assert.match(record.sourceCommit, /^[a-f0-9]{40}$/, 'public source: upstream provenance is required')
 assert.match(record.version, /^\d+\.\d+\.\d+$/, 'public source: edition version is required')
 for (const path of EXCLUDED)
  assert.ok(!existsSync(resolve(root, path)), 'public source: excluded input present: ' + path)
 for (const path of ['LICENSE', 'NOTICE.md', 'AUTHORS', 'THIRD_PARTY_NOTICES.md',
  'web/src/ui/index.ts', 'web/index.html', 'web/tools/compose.mjs',
  'engine/steelseed-host/OpenRA.Browser/OpenRA.Browser.csproj',
  'release/game-version.mjs', 'release/game-version.json'])
  assert.ok(existsSync(resolve(root, path)), 'public source: required input missing: ' + path)
 for (const area of ['web', 'engine', 'desktop']) {
  for (const name of ['package.json', 'package-lock.json'])
   assert.doesNotMatch(readFileSync(resolve(root, area, name), 'utf8'), /["/]freehop(?:["/]|-)/i,
    'public source: excluded media dependency in ' + area + '/' + name)
 }
 const web = JSON.parse(readFileSync(resolve(root, 'web/package.json'), 'utf8'))
 assert.match(web.scripts.build, /vite build/, 'public source: shared web builder missing')
 assert.equal(web.scripts.compose, 'node tools/compose.mjs', 'public source: shared composer missing')
 assert.doesNotMatch(web.scripts.build, /consolidation-gate|unified-features|prepare-freehop/)
 return record.sourceCommit
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
 validatePublicSource(resolve(import.meta.dirname, '..'))
 console.log('public-source-gate: PASS — public edition inputs and excluded features checked')
}
