// STEELSEED — terrain/shaders
//
// DEAD DRAW PATH — DO NOT DEBUG THE LIVE BATTLEFIELD HERE.
//
// Only Terrain.encode() can bind these shaders, and there is no production caller. Live ground
// and water are DrawItems submitted through render.prepass and render.forward(.blend). This file
// is retained with terrain/gpu.ts solely because encode() remains a public compatibility surface.
//
// WGSL for the two passes terrain owns: the triplanar ground/cliff pass and the
// depth-tinted water pass.
//
// The bind groups these declare are terrain's OWN. §12.1 pins the four SurfaceSet
// textures as `GPUTexture` values, so terrain builds a bind group straight from them
// rather than binding through `MaterialsApi.bindGroupLayout` — whose internal binding
// NUMBERS §12 does not pin. Writing a shader against binding numbers nobody wrote down
// is precisely the guess §12's preamble forbids ("nothing here may be guessed at"), and
// it would fail validation at pipeline creation rather than anywhere useful.
//
// Output is linear HDR radiance with no tonemap: `render` owns post (§12.2, "depth
// prepass -> froxel light cull -> forward+ -> post"), and a node that tonemaps on its
// own double-tonemaps the frame.

/**
 * Frame uniform, 160 bytes. Field order matches the Float32Array the node fills, and
 * every vec4 is 16-byte aligned because WGSL's uniform address space requires it — a
 * vec3 here would silently pad and shift everything after it.
 */
const FRAME_STRUCT = /* wgsl */ `
struct Frame {
	viewProj    : mat4x4<f32>,
	// xyz camera position, w = elapsed seconds
	camera      : vec4<f32>,
	// xyz direction TOWARD the sun, w = sun intensity
	sun         : vec4<f32>,
	// rgb sun colour, a = ambient level
	sunColor    : vec4<f32>,
	// rgb absorption per metre of water, a = scatter strength
	absorption  : vec4<f32>,
	// xy wind direction on the ground plane, z = wind speed 0..1, w = weather severity 0..1
	wind        : vec4<f32>,
	// rgb zenith radiance, a unused
	sky         : vec4<f32>,
	// rgb horizon radiance, a aerial extinction per metre
	horizon     : vec4<f32>,
	// rgb colour distant geometry tends towards, a unused
	aerial      : vec4<f32>,
};

@group(0) @binding(0) var<uniform> frame : Frame;

struct VsIn {
	@location(0) position : vec3<f32>,
	@location(1) normal   : vec3<f32>,
	@location(2) tangent  : vec4<f32>,
	@location(3) uv0      : vec2<f32>,
	@location(4) uv1      : vec2<f32>,
	@location(5) zone     : vec4<u32>,
};

struct VsOut {
	@builtin(position) clip : vec4<f32>,
	@location(0) world      : vec3<f32>,
	@location(1) normal     : vec3<f32>,
	@location(2) tangent    : vec4<f32>,
	@location(3) uv         : vec4<f32>,
	// flat, first — not bare flat, which means either and lets the implementation pick any
	// vertex of the primitive. See the longer note in render/shaders.ts.
	@location(4) @interpolate(flat, first) zone : vec4<u32>,
};

@vertex
fn vsMain(v : VsIn) -> VsOut {
	var o : VsOut;
	// Chunk vertices are already in world metres — the chunk transform is identity, which
	// is why no model matrix is bound and no per-chunk uniform exists.
	o.clip = frame.viewProj * vec4<f32>(v.position, 1.0);
	o.world = v.position;
	o.normal = v.normal;
	o.tangent = v.tangent;
	o.uv = vec4<f32>(v.uv0, v.uv1);
	o.zone = v.zone;
	return o;
}
`

