// Restrained screen-space contact shading. Uses the current visible depth only:
// this is an ambient/contact approximation, not ray tracing or hidden-geometry GI.
const mode = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('contact')
/** Default when no quality preset is consulted (tools that import the shader alone). */
export const CONTACT_ENABLED = mode !== '0'
export const CONTACT_DEBUG = mode === 'debug'

/**
 * The preset decides; the URL overrides for review (`?contact=0`, `?contact=debug`,
 * `?contact=1` forces it on a preset that leaves it off).
 */
export function contactFeatures(presetEnabled: boolean): { enabled: boolean; debug: boolean } {
	if (mode === '0') return { enabled: false, debug: false }
	if (mode === 'debug') return { enabled: true, debug: true }
	if (mode === '1') return { enabled: true, debug: false }
	return { enabled: presetEnabled, debug: false }
}

export const CONTACT_WGSL = /* wgsl */ `
@group(0) @binding(5) var contactDepth: texture_depth_2d;
// Metadata lives at binding 6 as reflectionMetadata — the same rgba8 target the
// reflection pass writes. Declaring a second variable at that slot made the whole
// post shader fail to compile (black swapchain, HUD still live) whenever both
// snippets were included, which is every quality preset.

fn contactWorld(px: vec2<i32>, dims: vec2<i32>) -> vec3<f32> {
	let p = clamp(px, vec2<i32>(0), dims - vec2<i32>(1));
	let depth = textureLoad(contactDepth, p, 0);
	let uv = (vec2<f32>(p) + vec2<f32>(0.5)) / vec2<f32>(dims);
	// Depth was rasterised with the jittered projection, while invViewProj is
	// unjittered for temporal reprojection. Undo that pixel shift before the
	// inverse transform, as the velocity prepass does in unjitterClip().
	let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) -
		frame.jitter.xy * 2.0 * frame.screen.zw;
	let h = frame.invViewProj * vec4<f32>(ndc, depth, 1.0);
	return h.xyz / max(h.w, 1e-7);
}

fn contactVisibility(px: vec2<i32>, dims: vec2<i32>) -> f32 {
	if (textureLoad(contactDepth, px, 0) <= 0.0) { return 1.0; }
	// Surface-kind gate: water (1) and foliage (2) neither receive nor cast the
	// screen-space contact darkening. Thin leaf geometry inside the tap radius
	// saturated the term into fern sprays across the whole grass field.
	if (textureLoad(reflectionMetadata, clamp(px, vec2<i32>(0), dims - vec2<i32>(1)), 0).z > 0.5) { return 1.0; }
	let p = contactWorld(px, dims);
	let l = contactWorld(px - vec2<i32>(1, 0), dims);
	let r = contactWorld(px + vec2<i32>(1, 0), dims);
	let u = contactWorld(px - vec2<i32>(0, 1), dims);
	let d = contactWorld(px + vec2<i32>(0, 1), dims);
	// Choose the short derivative at a silhouette. Crossing an unrelated background
	// plane would tilt the normal and paint an outline around every asset.
	let dx = select(p - l, r - p, dot(r - p, r - p) < dot(p - l, p - l));
	let dy = select(p - u, d - p, dot(d - p, d - p) < dot(p - u, p - u));
	let crossN = cross(dx, dy);
	if (dot(crossN, crossN) < 1e-14) { return 1.0; }
	var n = normalize(crossN);
	n *= select(-1.0, 1.0, dot(n, frame.cameraPos.xyz - p) >= 0.0);
	let viewDepth = abs((frame.view * vec4<f32>(p, 1.0)).z);
	let radiusM = 0.55;
	let projectedRadius = radiusM * abs(frame.proj[1][1]) * f32(dims.y) * 0.5 / max(viewDepth, 0.01);
	let radiusPx = min(projectedRadius, 22.0);
	if (radiusPx < 1.0) { return 1.0; }
	// Four axis taps. Eight inverse-projected samples per retina pixel missed 120 Hz.
	// The weight below is doubled so the darkening cap matches the eight-tap term.
	let offsets = array<vec2<f32>, 4>(
		vec2<f32>(1.0, 0.0),
		vec2<f32>(0.0, 1.0),
		vec2<f32>(-1.0, 0.0),
		vec2<f32>(0.0, -1.0),
	);
	var occlusion = 0.0;
	for (var i = 0u; i < 4u; i++) {
		let q = px + vec2<i32>(round(offsets[i] * radiusPx));
		if (any(q < vec2<i32>(1)) || any(q >= dims - vec2<i32>(1))) { continue; }
		if (textureLoad(contactDepth, q, 0) <= 0.0) { continue; }
		if (textureLoad(reflectionMetadata, q, 0).z > 0.5) { continue; }
		let delta = contactWorld(q, dims) - p;
		let distance = length(delta);
		if (distance < 0.008 || distance > radiusM) { continue; }
		let horizon = max(dot(n, delta) / distance - 0.075, 0.0);
		let rangeWeight = 1.0 - smoothstep(radiusM * 0.35, radiusM, distance);
		occlusion += horizon * rangeWeight;
	}
	// Fade sub-pixel detail at strategy zoom and cap at 22% so material values,
	// player colours, direct lighting and silhouettes remain readable.
	return 1.0 - min(0.22, occlusion * 0.32) * smoothstep(1.0, 3.0, projectedRadius);
}
`

/** Quality variants are compiled once; the eight-tap path restores the full contact kernel. */
export function contactWgsl(taps: 4 | 8): string {
	if (taps === 4) return CONTACT_WGSL
	return CONTACT_WGSL
		.replace('array<vec2<f32>, 4>(', 'array<vec2<f32>, 8>(')
		.replace(`vec2<f32>(1.0, 0.0),
		vec2<f32>(0.0, 1.0),
		vec2<f32>(-1.0, 0.0),
		vec2<f32>(0.0, -1.0),`, `vec2<f32>(1.0, 0.0), vec2<f32>(0.35, 0.35),
		vec2<f32>(0.0, 1.0), vec2<f32>(-0.35, 0.35),
		vec2<f32>(-1.0, 0.0), vec2<f32>(-0.35, -0.35),
		vec2<f32>(0.0, -1.0), vec2<f32>(0.35, -0.35),`)
		.replace('for (var i = 0u; i < 4u; i++) {', 'for (var i = 0u; i < 8u; i++) {')
		.replace('occlusion * 0.32', 'occlusion * 0.16')
}
