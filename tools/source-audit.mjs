#!/usr/bin/env node
// Check all tracked and unignored public-edition source files. Findings never print secret values.
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExportPolicy } from './export-policy.mjs'
import { validatePublicSource } from './public-source-gate.mjs'
const secrets = [
 ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
 ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
 ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
 ['API key', /\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{24,}/],
 ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
 ['Stripe secret', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
 ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
 ['credential URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"\x60]+:[^\s@/'"\x60]{6,}@/i],
]
export function auditSourceFiles(root, files) {
 const failures = [], { decide } = createExportPolicy()
 for (const path of files) {
  const decision = decide(path)
  if (!decision?.publish) failures.push(path + ': outside source archive policy')
  if (decision?.why === 'invalid source path') continue
  if (/(?:^|\/)\.env(?:\.|$)|\.(pem|key|p12|pfx|keystore|jks)$|(?:^|\/)\.(npmrc|netrc)$/i.test(path))
   failures.push(path + ': secret-like filename')
  const file = resolve(root, path)
  let stat
  try { stat = lstatSync(file) } catch { failures.push(path + ': source file unavailable'); continue }
  if (!stat.isFile()) { failures.push(path + ': unsupported filesystem entry'); continue }
  const data = readFileSync(file)
  if (data.subarray(0, 8000).includes(0)) continue
  const text = data.toString('utf8')
  for (const [kind, re] of secrets) if (re.test(text)) failures.push(path + ': ' + kind)
 }
 return failures
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
 const root = resolve(import.meta.dirname, '..')
 validatePublicSource(root)
 const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
 }).split('\0').filter(Boolean))].sort()
 const failures = auditSourceFiles(root, files)
 if (failures.length) {
  console.error('source-audit: FAIL\n' + failures.join('\n'))
  process.exit(1)
 }
 console.log('source-audit: PASS — ' + files.length + ' source files; path inventory and credential patterns checked')
}
