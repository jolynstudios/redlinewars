// Screen-space ray marching against visible scene depth. Misses retain the forward
// renderer's sky/specular response. No acceleration structure or hardware RT is used.
import palette from '../core/blender-palette.json'
import { MATERIAL_ZONE_LAYER_MASK } from '../geo/zone'

const mode = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('reflections')
/** Defaults when no quality preset is consulted (tools that import the shader alone). */
export const REFLECTION_ENABLED = mode !== '0'
export const REFLECTION_DEBUG = mode === 'debug'
export const REFLECTION_MASK = mode === 'mask'

/** The preset decides; `?reflections=0|1|debug|mask` overrides for review. */
export function reflectionFeatures(presetEnabled: boolean): { enabled: boolean; debug: boolean; mask: boolean } {
	if (mode === '0') return { enabled: false, debug: false, mask: false }
	if (mode === 'debug') return { enabled: true, debug: true, mask: false }
	if (mode === 'mask') return { enabled: true, debug: false, mask: true }
	if (mode === '1') return { enabled: true, debug: false, mask: false }
	return { enabled: presetEnabled, debug: false, mask: false }
}

export const REFLECTION_METADATA_WGSL = /* wgsl */ `
fn reflectionSurface(zone: vec4<u32>, layers: f32) -> vec3<f32> {
	if (zone.w == 2u) { return vec3<f32>(0.18, 0.50, 1.0); }
	// Frozen foliage/meadow sets retain the original 29-layer palette prefix.
	if (u32(layers) != 29u && u32(layers) != ${palette.length}u) { return vec3<f32>(1.0, 0.0, 0.0); }
	let roughness = array<f32, ${palette.length}>(${palette.map(p => p.roughness.toFixed(4)).join(', ')});
	let strength = array<f32, ${palette.length}>(${palette.map((p, i) => (i === 4 ? .65 : p.metalness > .3 ? Math.max(.4, p.metalness) : 0).toFixed(4)).join(', ')});
	// .z is a SURFACE KIND flag consumed by the contact pass: 1 water, 2 foliage (any
	// palette entry named for leaves). Thin leaf geometry must not receive or cast the
	// screen-space contact darkening - the grass scatter saturated it into fern sprays.
	let foliage = array<f32, ${palette.length}>(${palette.map(p => (p.name.toLowerCase().includes('leaf') || p.name.toLowerCase().includes('foliage') ? 2 : 0)).join(', ')});
	let layer = min(zone.x & ${MATERIAL_ZONE_LAYER_MASK}u, min(u32(layers), ${palette.length}u) - 1u);
	return vec3<f32>(roughness[layer], strength[layer], foliage[layer]);
}

fn reflectionNormal(model: mat4x4<f32>, normal: vec3<f32>) -> vec3<f32> {
	let m = mat3x3<f32>(model[0].xyz, model[1].xyz, model[2].xyz);
	let nm = mat3x3<f32>(cross(m[1], m[2]), cross(m[2], m[0]), cross(m[0], m[1]));
	return normalize(nm * normal);
}

fn reflectionOctEncode(normal: vec3<f32>) -> vec2<f32> {
	let n = normal / (abs(normal.x) + abs(normal.y) + abs(normal.z));
	var xy = n.xy;
	if (n.z < 0.0) { xy = (vec2<f32>(1.0) - abs(n.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), n.xy >= vec2<f32>(0.0)); }
	return xy * 0.5 + vec2<f32>(0.5);
}
`

