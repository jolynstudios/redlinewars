#!/usr/bin/env node
// Local public-edition checks. This never pushes, tags or deploys.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { validatePublicSource } from './public-source-gate.mjs'
const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2)
if (args.some(arg => arg !== '--build')) {
 console.error('usage: node tools/release.mjs [--build] (local checks only)')
 process.exit(2)
}
validatePublicSource(root)
for (const argv of [['tools/source-audit.mjs'], ['--test', 'tools/public-export-contract.test.mjs', 'tools/source-audit.test.mjs', 'tools/verify-release.test.mjs'],
 ...(args.includes('--build') ? [['tools/build.mjs']] : [])]) {
 const result = spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit' })
 if (result.status !== 0) process.exit(result.status || 1)
}
console.log('release: local checks passed; no repository or deployment was changed')