const SHARED_FN = /* wgsl */ `
/**
 * Octahedral decode. §12.1 stores normals as rg8unorm — two channels, not three — so the
 * third has to be reconstructed rather than read.
 */
fn octDecode(e : vec2<f32>) -> vec3<f32> {
	let f = e * 2.0 - 1.0;
	var n = vec3<f32>(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
	let t = max(-n.z, 0.0);
	n.x = n.x + select(t, -t, n.x >= 0.0);
	n.y = n.y + select(t, -t, n.y >= 0.0);
	return normalize(n);
}

/**
 * Triplanar projection weights, sharpened so a near-flat cell resolves to a single
 * projection. Without the bias every horizontal metre of ground pays for three texture
 * fetches to blend in two contributions worth 0.1% each.
 */
fn triWeights(n : vec3<f32>) -> vec3<f32> {
	var w = max(abs(n) - vec3<f32>(0.38), vec3<f32>(0.0));
	w = w * w;
	let s = w.x + w.y + w.z;
	if (s < 1e-5) {
		return vec3<f32>(0.0, 1.0, 0.0);
	}
	return w / s;
}

/** GGX specular, single term. Enough for sun glint on wet rock; render owns the rest. */
fn specularGGX(n : vec3<f32>, v : vec3<f32>, l : vec3<f32>, roughness : f32) -> f32 {
	let h = normalize(v + l);
	let a = max(roughness * roughness, 1e-3);
	let a2 = a * a;
	let ndh = max(dot(n, h), 0.0);
	let ndv = max(dot(n, v), 1e-4);
	let ndl = max(dot(n, l), 0.0);
	let d = ndh * ndh * (a2 - 1.0) + 1.0;
	let dist = a2 / max(3.14159265 * d * d, 1e-6);
	let k = a * 0.5;
	let gv = ndv / (ndv * (1.0 - k) + k);
	let gl = ndl / (ndl * (1.0 - k) + k);
	return dist * gv * gl;
}

fn fresnelSchlick(f0 : f32, cosTheta : f32) -> f32 {
	let m = clamp(1.0 - cosTheta, 0.0, 1.0);
	let m2 = m * m;
	return f0 + (1.0 - f0) * m2 * m2 * m;
}

/**
 * Sky term used for ambient and for the water reflection. No cubemap on purpose: the sky
 * node is not a terrain dependency, and reaching a subsystem terrain
 * did not declare would rely on init order it does not control (§3).
 *
 * The horizon is now the value render publishes rather than a blend of the zenith and the
 * sun colour invented here. The old expression could not go warm at dawn without also
 * dragging the zenith warm, so water reflected a sunset that the sky above it never had.
 */
fn skyRadiance(dir : vec3<f32>) -> vec3<f32> {
	let up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
	return mix(frame.horizon.rgb, frame.sky.rgb, up * up);
}

/**
 * Aerial perspective. Terrain owns nearly every distant pixel on screen, so this is where
 * the depth cue is actually earned — a ridge at the far edge of the map should not be as
 * saturated as the ground under the cursor.
 */
fn applyAerial(color : vec3<f32>, worldPos : vec3<f32>) -> vec3<f32> {
	let d = length(frame.camera.xyz - worldPos);
	return mix(color, frame.aerial.rgb, 1.0 - exp(-frame.horizon.a * d));
}
`

/**
 * Ground and cliff. One draw per (chunk, §8 surface), so `surfaceTex` is the array
 * texture of exactly the surface the sim tagged those cells with, and `zone.x` picks the
 * variant layer inside it.
 */
