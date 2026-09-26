#!/usr/bin/env node
// The quality table must reach the compiled WGSL, not merely the on-screen label.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bundled = await build({
	stdin: { contents: `
		export { budgetFor, makeConfig } from './src/core/config'
		export { FORWARD_WGSL, SKY_DOME_WGSL, TAA_WGSL, postWgsl,
			specializeForwardWgsl, specializeTaaWgsl } from './src/render/shaders'
	`, resolveDir: root },
	bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
})
const { budgetFor, makeConfig, FORWARD_WGSL, SKY_DOME_WGSL, TAA_WGSL, postWgsl,
	specializeForwardWgsl, specializeTaaWgsl } = await import(
	`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const features = { contact: true, contactDebug: false,
	reflections: false, reflectionsDebug: false, reflectionsMask: false }
for (const name of ['low', 'medium', 'high', 'ultra', 'ultra-max']) {
	const q = budgetFor(name).render
	const forward = specializeForwardWgsl(FORWARD_WGSL, q)
	const dome = specializeForwardWgsl(SKY_DOME_WGSL, q)
	const post = postWgsl(features, q)
	const taa = specializeTaaWgsl(TAA_WGSL, q)
	assert.match(forward, q.shadowPcfTaps === 9 ? /return visibility \/ 9\.0;/ : /return visibility \* 0\.25;/)
	assert.match(dome, new RegExp(`for \\(var i = 0u; i < ${q.cloudOctaves}u; i = i \\+ 1u\\) \\{\\n\\t\\tsum = sum \\+ valueNoise`))
	assert.match(post, new RegExp(`array<vec2<f32>, ${q.contactTaps}>\\(`))
	assert.ok(post.includes('frame.jitter.xy * 2.0 * frame.screen.zw'), `${name}: contact reconstruction must undo projection jitter`)
	assert.ok(!taa.includes('if (x != 0 && y != 0) { continue; }'), `${name}: TAA must use 3×3 clamp`)
	assert.equal(q.taaStaticFeedback, 0.99, `${name}: stationary edges must retain enough TAA history`)
	assert.ok(taa.includes(`select(frame.post.z, ${q.taaStaticFeedback.toFixed(2)}`), `${name}: static feedback missing`)
	assert.ok(q.sharpenStrength <= 0.1, `${name}: sharpen amplifies temporal aliasing`)
	if (q.probeTrilinear) {
		assert.match(forward, /for \(var i = 0u; i < 8u; i = i \+ 1u\) \{\n\t\tlet ox = i & 1u;\n\t\tlet oy =/)
		assert.ok(!forward.includes('let by = min(base.y'), `${name}: nearest vertical probe slice survived`)
	}
}
assert.equal(budgetFor('ultra').render.shadowMapSize, 2048)
assert.equal(budgetFor('ultra-max').render.shadowCasterExtent, 220)
for (const name of ['low', 'medium', 'high', 'turbo', 'classic', 'ultra', 'ultra-max'])
	assert.equal(budgetFor(name).contactShading, false, `${name}: screen-space contact must not flicker by default`)
assert.equal(makeConfig({ backend: 'webgpu', quality: 'high', graphicsChoice: 'dynamic' }).q.contactShading,
	false, 'Dynamic inherits the stable contact default')
console.log('renderqualitygate: PASS — five tiers select their shadow, cloud, probe, contact, TAA and sharpen variants')
