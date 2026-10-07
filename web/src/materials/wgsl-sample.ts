// STEELSEED — materials/wgsl-sample
// The consumer side of the pack format, as a WGSL snippet.
//
// Every sampling pipeline in the project decodes the same four textures, and the
// octahedral normal in particular has exactly one correct inverse. Shipping that inverse
// from the node that wrote the encoding removes the only way this contract can rot:
// a second, subtly different decode written from the prose in ARCHITECTURE.md §12.1.
//
// Rule 3 keeps other nodes from importing this module. Reach it at runtime instead:
//   const materials = ctx.get<MaterialsApi>('materials')
//   const code = (materials as Materials).sampleWgsl + myShader
// and bind group 0 with `materials.bindGroupFor(set)` against `materials.bindGroupLayout`.

export const SAMPLE_WGSL = /* wgsl */ `
// Group 0 is the shared material group. Every pipeline that samples a SurfaceSet uses
// this exact layout, which is what lets one bind group serve every material pass.
struct SsSetInfo {
	layerCount: u32,
	mipCount: u32,
	pad0: u32,
	pad1: u32,
	/** World metres one tile of this set spans. uv = worldXZ / tileMeters. */
	tileMeters: f32,
	/** Metres represented by the full 0..1 range of orm.a, centred on 0.5. */
	heightRange: f32,
	/** Metres per texel at mip 0 — for choosing a detail level or a POM step count. */
	texelMeters: f32,
	pad2: f32,
}

@group(0) @binding(0) var ssSampler: sampler;
@group(0) @binding(1) var ssAlbedo: texture_2d_array<f32>;
@group(0) @binding(2) var ssNormal: texture_2d_array<f32>;
@group(0) @binding(3) var ssOrm: texture_2d_array<f32>;
@group(0) @binding(4) var ssMask: texture_2d_array<f32>;
@group(0) @binding(5) var<uniform> ssSet: SsSetInfo;

struct SsSurface {
	/** Linear albedo, 0.02..0.9. The albedo view is -srgb, so this is already linear. */
	albedo: vec3<f32>,
	/** Tangent-space normal, +Z out of the surface. */
	normal: vec3<f32>,
	roughness: f32,
	/** Exactly 0.0 or 1.0. Never interpolate this across a material boundary. */
	metalness: f32,
	occlusion: f32,
	/** Height in metres, signed about the mean surface. */
	height: f32,
	/** Player-colour coverage. 1 means this texel is painted panel. */
	mask: f32,
	/** 0 none, 0.25 Foundry warm emitter, 0.75 Lattice cool emitter. */
	emissiveClass: f32,
}

/** Inverse of the encode in materials/wgsl-common.ts. Do not write a second one. */
fn ssOctDecode(e: vec2<f32>) -> vec3<f32> {
	let f = e * 2.0 - vec2<f32>(1.0);
	var n = vec3<f32>(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
	let t = saturate(-n.z);
	let s = vec2<f32>(select(t, -t, n.x >= 0.0), select(t, -t, n.y >= 0.0));
	n = vec3<f32>(n.xy + s, n.z);
	return normalize(n);
}

/**
 * Sample a surface set. 'layer' selects a VARIANT (§12.1); clamp it into 0..layerCount-1.
 *
 * Clamp, never wrap — ARCHITECTURE.md §12.5. Wrapping makes an out-of-range zone silently
 * alias a DIFFERENT valid material, which reads as a texturing bug rather than the data
 * error it is; clamping repeats the last variant, which looks like repetition and points
 * straight at the generator. This previously wrapped here while render clamped, so the
 * same mesh sampled two different textures depending on which node drew it.
 */
fn ssSample(uv: vec2<f32>, layer: u32) -> SsSurface {
	let l = i32(min(layer, max(ssSet.layerCount, 1u) - 1u));
	let albedo = textureSample(ssAlbedo, ssSampler, uv, l);
	let orm = textureSample(ssOrm, ssSampler, uv, l);
	var o: SsSurface;
	o.albedo = albedo.rgb;
	o.normal = ssOctDecode(textureSample(ssNormal, ssSampler, uv, l).rg);
	o.roughness = orm.r;
	// Round rather than pass through: a filtered edge between a painted and a bare texel
	// would otherwise produce a half-metal that is not a physical material.
	o.metalness = step(0.5, orm.g);
	o.occlusion = orm.b;
	o.height = (orm.a - 0.5) * ssSet.heightRange;
	o.mask = textureSample(ssMask, ssSampler, uv, l).r;
	o.emissiveClass = albedo.a;
	return o;
}

/** Apply a player colour as a repaint of the masked panels, not a tint over the lot. */
fn ssApplyPlayerColour(albedo: vec3<f32>, mask: f32, playerColour: vec3<f32>) -> vec3<f32> {
	// The mask replaces the paint layer's chroma while keeping the surface's own
	// luminance detail, so wear, soot and stencils survive the repaint (§9).
	let luma = dot(albedo, vec3<f32>(0.2126, 0.7152, 0.0722));
	let repainted = playerColour * (luma / max(dot(playerColour, vec3<f32>(0.2126, 0.7152, 0.0722)), 1e-3));
	return mix(albedo, clamp(repainted, vec3<f32>(0.02), vec3<f32>(0.90)), mask);
}
`
