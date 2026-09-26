// Bundle entry for `tools/audiogate.mjs` ONLY.
//
// Same reasoning as `units/archetype/index.gate.ts`: the gate must measure the REAL synth
// rather than a reimplementation of it, and Node's type stripper cannot resolve this
// project's extensionless imports, so esbuild bundles it.
//
// Deliberately NOT `index.ts`. `web/src/main.ts` globs `./{...,audio}/index.ts` to discover
// nodes; a second index here would be one rename away from booting as a second audio node.
//
// Note what is NOT exported: the node itself. The gate never constructs `Audio`, because
// everything worth asserting about a sound is in the samples, and a gate that needed an
// AudioContext would need the browser harness — which §14.8 specifically bought us out of.
// The NODE is exported too, unlike the archetype gate entry. `synth.ts` decides what a sound
// is SHAPED like; `index.ts` decides where it is placed, how loud, how far away and whether it
// plays at all — and that half had no instrument until `--node` existed. It is also the half
// where the one integration bug of this session lived (a listener basis computed by `play()`
// and read by `update()`).
export { Audio } from './index'
export {
	buildVoiceBank,
	FAMILY,
	FAMILY_COUNT,
	FAMILY_EXCITATION,
	FAMILY_IMPULSIVE,
	FAMILY_NAMES,
	FAMILY_OVERLAPS,
	FAMILY_SCALES,
	familyRecipe,
	renderRecipe,
	renderMotor,
	renderDischarge,
	renderFlame,
	TESLA_ARC_LIFETIME_S,
	TESLA_FLICKER_STEPS,
	renderBlast,
	impactParams,
	destructionParams,
	movementParams,
	renderLoop,
	renderBell,
	NOTIFY_F0,
	NOTIFY_DURATION_S,
	heaviness,
	reportBand,
	impactBand,
	destructionBand,
	bandDamage,
	bandViolence,
	seededNoise,
	spectralCentroid,
	decayS,
	dcOffset,
	rms,
	REPORT_BANDS,
	IMPACT_BANDS,
	DESTRUCTION_BANDS,
	SURFACE_VOICING,
} from './synth'
