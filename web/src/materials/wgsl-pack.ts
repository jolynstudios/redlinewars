// STEELSEED — materials/wgsl-pack
// Forge pass 2: read the structure field, DERIVE the surface from it, pack the four
// outputs into staging buffers.
//
// Everything visual here is a consequence of geometry that pass 1 actually generated:
//   normal    central difference of the height field, in metres per metre
//   curvature discrete Laplacian, normalised by the set's height range
//   occlusion an 8-direction, 5-radius horizon march over the same height field
// and then paint wears where the curvature says the surface is proud, while soot, rust
// and grime accumulate where the occlusion says the surface is enclosed. That is the
// difference between a material and a photograph of one.
//
// Why buffers instead of storage textures: rg8unorm and r8unorm are not storage-capable
// formats in core WebGPU (they need the tier-1 texture-formats feature), and requiring an
// optional feature to boot would be a worse trade than one copyBufferToTexture per
// target. The byte packing for those two formats is assembled through workgroup memory,
// because four invocations share one 32-bit word of the r8unorm image and a race there
// would corrupt the player-colour mask.

export const PACK_BINDINGS_WGSL = /* wgsl */ `
@group(0) @binding(1) var fieldIn: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outAlbedo: array<u32>;
@group(0) @binding(3) var<storage, read_write> outNormal: array<u32>;
@group(0) @binding(4) var<storage, read_write> outOrm: array<u32>;
@group(0) @binding(5) var<storage, read_write> outMask: array<u32>;

struct Shaded {
	albedo: vec3<f32>,
	rough: f32,
	metal: f32,
	ao: f32,
	mask: f32,
	// 0 none, 0.25 Foundry warm emitter, 0.75 Lattice cool emitter.
	// Constant over a set so mip filtering cannot turn a mask into a tint.
	emissive: f32,
}

/** Wrapped fetch. The field tiles, so wrapping is not a clamp hack — it is correct. */
fn loadField(x: i32, y: i32) -> vec4<f32> {
	let r = i32(P.res);
	return textureLoad(fieldIn, vec2<i32>(((x % r) + r) % r, ((y % r) + r) % r), 0);
}

fn tintJit(c: vec3<f32>, h: f32) -> vec3<f32> {
	return c * (1.0 + (h - 0.5) * 2.0 * P.colorJitter);
}
`