export const TERRAIN_WGSL = /* wgsl */ `
${FRAME_STRUCT}

@group(1) @binding(0) var surfSampler : sampler;
@group(1) @binding(1) var albedoTex   : texture_2d_array<f32>;
@group(1) @binding(2) var normalTex   : texture_2d_array<f32>;
@group(1) @binding(3) var ormTex      : texture_2d_array<f32>;

${SHARED_FN}

/** Metres of world per texture repeat, matching the planar uv0 the chunk builder bakes. */
const TRI_SCALE : f32 = 0.25;

/** One material's triplanar result. WGSL has no multiple return, so this is the tuple. */
struct Surf {
	albedo : vec4<f32>,
	orm    : vec4<f32>,
	normal : vec3<f32>,
};

/**
 * Triplanar-sample ONE atlas layer. Nine fetches; called twice per ground fragment.
 *
 * Deliberately not branched on the blend weight. WGSL requires implicit-derivative
 * sampling to sit in uniform control flow, and the weight is an interpolated varying, so
 * a skip-the-second-material branch would be non-uniform and illegal. Sampling both
 * unconditionally is the correct-by-construction version; if this ever shows up in a
 * profile the fix is textureSampleGrad with explicit derivatives, not a branch.
 */
fn sampleLayer(layer : u32, w : vec3<f32>, cx : vec2<f32>, cy : vec2<f32>, cz : vec2<f32>, geoN : vec3<f32>) -> Surf {
	var s : Surf;
	let aX = textureSample(albedoTex, surfSampler, cx, layer);
	let aY = textureSample(albedoTex, surfSampler, cy, layer);
	let aZ = textureSample(albedoTex, surfSampler, cz, layer);
	s.albedo = aX * w.x + aY * w.y + aZ * w.z;

	let oX = textureSample(ormTex, surfSampler, cx, layer);
	let oY = textureSample(ormTex, surfSampler, cy, layer);
	let oZ = textureSample(ormTex, surfSampler, cz, layer);
	s.orm = oX * w.x + oY * w.y + oZ * w.z;

	let nX = octDecode(textureSample(normalTex, surfSampler, cx, layer).rg);
	let nY = octDecode(textureSample(normalTex, surfSampler, cy, layer).rg);
	let nZ = octDecode(textureSample(normalTex, surfSampler, cz, layer).rg);
	// Whiteout blend: adds the tangent-space perturbation into the geometric normal per
	// axis, so a detail normal never overrides the silhouette the heightfield defines.
	let bX = vec3<f32>(nX.xy + geoN.zy, abs(nX.z) * geoN.x);
	let bY = vec3<f32>(nY.xy + geoN.xz, abs(nY.z) * geoN.y);
	let bZ = vec3<f32>(nZ.xy + geoN.xy, abs(nZ.z) * geoN.z);
	s.normal = bX.zyx * w.x + bY.xzy * w.y + bZ.xyz * w.z;
	return s;
}
/** One texture repeat in world metres — the reciprocal of TRI_SCALE, spelled out. */
const PERIOD_M : f32 = 4.0;

/**
 * Deterministic per-cell jitter in [0,1)^2. Integer hash, no trig: the bake must stay a
 * pure function of the grid (§5.2), one seed giving one rock slice everywhere forever.
 * Two decorrelated words from one state.
 */
fn cellJitter(cell : vec2<i32>) -> vec2<f32> {
	var h = bitcast<u32>(cell.x) * 374761393u + bitcast<u32>(cell.y) * 668265263u + 2246822519u;
	h = (h ^ (h >> 16u)) * 1274126177u;
	h = h ^ (h >> 16u);
	let h2 = (h ^ (h >> 7u)) * 2654435761u;
	return vec2<f32>(f32(h & 65535u), f32(h2 & 65535u)) / 65535.0;
}

@fragment
fn fsMain(i : VsOut) -> @location(0) vec4<f32> {
	let geoN = normalize(i.normal);
	let w = triWeights(geoN);

	// Cliff faces (VertexKind.cliff) hash-jitter the projection by whole texture periods.
	// The two-variant blend this payload once planned is unavailable: chunks.ts repurposed
	// uv1.x on cliff walls as the taper normal-map fade, and a wall names the SAME atlas
	// layer in all three zone slots — there is no second variant to blend and no free
	// weight to blend it with. So this is the same cure chunks.ts bakes into the live
	// path's wall uvs (its wallHash): adjacent walls sample offset slices, and the rigid
	// 4 m world repeat stops reprinting the same rock slice. The cell is read from the
	// face's in-plane coordinates, which are constant across one wall (a wall is one grid
	// edge long), so the jitter is ONE value per face: no seam can open inside a face —
	// only the intended slice change BETWEEN faces. Top faces keep zero jitter, where a
	// per-cell offset would tear the ground at every cell border.
	let cell = cellJitter(vec2<i32>(floor(i.world.xz)));
	let jitter = select(vec2<f32>(0.0), cell, i.zone.w == 1u);
	let p = (i.world + vec3<f32>(jitter.x * PERIOD_M, 0.0, jitter.y * PERIOD_M)) * TRI_SCALE;

	// Each projection is fed the two axes it does not project along, and the sign flip
	// keeps the two sides of a wall from mirroring into each other.
	let cx = vec2<f32>(p.z * sign(geoN.x), -p.y);
	let cy = vec2<f32>(p.x, p.z * sign(geoN.y));
	let cz = vec2<f32>(-p.x * sign(geoN.z), -p.y);

	// One layer: materialZone.x is the array-texture VARIANT within the single surface set
	// this draw binds. The §12.3b two-surface blend is not wired here — see the note in
	// chunks.ts. Sampling a pair from this payload would read the variant and the surface
	// index as two atlas layers, which is meaningless.
	let s = sampleLayer(i.zone.x, w, cx, cy, cz, geoN);
	let albedo = s.albedo;
	let orm = s.orm;
	let n = normalize(s.normal);

	let roughness = clamp(orm.r, 0.04, 1.0);
	let metalness = orm.g;
	let ao = orm.b;

	let viewVec = frame.camera.xyz - i.world;
	let v = normalize(viewVec);
	let l = normalize(frame.sun.xyz);
	let ndl = max(dot(n, l), 0.0);

	let diffuseColor = albedo.rgb * (1.0 - metalness);
	let f0 = mix(0.04, 1.0, metalness);
	let spec = specularGGX(n, v, l, roughness) * fresnelSchlick(f0, max(dot(v, normalize(v + l)), 0.0));

	var lit = diffuseColor * (ndl * frame.sun.w) * frame.sunColor.rgb;
	lit = lit + vec3<f32>(spec * frame.sun.w) * frame.sunColor.rgb * mix(vec3<f32>(1.0), albedo.rgb, metalness);
	// Hemispheric ambient: sky above, bounce off the ground below. Occlusion multiplies
	// only the ambient — multiplying direct light by AO is the classic way to make a lit
	// slope read as dirty rather than as lit.
	let ambient = mix(frame.sky.rgb * 0.35, skyRadiance(n), 0.5 + 0.5 * n.y);
	lit = lit + diffuseColor * ambient * frame.sunColor.a * ao;

	return vec4<f32>(applyAerial(lit, i.world), 1.0);
}
`

