import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureManifest } from './fixture-manifest.mjs'

const refused = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
test('a listening fixture is required before consuming its build manifest', async () => {
	let attempts = 0
	const build = await fixtureManifest('http://fixture/build.json', { pollMs: 1, fetchManifest: async () => {
		if (++attempts < 3) throw refused()
		return Response.json({ simBuild: 'same-shared-build' })
	} })
	assert.equal(attempts, 3)
	assert.equal(build.simBuild, 'same-shared-build')
})
test('HTTP errors and malformed manifests are not retried as startup', async () => {
	for (const response of [new Response('', { status: 404 }), Response.json({}), new Response('invalid')]) {
		let attempts = 0
		await assert.rejects(fixtureManifest('http://fixture/build.json', { fetchManifest: async () => { attempts++; return response } }))
		assert.equal(attempts, 1)
	}
})
test('an unavailable fixture cannot hang or pass a gate', async () => {
	await assert.rejects(fixtureManifest('http://fixture/build.json', { timeoutMs: 10, pollMs: 1, fetchManifest: async () => { throw refused() } }), /fetch failed/)
})