export const SHADE_KINDS_WGSL = /* wgsl */ `
// tintA.w / tintB.w / tintC.w carry the roughness that belongs with each tint, so a
// colour and the microfacet response that goes with it can never drift apart.

// --- 0 soil -----------------------------------------------------------------
fn shadeSoil(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	let dry = saturate(f.y * 1.25 - 0.28 + convex * 0.45 - (1.0 - ao) * 0.40);
	var c = mix(P.tintA.rgb, P.tintC.rgb, dry);
	c = mix(c, P.tintB.rgb, saturate(concave * 0.65 + (1.0 - ao) * 0.55));
	if (sub > 0.5) { c = mix(c, P.tintC.rgb * 0.78, 0.7); }
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = mix(P.tintB.w, P.tintC.w, dry);
	o.metal = 0.0;
	o.ao = ao * (1.0 - f.z * 0.55);
	o.mask = 0.0;
	return o;
}

// --- 1 rock -----------------------------------------------------------------
fn shadeRock(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	// Iron leaches DOWN out of the joints, so the stain follows occlusion, not noise.
	let stain = saturate(f.y * 1.1 - 0.45 + (1.0 - ao) * 0.85 + concave * 0.5);
	let polish = saturate(convex * 0.9);
	var c = mix(P.tintA.rgb, P.tintC.rgb, select(0.0, 0.75, sub > 0.5));
	c = mix(c, P.tintB.rgb, stain);
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = mix(mix(P.tintA.w, P.tintC.w, polish), P.tintB.w, stain);
	o.metal = 0.0;
	o.ao = ao * (1.0 - f.z * 0.70);
	o.mask = 0.0;
	return o;
}

// --- 2 sand -----------------------------------------------------------------
fn shadeSand(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let rh = fract(f.w);
	let damp = saturate((1.0 - ao) * 0.8 + concave * 0.5 - f.y * 0.5);
	let mineral = saturate(valueN(uv * 30.0, 30, P.seed + 71u) * bandK(30.0) - 0.55) * 2.0;
	var c = mix(P.tintA.rgb, P.tintB.rgb, damp);
	c = mix(c, P.tintC.rgb, mineral * 0.6);
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = mix(P.tintA.w, P.tintB.w, damp);
	o.metal = 0.0;
	o.ao = ao * (1.0 - f.z * 0.35);
	o.mask = 0.0;
	return o;
}

// --- 3 gravel ---------------------------------------------------------------
fn shadeGravel(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	// Every stone gets its own tone from its own cell hash — a single grey rubble field
	// is the tell that a gravel texture was painted rather than grown.
	let stoneTone = mix(P.tintB.rgb, P.tintA.rgb, rh);
	let dustFill = saturate((1.0 - ao) * 0.9 + f.z * 0.7);
	var c = select(P.tintC.rgb, stoneTone, sub < 0.5);
	c = mix(c, P.tintC.rgb, dustFill * 0.55);
	var o: Shaded;
	o.albedo = tintJit(c, fract(rh * 7.7));
	o.rough = mix(mix(P.tintA.w, P.tintB.w, rh), P.tintC.w, dustFill * 0.6);
	o.metal = 0.0;
	o.ao = ao * (1.0 - f.z * 0.75);
	o.mask = 0.0;
	return o;
}

// --- 4 grass ----------------------------------------------------------------
fn shadeGrass(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	let dry = saturate(f.y * 1.15 - 0.25 + convex * 0.35);
	var c = mix(P.tintA.rgb, P.tintB.rgb, dry);
	// Blade tips catch the light; the base of a tuft is deeply occluded and darker.
	c = c * mix(0.55, 1.15, saturate(ao * 1.2 - 0.1));
	if (sub > 0.5) { c = mix(c, P.tintC.rgb, 0.85); }
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = mix(P.tintA.w, P.tintB.w, dry);
	o.metal = 0.0;
	o.ao = ao * (1.0 - f.z * 0.65);
	o.mask = 0.0;
	return o;
}

// --- 5 road -----------------------------------------------------------------
fn shadeRoad(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	// The wheel band is polished by traffic: the aggregate is worn flat, so it is
	// SMOOTHER than the untravelled bitumen either side of it, not dirtier.
	let polish = saturate(f.y * 1.3 - 0.35);
	var c = P.tintA.rgb;
	if (sub > 0.5 && sub < 1.5) { c = mix(c, P.tintB.rgb, 0.85); }
	if (sub > 1.5 && sub < 2.5) { c = c * 0.55; }
	if (sub > 2.5) { c = mix(c, P.tintB.rgb * 0.75, 0.5); }
	c = mix(c, P.tintC.rgb, saturate(polish * 0.35 - (1.0 - ao) * 0.3));
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = mix(P.tintA.w, P.tintC.w, polish);
	o.rough = mix(o.rough, P.tintB.w, select(0.0, 1.0, sub > 0.5 && sub < 1.5));
	o.metal = 0.0;
	o.ao = ao * (1.0 - f.z * 0.6);
	o.mask = 0.0;
	return o;
}

// --- 6 metal ----------------------------------------------------------------
fn shadeMetal(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let plateHash = fract(f.w);
	let proud = saturate(convex * 1.5 + P.wearBias * 0.4);
	let sheltered = saturate((1.0 - ao) * 1.2 + concave * 0.65);
	// Oxide blooms out of the seams and the sheltered pockets where water sits.
	let rust = saturate(f.y * 1.25 - 0.60 + sheltered * 0.95);
	let bare = saturate(proud * 1.35 - rust * 1.4);
	var c = mix(P.tintA.rgb, P.tintB.rgb, bare);
	c = mix(c, P.tintC.rgb, rust);
	var rough = mix(P.tintA.w, P.tintB.w, bare);
	rough = mix(rough, P.tintC.w, rust);
	if (sub > 1.5 && sub < 2.5) { rough = rough * 0.85; }
	var o: Shaded;
	o.albedo = tintJit(c, plateHash);
	o.rough = rough;
	// Metalness is 0 or 1 and the transition is SPATIAL. Paint and oxide are dielectric
	// films over the plate; a fractional metalness is not a material, it is a mistake.
	o.metal = step(0.5, bare - rust);
	o.ao = ao * (1.0 - f.z * 0.6);
	// Whole plates take the player's paint, plus the hazard band. Worn or rusted areas
	// lose it, because the mask IS paint and paint comes off (§9). The wear terms are
	// thresholded rather than multiplied so intact paint reads a full 1.0 — a mask that
	// only ever reaches 0.88 desaturates every player colour on the map by 12%.
	let isFace = select(0.0, 1.0, sub < 0.5);
	let isBand = select(0.0, 1.0, sub > 2.5);
	o.mask = saturate(
		(step(0.80, plateHash) * isFace + isBand) *
		(1.0 - smoothstep(0.20, 0.75, bare)) *
		(1.0 - smoothstep(0.30, 0.85, rust)),
	);
	return o;
}

// --- 7 concrete -------------------------------------------------------------
fn shadeConcrete(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	let weather = saturate(f.y * 1.1 - 0.3 + (1.0 - ao) * 0.7 + concave * 0.4);
	let chalk = saturate(convex * 0.8 + 0.15);
	var c = mix(P.tintA.rgb, P.tintC.rgb, weather);
	if (sub > 0.5 && sub < 1.5) { c = mix(c, P.tintB.rgb, 0.8); }
	if (sub > 2.5) { c = c * 0.6; }
	c = mix(c, P.tintA.rgb * 1.12, chalk * 0.3);
	// A painted apron band, laid across the slab rather than following the noise.
	let band = step(0.90, fract(aniPhase(uv, 3.0) + 0.15));
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = mix(P.tintA.w, P.tintC.w, weather);
	o.metal = 0.0;
	o.ao = ao * (1.0 - f.z * 0.7);
	o.mask = band * select(0.0, 1.0, sub < 2.5) * (1.0 - smoothstep(0.45, 0.9, weather));
	return o;
}

// --- 8 water ----------------------------------------------------------------
fn shadeWater(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	// Deep water is nearly all specular: the albedo floor exists only so the §7 range
	// holds, and the visual work is done by the normal and a very low roughness.
	let foam = saturate(convex * 1.6 * f.y - 0.35);
	var c = mix(P.tintA.rgb, P.tintB.rgb, foam);
	var o: Shaded;
	o.albedo = c;
	o.rough = mix(P.tintA.w, P.tintB.w, foam);
	o.metal = 0.0;
	o.ao = 1.0;
	o.mask = 0.0;
	return o;
}

// --- 9 shallow --------------------------------------------------------------
fn shadeShallow(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	// The bed reads through, tinted by how much water is over it — that depth cue is
	// what separates shallow from deep at a glance, and it must not be a flat overlay.
	let depth = saturate(f.y * 1.2 - 0.15 + (1.0 - ao) * 0.4);
	var bed = P.tintA.rgb;
	if (sub > 1.5) { bed = mix(bed, P.tintC.rgb, 0.8); }
	if (sub > 0.5 && sub < 1.5) { bed = mix(bed, P.tintC.rgb * 0.8, 0.45); }
	let c = mix(bed, P.tintB.rgb, depth * 0.8);
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = mix(P.tintA.w, P.tintB.w, depth);
	o.metal = 0.0;
	o.ao = mix(ao, 1.0, depth * 0.6);
	o.mask = 0.0;
	return o;
}

// --- 10 snow ----------------------------------------------------------------
fn shadeSnow(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	// Snow's shading is almost entirely occlusion: crevices go blue because the sky is
	// all that reaches them, so the blue is driven by the derived AO, never painted in.
	let shade = saturate((1.0 - ao) * 1.35 + concave * 0.5);
	var c = mix(P.tintA.rgb, P.tintB.rgb, shade);
	if (sub > 0.5) { c = mix(c, P.tintC.rgb, 0.45); }
	let crust = saturate(convex * 1.2 * f.y);
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = mix(P.tintA.w, P.tintC.w, 1.0 - crust);
	o.metal = 0.0;
	o.ao = ao * (1.0 - f.z * 0.45);
	o.mask = 0.0;
	return o;
}

// --- 11 ash -----------------------------------------------------------------
fn shadeAsh(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	// Embers survive only down in the cracks, so the glow colour is gated on occlusion
	// AND on being inside a crack. Ember light on an exposed flake would be nonsense.
	let inCrack = select(0.0, 1.0, sub > 0.5 && sub < 1.5);
	let ember = saturate(f.y * 1.4 - 0.55) * inCrack * saturate((1.0 - ao) * 1.5);
	let paleTop = saturate(convex * 1.1 + 0.1);
	var c = mix(P.tintA.rgb, P.tintB.rgb, paleTop * 0.7);
	c = mix(c, P.tintC.rgb, ember);
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = mix(P.tintA.w, P.tintC.w, ember);
	o.metal = 0.0;
	o.ao = ao * (1.0 - f.z * 0.8);
	o.mask = 0.0;
	return o;
}

// --- 12 resource ------------------------------------------------------------
fn shadeResource(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	let isFacet = select(0.0, 1.0, sub > 0.5 && sub < 1.5);
	let isVein = select(0.0, 1.0, sub > 1.5);
	var c = P.tintB.rgb;
	c = mix(c, P.tintA.rgb, isFacet);
	c = mix(c, P.tintC.rgb, isVein);
	// A crystal arris catches light, so the facet edge polishes rather than dulls.
	let arris = saturate(convex * 1.4);
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = mix(P.tintB.w, P.tintA.w, isFacet) * mix(1.0, 0.6, arris * isFacet);
	o.rough = mix(o.rough, P.tintC.w, isVein);
	// Only the vein is metal. The crystal is a dielectric and must not read as chrome.
	o.metal = isVein;
	o.ao = ao * (1.0 - f.z * 0.7);
	o.mask = 0.0;
	return o;
}

// --- 13 foundry -------------------------------------------------------------
fn shadeFoundry(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let plateHash = fract(f.w);
	let proud = saturate(convex * 1.7 + P.wearBias * 0.35);
	let sheltered = saturate((1.0 - ao) * 1.3 + concave * 0.7);
	// Ochre wears through to steel on the proud lips and rivet crowns; soot lands where
	// the plate work encloses. Both come out of the generated relief, not a decal.
	let bare = saturate(proud * 1.25 - sheltered * 0.45);
	let soot = saturate(f.y * sheltered * 1.55 - 0.10);
	let isWeld = select(0.0, 1.0, sub > 1.5 && sub < 2.5);
	let isRivet = select(0.0, 1.0, sub > 2.5 && sub < 3.5);
	let isStencil = select(0.0, 1.0, sub > 3.5);
	var c = P.tintA.rgb;
	c = mix(c, vec3<f32>(0.60, 0.58, 0.54), isStencil * 0.75);
	c = mix(c, P.tintB.rgb, max(bare, max(isWeld * 0.9, isRivet * 0.6)));
	c = mix(c, P.tintC.rgb, soot);
	var rough = mix(P.tintA.w, P.tintB.w, max(bare, isWeld));
	rough = mix(rough, P.tintC.w, soot);
	// A weld bead is rippled and scaled, so it is the roughest bare steel on the hull.
	rough = mix(rough, 0.72, isWeld * 0.6);
	var o: Shaded;
	o.albedo = tintJit(c, plateHash);
	o.rough = rough;
	o.metal = step(0.5, max(bare, max(isWeld, isRivet)) - soot * 0.9 - isStencil);
	o.ao = ao * (1.0 - f.z * 0.65);
	// Player colour lands on whole plates and on the stencil band: a repaint of specific
	// panels, with the panel boundary exactly where the plate boundary is.
	// Coverage lowered from 38% to ~20% of face plates. §9.1 asks for "a real repaint of
	// specific panels and markings", and 38% of every plate in team colour is neither — it is
	// a livery. Measured off the baked r8 texture before the change: foundry 39.0% of texels
	// above 0.78 against a nominal 38%, so the mask was doing exactly what it was told. The
	// number was the problem, not the mechanism.
	//
	// This is tuning, and it is worth naming why it is legitimate here when I refused it
	// twice earlier in the same session: the measurement is UNDERSTOOD and the target is
	// STATED. Moving a threshold to make an unexplained number look better is the failure;
	// moving one toward a written art-direction target after measuring what it currently does
	// is the job. The stencil band is untouched — that is the marking, and markings stay.
	let isFace = select(0.0, 1.0, sub < 0.5);
	o.mask = saturate(
		(step(0.80, plateHash) * isFace + isStencil) *
		(1.0 - smoothstep(0.20, 0.75, bare)) *
		(1.0 - smoothstep(0.35, 0.85, soot)),
	);
	o.emissive = 0.25;
	return o;
}

// --- 14 lattice -------------------------------------------------------------
fn shadeLattice(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let panelHash = fract(f.w);
	let isSheet = select(0.0, 1.0, sub < 0.5);
	let isGirder = select(0.0, 1.0, sub > 0.5 && sub < 1.5);
	let isGusset = select(0.0, 1.0, sub > 1.5 && sub < 2.5);
	let isFastener = select(0.0, 1.0, sub > 2.5 && sub < 3.5);
	// matId 4 and 5 were authored as canvas and its lacing cord. §9.0 v2 removed canvas
	// from the Lattice palette, so they are reinterpreted here as a composite infill panel
	// and the recessed seam between panels. The field pass generates identical relief for
	// both readings — a hemmed bay and a panel bay are the same shape — which is why this
	// is a rename plus a material change rather than a regeneration.
	let isComposite = select(0.0, 1.0, sub > 3.5 && sub < 4.5);
	let isSeam = select(0.0, 1.0, sub > 4.5);
	let isFrame = max(isGirder, isGusset);
	let exposed = saturate(convex * 1.25 + f.y * 0.32);
	let sheltered = saturate((1.0 - ao) * 1.2 + concave * 0.65);

	// §9.0 v2 (2026-08-05). The relief below is unchanged and still correct — bolted truss
	// members, gusset plates and ribbed infill are exactly the Lattice's v2 vocabulary. What
	// changed is the MATERIAL sitting on it. The previous pass blooming zinc to chalk and
	// rusting the joins is now over the wear ceiling: corrosion belongs to drift and to
	// damage states, not to a serviceable machine. Canvas left the faction's palette
	// entirely, so matId 4/5 are reinterpreted rather than regenerated — a laced canvas
	// bay becomes a composite infill panel with a fine recessed seam. Identical geometry,
	// v2-correct material, and no field-pass change to re-review.
	//
	// Anodised alloy is a DIELECTRIC film over metal, which is why the bare term still drives
	// metalness: the anodising is a coating and the exposed flange underneath is not.
	let bare = saturate(exposed * 1.18 - sheltered * 0.35) * max(isFrame, isFastener);
	// Settled dust, not oxide. Sits in shelter, wipes off proud faces, and is deliberately
	// weak — this is the §9.0 floor (a machine with no history reads as a render), not the
	// ceiling. Amplitude is roughly a third of the chalk term it replaces.
	let dust = saturate(f.y * 0.44 + sheltered * 0.38 - 0.46) * (1.0 - bare);
	// Thin fading on panel decals and printed markings. Sun-facing only.
	let fade = saturate(f.y * 0.55 + convex * 0.30 - sheltered * 0.26);

	var c = P.tintA.rgb;
	c = mix(c, P.tintB.rgb, isFrame);
	// Exposed flange: pale machined alloy, slightly brighter than the anodised face.
	c = mix(c, vec3<f32>(0.62, 0.645, 0.665), bare * 0.85);
	c = mix(c, vec3<f32>(0.42, 0.435, 0.45), dust * 0.42);
	let compositePanel = mix(P.tintC.rgb, P.tintC.rgb * 0.86, fade * 0.5);
	c = mix(c, compositePanel, isComposite);
	// The seam is a recessed shadow line between composite panels, not a cord.
	c = mix(c, P.tintC.rgb * 0.55, isSeam);

	var rough = P.tintA.w;
	rough = mix(rough, P.tintB.w, isFrame);
	// Machined alloy is smoother than the anodised face; dust raises it slightly.
	rough = mix(rough, 0.30, bare);
	rough = mix(rough, 0.74, dust);
	rough = mix(rough, P.tintC.w, isComposite);
	rough = mix(rough, 0.68, isSeam);
	var o: Shaded;
	o.albedo = tintJit(c, panelHash);
	o.rough = rough;
	// Anodising and composite are both dielectric. Only the exposed flange and the bare
	// sheet read as metal, and the transition stays SPATIAL — a fractional metalness is
	// not a material.
	let metalRaw = max(isSheet * (1.0 - isComposite), max(bare, isFastener));
	o.metal = step(0.5, metalRaw);
	o.ao = ao * (1.0 - f.z * 0.72);
	// Whole ribbed infill panels take the player's paint. Fasteners, frame members and
	// composite stay their physical materials, so colour reads as a real field repaint.
	// Dust attenuates it far less than chalk did — paint under dust is still paint.
	// Same reduction as the Foundry and for the same reason: 26% of infill panels reads as a
	// livery rather than as markings. The window narrows rather than shifting, so which
	// panels are painted stays stable under the same hash — a shifted window would repaint a
	// different set and change every baseline shot for no design reason.
	o.mask = saturate(
		isSheet *
		step(0.62, panelHash) *
		(1.0 - step(0.76, panelHash)) *
		(1.0 - smoothstep(0.55, 0.95, dust)),
	);
	o.emissive = 0.75;
	return o;
}

// --- 15 drift ---------------------------------------------------------------
fn shadeDrift(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	let sub = floor(f.w);
	let rh = fract(f.w);
	let sheltered = saturate((1.0 - ao) * 1.25 + concave * 0.6);
	let proud = saturate(convex * 1.4);
	let decay = saturate(f.y * 1.1 - 0.35 + sheltered * 0.6);
	// Four salvaged materials, chosen per region, each ageing in its own way. The
	// mismatch is the point: Drift exists to give the lighting something unowned.
	var c = P.tintC.rgb;
	var rough = P.tintC.w;
	var metalRaw = 0.0;
	if (sub < 0.5) {
		c = mix(P.tintB.rgb, P.tintC.rgb, decay);
		rough = mix(P.tintB.w, P.tintC.w, decay);
		metalRaw = 1.0 - decay;
	} else if (sub < 1.5) {
		// Bleached panel: UV takes the pigment out of the exposed faces first.
		c = mix(P.tintA.rgb, P.tintA.rgb * 0.55, sheltered);
		c = mix(c, P.tintA.rgb * 1.15, proud * 0.5);
		rough = P.tintA.w;
	} else if (sub < 2.5) {
		c = mix(P.tintB.rgb, P.tintC.rgb, decay * 0.7);
		rough = mix(P.tintB.w * 0.85, P.tintC.w, decay);
		metalRaw = 1.0 - decay * 0.8;
	} else if (sub < 3.5) {
		c = mix(P.tintA.rgb * 0.55, P.tintC.rgb * 0.9, decay * 0.6);
		rough = 0.90;
	} else {
		// Fastener: a bolt head someone else put in, still bright where it is proud.
		c = mix(P.tintC.rgb, P.tintB.rgb, proud);
		rough = mix(P.tintC.w, P.tintB.w * 1.1, proud);
		metalRaw = proud;
	}
	var o: Shaded;
	o.albedo = tintJit(c, rh);
	o.rough = rough;
	o.metal = step(0.5, metalRaw);
	o.ao = ao * (1.0 - f.z * 0.7);
	// Drift is unowned, so it never carries a player's colour.
	o.mask = 0.0;
	return o;
}

fn ssShade(uv: vec2<f32>, f: vec4<f32>, ao: f32, convex: f32, concave: f32) -> Shaded {
	switch (P.kind) {
		case 0u:  { return shadeSoil(uv, f, ao, convex, concave); }
		case 1u:  { return shadeRock(uv, f, ao, convex, concave); }
		case 2u:  { return shadeSand(uv, f, ao, convex, concave); }
		case 3u:  { return shadeGravel(uv, f, ao, convex, concave); }
		case 4u:  { return shadeGrass(uv, f, ao, convex, concave); }
		case 5u:  { return shadeRoad(uv, f, ao, convex, concave); }
		case 6u:  { return shadeMetal(uv, f, ao, convex, concave); }
		case 7u:  { return shadeConcrete(uv, f, ao, convex, concave); }
		case 8u:  { return shadeWater(uv, f, ao, convex, concave); }
		case 9u:  { return shadeShallow(uv, f, ao, convex, concave); }
		case 10u: { return shadeSnow(uv, f, ao, convex, concave); }
		case 11u: { return shadeAsh(uv, f, ao, convex, concave); }
		case 12u: { return shadeResource(uv, f, ao, convex, concave); }
		case 13u: { return shadeFoundry(uv, f, ao, convex, concave); }
		case 14u: { return shadeLattice(uv, f, ao, convex, concave); }
		case 15u: { return shadeDrift(uv, f, ao, convex, concave); }
		default:  { return shadeSoil(uv, f, ao, convex, concave); }
	}
}
`