/**
 * Water. The plane never moves: its height is the sim's, and displacing it would put the
 * shoreline somewhere the cell grid does not say it is — the exact failure §4.3's overlay
 * proof exists to catch. All the motion is in the normal.
 */
export const WATER_WGSL = /* wgsl */ `
${FRAME_STRUCT}

@group(1) @binding(0) var surfSampler : sampler;
@group(1) @binding(1) var albedoTex   : texture_2d_array<f32>;
@group(1) @binding(2) var normalTex   : texture_2d_array<f32>;
@group(1) @binding(3) var ormTex      : texture_2d_array<f32>;
// The render-side SSR trio at render's own slot numbers (the contact pass owns 5; the
// reflection pass 6 and 7), so a caller can bind the views it already builds for render's
// post chain. gpu.ts binds 1x1 fallbacks until rebindSsr supplies real targets; a fallback
// presents no depth and no visible metadata, which routes every ray to the skyRadiance
// miss fallback below — the exact pre-SSR water.
@group(1) @binding(5) var contactDepth       : texture_depth_2d;
@group(1) @binding(6) var reflectionMetadata : texture_2d<f32>;
@group(1) @binding(7) var reflectionScene    : texture_2d<f32>;

${SHARED_FN}

/** Two ripple octaves, crossed so the interference never reads as a repeating grid. */
fn rippleNormal(p : vec2<f32>, t : f32, windDir : vec2<f32>, windSpeed : f32, severity : f32) -> vec3<f32> {
	let drift = windDir * (t * (0.35 + windSpeed * 0.9));
	let q1 = (p + drift) * 1.7;
	let q2 = (p * 0.63 - drift * 0.7) * 3.1 + vec2<f32>(2.3, 5.1);
	// Rain and dust roughen the surface: chop scales with weather severity (§4.2), which
	// is why the water reads calm on a clear map and broken on a storm.
	let chop = 0.35 + windSpeed * 0.65 + severity * 0.9;
	let a1 = 0.055 * chop;
	let a2 = 0.030 * chop;
	// Analytic gradient of two sine sheets: no texture fetch, and it is exactly
	// reproducible from the elapsed time, which a noise texture lookup would not be.
	let dx = a1 * cos(q1.x + q1.y * 0.7) * 1.7 + a2 * cos(q2.x * 0.8 - q2.y) * 2.5;
	let dz = a1 * cos(q1.x + q1.y * 0.7) * 1.19 - a2 * cos(q2.x * 0.8 - q2.y) * 3.1;
	return normalize(vec3<f32>(-dx, 1.0, -dz));
}
/**
 * Screen-space reflection for one water fragment against the depth and scene colour the
 * caller binds, mirroring render/reflection.ts's march. Terrain's Frame carries viewProj
 * but not its inverse, so the compare happens in REVERSE-Z DEPTH VALUES rather than
 * reconstructed world positions: a stored depth texel IS clip.z/clip.w under the very
 * projection this shader already uses, so "the ray point is in front of the scene
 * surface" is one scalar compare and there is no unprojection to get wrong.
 *
 * Returns colour + weight in a. Weight 0 is a miss, and the caller keeps
 * skyRadiance(reflect(-v, n)) for exactly that case.
 */
fn waterReflection(origin : vec3<f32>, n : vec3<f32>, screenPx : vec2<i32>) -> vec4<f32> {
	let dims = vec2<i32>(textureDimensions(contactDepth));
	let px = clamp(screenPx, vec2<i32>(0), dims - vec2<i32>(1));
	let metadata = textureLoad(reflectionMetadata, px, 0);
	let eligibility = max((metadata.a - 0.25) / 0.75, 0.0);
	if (eligibility < 0.03 || metadata.b > 0.65) { return vec4<f32>(0.0); }
	let incident = normalize(origin - frame.camera.xyz);
	let direction = reflect(incident, n);
	let biasOrigin = origin + n * 0.025;
	var previousT = 0.035;
	var distance = previousT;
	for (var i = 0u; i < 16u; i++) {
		distance += 0.12 * pow(1.30, f32(i));
		let point = biasOrigin + direction * distance;
		let projected = frame.viewProj * vec4<f32>(point, 1.0);
		if (projected.w <= 0.0) { break; }
		let ndc = projected.xyz / projected.w;
		let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
		if (any(uv < vec2<f32>(0.005)) || any(uv > vec2<f32>(0.995))) { break; }
		let q = clamp(vec2<i32>(uv * vec2<f32>(dims)), vec2<i32>(0), dims - vec2<i32>(1));
		let sceneDepth = textureLoad(contactDepth, q, 0);
		// A cleared (0.0) texel is the infinite far plane: sky, and never a hit. Under
		// reverse-Z the ray is at or in front of the surface when its depth is greater.
		if (sceneDepth <= 0.0 || ndc.z <= sceneDepth + 1e-6) {
			previousT = distance;
			continue;
		}
		var lo = previousT;
		var hi = distance;
		var hitUv = uv;
		for (var refine = 0u; refine < 4u; refine++) {
			let mid = (lo + hi) * 0.5;
			let p = biasOrigin + direction * mid;
			let pr = frame.viewProj * vec4<f32>(p, 1.0);
			let pn = pr.xyz / pr.w;
			let pu = vec2<f32>(pn.x * 0.5 + 0.5, 0.5 - pn.y * 0.5);
			let cell = clamp(vec2<i32>(pu * vec2<f32>(dims)), vec2<i32>(0), dims - vec2<i32>(1));
			let cellDepth = textureLoad(contactDepth, cell, 0);
			if (cellDepth > 0.0 && pn.z > cellDepth) { hi = mid; hitUv = pu; } else { lo = mid; }
		}
		let hitPx = clamp(vec2<i32>(hitUv * vec2<f32>(dims)), vec2<i32>(0), dims - vec2<i32>(1));
		// Alpha < .25 is a currently hidden pixel even where depth exists — the shroud
		// must not leak silhouettes into the reflection, the same rule the render side
		// enforces on its own march.
		if (textureLoad(reflectionMetadata, hitPx, 0).a < 0.249) { return vec4<f32>(0.0); }
		let hit = biasOrigin + direction * hi;
		let hp = frame.viewProj * vec4<f32>(hit, 1.0);
		let hitDepth = textureLoad(contactDepth, hitPx, 0);
		// Thickness: the depth gap at the hit translated back to metres by the ray's own
		// depth slope, so the metre threshold keeps its render-side meaning. A hit far
		// BEHIND the surface is a transparent miss, not a reflection.
		let dt = 0.01;
		let beyond = frame.viewProj * vec4<f32>(hit + direction * dt, 1.0);
		let slope = max(abs(beyond.z / beyond.w - hp.z / hp.w) / dt, 1e-6);
		let thickness = abs(hp.z / hp.w - hitDepth) / slope;
		if (thickness > 0.14 + hi * 0.018 || length(vec2<f32>(hitPx - px)) < 2.5) { return vec4<f32>(0.0); }
		let edge = min(min(hitUv.x, 1.0 - hitUv.x), min(hitUv.y, 1.0 - hitUv.y));
		let edgeFade = smoothstep(0.0, 0.075, edge);
		let roughFade = 1.0 - smoothstep(0.20, 0.65, metadata.b);
		let fresnel = 0.24 + 0.76 * pow(1.0 - max(dot(-incident, n), 0.0), 5.0);
		let weight = min(0.60, eligibility * roughFade * fresnel * edgeFade * (1.0 - smoothstep(5.0, 18.0, hi)));
		let reflected = textureSampleLevel(reflectionScene, surfSampler, hitUv, 0.0).rgb;
		return vec4<f32>(reflected, weight);
	}
	return vec4<f32>(0.0);
}

@fragment
fn fsMain(i : VsOut) -> @location(0) vec4<f32> {
	let layer = i.zone.x;
	let t = frame.camera.w;
	let depth = max(i.uv.w, 0.0);

	var n = rippleNormal(
		i.world.xz,
		t,
		normalize(frame.wind.xy + vec2<f32>(1e-4, 0.0)),
		clamp(frame.wind.z, 0.0, 1.0),
		clamp(frame.wind.w, 0.0, 1.0),
	);
	// The surface set contributes fine chop on top of the two analytic octaves.
	let detail = octDecode(textureSample(normalTex, surfSampler, i.uv.xy + frame.wind.xy * t * 0.05, layer).rg);
	n = normalize(vec3<f32>(n.x + detail.x * 0.35, n.y, n.z + detail.y * 0.35));

	let viewVec = frame.camera.xyz - i.world;
	let v = normalize(viewVec);
	let l = normalize(frame.sun.xyz);

	// Beer-Lambert through the water column: the path is down to the bed and back, hence
	// the doubling. This is the whole reason the chunk builder carries a per-vertex depth.
	let transmit = exp(-frame.absorption.rgb * depth * 2.0);
	let tint = textureSample(albedoTex, surfSampler, i.uv.xy, layer).rgb;
	// Scattered light from the body itself: what the water adds where the bed is lost.
	let scatter = tint * frame.sunColor.rgb * frame.sun.w * frame.absorption.a * (1.0 - transmit);

	let fres = fresnelSchlick(0.02, max(dot(n, v), 0.0));
	// SSR over the analytic sky term: a ray hit takes the scene colour it lands on; a miss
	// (weight 0 — including the fallback bindings, which never present depth or visible
	// metadata) keeps skyRadiance exactly as before the feature existed.
	let ssr = waterReflection(i.world, n, vec2<i32>(i.clip.xy));
	let refl = mix(skyRadiance(reflect(-v, n)), ssr.rgb, ssr.a) * fres;
	let glint = specularGGX(n, v, l, 0.06) * frame.sun.w * fres;

	// Alpha is the bed's transmittance, averaged to a scalar because the blend's
	// destination factor is scalar. The per-channel part of the absorption stays in
	// the scatter term, which is where it is actually visible as colour.
	let mean = (transmit.r + transmit.g + transmit.b) * (1.0 / 3.0);
	let alpha = clamp(1.0 - mean + fres, 0.0, 1.0);

	let color = scatter + refl + vec3<f32>(glint) * frame.sunColor.rgb;
	return vec4<f32>(applyAerial(color, i.world), alpha);
}
`
