import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

const temp = mkdtempSync(join(tmpdir(), 'steelseed-mountains-'))
const outfile = join(temp, 'quality.mjs')
await build({
	stdin: {
		contents: "export { MOUNTAINS_STORAGE_KEY, resolveDistantMountains, storeDistantMountains } from './src/core/quality.ts'",
		resolveDir: new URL('..', import.meta.url).pathname,
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile,
	logLevel: 'silent',
})
const mountain = await import(pathToFileURL(outfile).href)

test.after(() => rmSync(temp, { recursive: true, force: true }))

test('distant mountains default off and explicit URL values win', () => {
	const values = new Map()
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem: key => values.get(key) ?? null,
			setItem: (key, value) => values.set(key, value),
		},
	})
	assert.equal(mountain.resolveDistantMountains(new URLSearchParams()), false)
	assert.equal(mountain.storeDistantMountains(true), true)
	assert.equal(mountain.resolveDistantMountains(new URLSearchParams()), true)
	assert.equal(mountain.resolveDistantMountains(new URLSearchParams('mountains=off')), false)
	assert.equal(mountain.resolveDistantMountains(new URLSearchParams('mountains=1')), true)
	assert.equal(mountain.resolveDistantMountains(new URLSearchParams('mountains=invalid')), true)
	delete globalThis.localStorage
})

test('blocked storage fails closed and reports persistence failure', () => {
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem: () => { throw new DOMException('blocked', 'SecurityError') },
			setItem: () => { throw new DOMException('blocked', 'SecurityError') },
		},
	})
	assert.equal(mountain.resolveDistantMountains(new URLSearchParams()), false)
	assert.equal(mountain.storeDistantMountains(true), false)
	delete globalThis.localStorage
})