export const REFLECTION_WGSL = /* wgsl */ `
@group(0) @binding(6) var reflectionMetadata: texture_2d<f32>;
@group(0) @binding(7) var reflectionScene: texture_2d<f32>;

fn reflectionOctDecode(e: vec2<f32>) -> vec3<f32> {
	let f = e * 2.0 - 1.0;
	var n = vec3<f32>(f, 1.0 - abs(f.x) - abs(f.y));
	let t = max(-n.z, 0.0);
	n.x += select(t, -t, n.x >= 0.0);
	n.y += select(t, -t, n.y >= 0.0);
	return normalize(n);
}

fn reflectionProject(p: vec3<f32>) -> vec3<f32> {
	let clip = frame.viewProj * vec4<f32>(p, 1.0);
	let uv = vec2<f32>(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
	return vec3<f32>(uv, clip.w);
}

fn screenReflection(px: vec2<i32>, dims: vec2<i32>) -> vec4<f32> {
	let metadata = textureLoad(reflectionMetadata, px, 0);
	let eligibility = max((metadata.a - 0.25) / 0.75, 0.0);
	if (eligibility < 0.03 || metadata.b > 0.65) { return vec4<f32>(0.0); }
	let origin = contactWorld(px, dims);
	let n = reflectionOctDecode(metadata.rg);
	let incident = normalize(origin - frame.cameraPos.xyz);
	let direction = reflect(incident, n);
	let biasOrigin = origin + n * 0.025;
	var previousT = 0.035;
	var distance = previousT;
	for (var i = 0u; i < 16u; i++) {
		distance += 0.12 * pow(1.30, f32(i));
		let point = biasOrigin + direction * distance;
		let projected = reflectionProject(point);
		if (projected.z <= 0.0 || any(projected.xy < vec2<f32>(0.005)) || any(projected.xy > vec2<f32>(0.995))) { break; }
		let q = vec2<i32>(projected.xy * vec2<f32>(dims));
		let depth = textureLoad(contactDepth, q, 0);
		if (depth <= 0.0) { previousT = distance; continue; }
		let scenePosition = contactWorld(q, dims);
		let sceneZ = -(frame.view * vec4<f32>(scenePosition, 1.0)).z;
		let rayZ = -(frame.view * vec4<f32>(point, 1.0)).z;
		let separation = rayZ - sceneZ;
		if (separation >= 0.0) {
			var lo = previousT;
			var hi = distance;
			for (var refine = 0u; refine < 4u; refine++) {
				let mid = (lo + hi) * 0.5;
				let p = biasOrigin + direction * mid;
				let projection = reflectionProject(p);
				let cell = clamp(vec2<i32>(projection.xy * vec2<f32>(dims)), vec2<i32>(0), dims - vec2<i32>(1));
				let world = contactWorld(cell, dims);
				let delta = (frame.view * vec4<f32>(world - p, 0.0)).z;
				if (delta >= 0.0) { hi = mid; } else { lo = mid; }
			}
			let hit = biasOrigin + direction * hi;
			let hitUv = reflectionProject(hit).xy;
			let hitPx = clamp(vec2<i32>(hitUv * vec2<f32>(dims)), vec2<i32>(0), dims - vec2<i32>(1));
			let hitPosition = contactWorld(hitPx, dims);
			let thickness = abs((frame.view * vec4<f32>(hitPosition - hit, 0.0)).z);
			// Alpha < .25 is a currently hidden pixel, even if geometry/depth exists.
			// Stop at it; looking farther would reveal silhouettes through the shroud.
			if (textureLoad(reflectionMetadata, hitPx, 0).a < 0.249) { return vec4<f32>(0.0); }
			if (thickness > 0.14 + hi * 0.018 || length(vec2<f32>(hitPx - px)) < 2.5) { return vec4<f32>(0.0); }
			let edge = min(min(hitUv.x, 1.0 - hitUv.x), min(hitUv.y, 1.0 - hitUv.y));
			let edgeFade = smoothstep(0.0, 0.075, edge);
			let roughFade = 1.0 - smoothstep(0.20, 0.65, metadata.b);
			let fresnel = 0.24 + 0.76 * pow(1.0 - max(dot(-incident, n), 0.0), 5.0);
			let weight = min(0.60, eligibility * roughFade * fresnel * edgeFade * (1.0 - smoothstep(5.0, 18.0, hi)));
			// Current HDR is already shroud-gated. Avoid TAA history here: its fading
			// silhouette from a previous visible tick must not become new information.
			let reflected = textureSampleLevel(reflectionScene, linearSampler, hitUv, 0.0).rgb;
			return vec4<f32>(reflected, weight);
		}
		previousT = distance;
	}
	return vec4<f32>(0.0);
}
`
