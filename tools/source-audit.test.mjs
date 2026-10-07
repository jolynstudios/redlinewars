import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { auditSourceFiles } from './source-audit.mjs'

function fixture(fn) {
 const root = mkdtempSync(join(tmpdir(), 'redline-source-audit-'))
 const write = (path, text = '') => {
  const file = join(root, path)
  mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text)
 }
 try { return fn({ root, write }) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('source audit rejects excluded artwork, integrations and unapproved workflows', () => fixture(({ root, write }) => {
 const paths = ['art/voices/riki/speech.wav', 'web/src/hud/index.ts', 'web/src/core/freehop-call.ts',
  'web/src/companion/index.ts', 'web/public/phone.html', '.github/workflows/deploy.yml']
 for (const path of paths) write(path)
 const failures = auditSourceFiles(root, paths)
 for (const path of paths) assert.ok(failures.includes(path + ': outside source archive policy'), path)
}))

test('source audit reports credential kinds without disclosing their values', () => fixture(({ root, write }) => {
 const samples = [
  ['private key', '-----BEGIN ' + 'PRIVATE KEY-----'],
  ['GitHub token', 'ghp_' + 'a'.repeat(36)],
  ['AWS access key', 'AKIA' + 'A'.repeat(16)],
  ['API key', 'sk-proj-' + 'a'.repeat(30)],
  ['Google API key', 'AIza' + 'a'.repeat(35)],
  ['Stripe secret', 'sk_live_' + 'a'.repeat(20)],
  ['npm token', 'npm_' + 'a'.repeat(36)],
  ['credential URL', 'https://user:' + 'test-password' + '@example.invalid'],
 ]
 for (const [kind, value] of samples) {
  write('tools/credential-fixture.txt', value)
  const failures = auditSourceFiles(root, ['tools/credential-fixture.txt'])
  assert.ok(failures.includes('tools/credential-fixture.txt: ' + kind), kind)
  assert.ok(failures.every(failure => !failure.includes(value)), 'must not print credential values')
 }
}))

test('source audit rejects credential files, symlinks and absent inputs', () => fixture(({ root, write }) => {
 const paths = ['web/.env.production', 'engine/private.PEM', 'tools/.npmrc']
 for (const path of paths) write(path)
 for (const path of paths) assert.ok(auditSourceFiles(root, [path]).includes(path + ': secret-like filename'))
 write('tools/source.txt', 'source')
 symlinkSync(join(root, 'tools/source.txt'), join(root, 'tools/link.txt'))
 assert.match(auditSourceFiles(root, ['tools/link.txt'])[0], /unsupported filesystem entry/)
 assert.match(auditSourceFiles(root, ['tools/absent.txt'])[0], /unavailable/)
 assert.deepEqual(auditSourceFiles(root, ['../outside.txt']), ['../outside.txt: outside source archive policy'])
}))

test('source audit accepts public source, notice text and the single public workflow', () => fixture(({ root, write }) => {
 const paths = ['web/src/render/shaders.ts', 'licenses/GPL.txt', '.github/workflows/public-source.yml']
 for (const path of paths) write(path, 'ordinary public source')
 assert.deepEqual(auditSourceFiles(root, paths), [])
}))

test('public CI stays read-only and runs the shared clean build without deployment', () => {
 const workflow = readFileSync(new URL('../.github/workflows/public-source.yml', import.meta.url), 'utf8')
 assert.match(workflow, /pull_request:/)
 assert.match(workflow, /push:\s*branches: \['\*\*'\]/)
 assert.match(workflow, /cancel-in-progress: true/)
 assert.match(workflow, /permissions:\s*contents: read/)
 assert.match(workflow, /persist-credentials: false/)
 assert.match(workflow, /node-version: '22'/)
 assert.match(workflow, /dotnet-version: '8\.0\.x'/)
 for (const command of ['dotnet workload install wasm-tools', 'node tools/source-audit.mjs',
  'node --test tools/*.test.mjs', 'node tools/build.mjs', 'node tools/verify-release.mjs --source . engine/bin-browser/AppBundle'])
  assert.ok(workflow.includes('run: ' + command), command)
 assert.doesNotMatch(workflow, /secrets\.|contents: write|packages: write|id-token: write|pull_request_target|npm publish|gh release|git push|ssh |scp |rsync /)
 for (const action of workflow.matchAll(/uses: (\S+)/g)) assert.match(action[1], /^actions\/[\w-]+@[a-f0-9]{40}$/)
})