export const PACK_ENTRY_WGSL = /* wgsl */ `
/**
 * Horizon occlusion over the generated height field. Five radii per direction, spaced
 * geometrically, so a rivet crown and a plate-wide recess are both resolved by the same
 * march — a single-radius AO would see one and miss the other.
 */
fn horizonAO(x: i32, y: i32, h0: f32) -> f32 {
	let texelM = P.tileMeters / f32(P.res);
	// The first step is a physical distance, not one texel, so the march covers the same
	// span of real surface at every mip and the occlusion does not creep as it coarsens.
	let r0 = max(1.0, WEAR_TILE_FRACTION * f32(P.res));
	var occ = 0.0;
	for (var d = 0; d < 8; d++) {
		let a = f32(d) * (TAU / 8.0);
		let dir = vec2<f32>(cos(a), sin(a));
		var maxSlope = 0.0;
		var r = r0;
		for (var k = 0; k < 5; k++) {
			let hs = loadField(x + i32(round(dir.x * r)), y + i32(round(dir.y * r))).r;
			maxSlope = max(maxSlope, (hs - h0) / (r * texelM));
			r = r * 1.8;
		}
		occ = occ + maxSlope * inverseSqrt(1.0 + maxSlope * maxSlope);
	}
	return saturate(1.0 - occ * 0.125);
}

/**
 * Discrete Laplacian at radius r, normalised by the set's height range AND by the
 * physical span of the stencil, so the same thresholds mean the same thing on 30 mm of
 * plate relief and 550 mm of rock face — and at every mip level.
 *
 * The r*r term is the part that was missing, and it mattered. A discrete Laplacian's
 * magnitude scales with the square of its radius, so normalising by height range alone
 * made convex/concave inflate steadily toward the coarse mips. That feeds bare,
 * which gates the player-colour mask — so a unit's faction colour COVERED LESS AREA the
 * further the camera pulled back, which is precisely backwards for §9's "distinguishable
 * by silhouette at max zoom-out".
 *
 * The radius is also texel-locked at coarse mips: max(1, ...) cannot go below one
 * texel, so from roughly mip 3 the physical radius doubles every level (measured: cr =
 * 3, 2, 1, 1, 1, 1, 1 for res 512..8; on the low preset it is 1 at every level). That
 * floor is unavoidable — a sub-texel stencil does not exist — but dividing by the actual
 * radius used, rather than the radius intended, keeps the RESULT scale-invariant even
 * when the stencil cannot shrink any further.
 */
fn curvatureAt(x: i32, y: i32, h0: f32, r: i32) -> f32 {
	let s = loadField(x - r, y).r + loadField(x + r, y).r + loadField(x, y - r).r + loadField(x, y + r).r;
	let rf = max(f32(r), 1.0);
	return clamp((s - 4.0 * h0) / (max(P.heightScale, 1e-5) * rf * rf), -1.0, 1.0);
}

// Sub-32-bit targets are assembled here: four invocations share one word of the r8unorm
// mask and two share one word of the rg8unorm normal, so the bytes are staged through
// workgroup memory and combined by a single writer rather than raced for.
var<workgroup> shNormal: array<u32, 64>;
var<workgroup> shMask: array<u32, 64>;

@compute @workgroup_size(8, 8, 1)
fn forgePack(
	@builtin(global_invocation_id) gid: vec3<u32>,
	@builtin(local_invocation_id) lid: vec3<u32>,
) {
	let x = i32(gid.x);
	let y = i32(gid.y);
	let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5)) / f32(P.res);
	let texelM = P.tileMeters / f32(P.res);

	let c = loadField(x, y);
	let hL = loadField(x - 1, y).r;
	let hR = loadField(x + 1, y).r;
	let hD = loadField(x, y - 1).r;
	let hU = loadField(x, y + 1).r;

	// Tangent-space normal, +Z out of the surface, in true metres per metre — which is
	// why heightScale is a real distance in the set table and not a taste knob.
	let n = normalize(vec3<f32>(
		-(hR - hL) / (2.0 * texelM),
		-(hU - hD) / (2.0 * texelM),
		1.0,
	));

	// Two curvature radii, both physical: a tight one for the hard core of an exposed
	// edge and a wider one for the halo of thinning paint around it. Real wear has both,
	// and a single-radius stencil produces a one-texel outline that reads as a wireframe.
	let cr = max(1, i32(round(WEAR_TILE_FRACTION * f32(P.res))));
	let curvNear = curvatureAt(x, y, c.r, cr);
	let curvFar = curvatureAt(x, y, c.r, cr * 3);
	let convex = saturate(max(-curvNear * 2.0, -curvFar * 1.2));
	let concave = saturate(max(curvNear * 2.0, curvFar * 1.2));

	let ao = horizonAO(x, y, c.r);
	let sh = ssShade(uv, c, ao, convex, concave);

	// §7: albedo stays inside 0.02..0.9. Nothing real is blacker than soot or brighter
	// than fresh snow, and values outside that range break every lighting assumption
	// downstream of here.
	let alb = clamp(sh.albedo, vec3<f32>(0.02), vec3<f32>(0.90));
	let wAlbedo = pack4x8unorm(vec4<f32>(srgbEnc(alb), saturate(sh.emissive)));

	let oct = octEncode(n);
	let wNormalTexel = pack4x8unorm(vec4<f32>(oct, 0.0, 0.0)) & 0xffffu;

	// r roughness, g metalness, b ao, a height. Height is centred so a flat surface
	// encodes to 0.5 and parallax can push either way. The encode range is deliberately
	// wider than heightScale: that is the amplitude the field is composed at, not the
	// extreme it reaches, and clamping to it flattens every crack floor into a plateau.
	// SsSetInfo.heightRange carries the product, so consumers decode straight to metres.
	let height01 = saturate(c.r / max(P.heightScale * HEIGHT_ENCODE_SPAN, 1e-5) + 0.5);
	let wOrm = pack4x8unorm(vec4<f32>(
		clamp(sh.rough, 0.03, 1.0),
		step(0.5, sh.metal),
		saturate(sh.ao),
		height01,
	));

	let wMaskTexel = pack4x8unorm(vec4<f32>(saturate(sh.mask), 0.0, 0.0, 0.0)) & 0xffu;

	let li = lid.y * 8u + lid.x;
	shNormal[li] = wNormalTexel;
	shMask[li] = wMaskTexel;
	workgroupBarrier();

	outAlbedo[gid.y * P.pitchA + gid.x] = wAlbedo;
	outOrm[gid.y * P.pitchA + gid.x] = wOrm;

	if ((lid.x & 1u) == 0u) {
		outNormal[gid.y * P.pitchN + (gid.x >> 1u)] = shNormal[li] | (shNormal[li + 1u] << 16u);
	}
	if ((lid.x & 3u) == 0u) {
		outMask[gid.y * P.pitchM + (gid.x >> 2u)] =
			shMask[li] | (shMask[li + 1u] << 8u) | (shMask[li + 2u] << 16u) | (shMask[li + 3u] << 24u);
	}
}
`
