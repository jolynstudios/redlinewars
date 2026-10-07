#!/usr/bin/env node
// Export a committed public edition. No production import, git writes or deployment.
// node tools/export-release.mjs --commit <public commit/tag> --out <new directory>
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createExportPolicy } from './export-policy.mjs'
import { validatePublicSource } from './public-source-gate.mjs'
import { auditSourceFiles } from './source-audit.mjs'
const args = process.argv.slice(2)
const option = name => { const i = args.indexOf('--' + name); return i < 0 ? null : args[i + 1] }
if (!option('commit') || !option('out') || args.length !== 4) {
 console.error('usage: node tools/export-release.mjs --commit <public commit/tag> --out <new directory>')
 process.exit(2)
}
const root = resolve(import.meta.dirname, '..'), out = resolve(option('out'))
if (out === root || existsSync(out)) throw new Error('export: output must be a new directory')
const git = args => execFileSync('git', ['-C', root, ...args], { maxBuffer: 1024 * 1024 * 1024 })
const commit = git(['rev-parse', '--verify', option('commit') + '^{commit}']).toString().trim()
const record = JSON.parse(git(['show', commit + ':RELEASE-SOURCE.json']).toString())
if (record.schema !== 2 || record.edition !== 'public-source') throw new Error('export: commit is not a public source edition')
const entries = git(['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean).map(row => {
 const tab = row.indexOf('\t'), [mode, type] = row.slice(0, tab).split(' ')
 if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('export: non-regular source entry')
 return row.slice(tab + 1)
})
const paths = entries
const { decide } = createExportPolicy()
const invalid = paths.filter(path => !decide(path)?.publish)
if (invalid.length) throw new Error('export: unclassified or excluded tracked paths:\n' + invalid.join('\n'))
mkdirSync(out)
try {
 const tar = git(['archive', '--format=tar', commit])
 execFileSync('tar', ['-x', '-C', out], { input: tar, maxBuffer: 1024 * 1024 * 1024 })
 const failures = auditSourceFiles(out, paths)
 if (failures.length) throw new Error('export: source audit failed:\n' + failures.join('\n'))
 validatePublicSource(out)
 console.log('export: PASS — public edition ' + commit + ' (' + paths.length + ' files) → ' + out)
} catch (error) {
 rmSync(out, { recursive: true, force: true })
 throw error
}
