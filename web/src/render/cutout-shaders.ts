// Masked twins retain the opaque shaders' exact clip/skin calculations and depth invariance.
// Only explicitly opted-in draws use these variants; opaque terrain/actors pay no alpha fetch.
import { FORWARD_WGSL, PREPASS_WGSL, SHADOW_WGSL, CUTOUT_UV_WGSL } from './shaders'

function replace(source:string,from:string,to:string,count=1):string {
 if(source.split(from).length-1!==count)throw new Error(`Cutout shader contract changed: ${from}`)
 return source.replaceAll(from,to)
}
const ALPHA_BINDINGS=`
@group(2) @binding(0) var alphaSampler: sampler;
@group(2) @binding(1) var alphaTexture: texture_2d_array<f32>;
`
const layer='min(zone.x & 127u, max(u32(instances[iid].misc.x),1u)-1u)'

let prepass=PREPASS_WGSL+ALPHA_BINDINGS+CUTOUT_UV_WGSL
prepass=replace(prepass,'struct PrepassOut {',`struct PrepassOut {
 @location(5) alphaUv: vec2<f32>,
 @location(6) @interpolate(flat, first) alphaLayer: u32,`)
prepass=replace(prepass,'@location(5) zone: vec4<u32>,','@location(3) alphaUv: vec2<f32>, @location(5) zone: vec4<u32>,',2)
prepass=replace(prepass,'var out: PrepassOut;',`var out: PrepassOut;
 out.alphaLayer=${layer}; out.alphaUv=cutoutUv(alphaUv,out.alphaLayer,iid);`,2)
// First call is static; second belongs to the skinned twin's joint attributes.
prepass=prepass.replace('cutoutUv(alphaUv,out.alphaLayer,iid)', 'cutoutUv(alphaUv,out.alphaLayer,iid,position.z,true)')
prepass=prepass.replace('cutoutUv(alphaUv,out.alphaLayer,iid)', 'cutoutUv(alphaUv,out.alphaLayer,iid,position.z,all(joints == vec4<u32>(0u)))')
prepass=replace(prepass,'fn fsVelocity(vin: PrepassOut) -> PrepassFragment {',`fn fsVelocity(vin: PrepassOut) -> PrepassFragment {
 if(textureSample(alphaTexture,alphaSampler,vin.alphaUv,vin.alphaLayer).a<0.5){discard;}`)
export const PREPASS_CUTOUT_WGSL=prepass

let shadow=SHADOW_WGSL+ALPHA_BINDINGS+CUTOUT_UV_WGSL+`
struct AlphaShadowOut {
 @builtin(position) clip: vec4<f32>,
 @location(0) uv: vec2<f32>,
 @location(1) @interpolate(flat, first) layer: u32,
}
@fragment fn fsCutout(vin:AlphaShadowOut) {
 if(textureSample(alphaTexture,alphaSampler,vin.uv,vin.layer).a<0.5){discard;}
}
`
shadow=replace(shadow,'@location(0) position: vec4<f32>,','@location(0) position: vec4<f32>, @location(3) alphaUv: vec2<f32>,',2)
shadow=replace(shadow,'-> @builtin(position) vec4<f32> {','-> AlphaShadowOut {',2)
shadow=replace(shadow,'return cascade.viewProj * world;',`var out:AlphaShadowOut;
 out.clip=cascade.viewProj * world; out.layer=${layer}; out.uv=cutoutUv(alphaUv,out.layer,iid); return out;`,2)
shadow=shadow.replace('cutoutUv(alphaUv,out.layer,iid)', 'cutoutUv(alphaUv,out.layer,iid,position.z,true)')
shadow=shadow.replace('cutoutUv(alphaUv,out.layer,iid)', 'cutoutUv(alphaUv,out.layer,iid,position.z,all(joints == vec4<u32>(0u)))')
export const SHADOW_CUTOUT_WGSL=shadow

export const FORWARD_CUTOUT_WGSL = replace(FORWARD_WGSL,
 'baseColor = mix(baseColor, max(baseColor * vec3<f32>(0.66, 0.60, 0.48), vec3<f32>(0.02)), detail.b * 0.55);',
 `if(albedoSample.a<0.5){discard;}
baseColor = mix(baseColor, max(baseColor * vec3<f32>(0.66, 0.60, 0.48), vec3<f32>(0.02)), detail.b * 0.55);`)
// Leaf translucency, cutout cards only. The sun BEHIND a foliage card shines through
// it toward the eye: strongest when the view looks into the sun through a canopy,
// scaled by the leaf's own albedo so the glow is green, and gated by the same shadow
// visibility the sun term uses so a shaded canopy stays dark. This is the "canopies
// glow instead of reading as opaque green" term - it exists nowhere else because only
// alpha-card foliage is thin enough to transmit.
export const FORWARD_FOLIAGE_WGSL = replace(FORWARD_CUTOUT_WGSL,
 `	if (vis > 0.0) {
		let sunRadiance = frame.sunColor.rgb * frame.sunColor.a * vis;
		color = color + shadePunctual(baseColor, metallic, rough, n, v, sunL, sunRadiance);
	}`,
`	if (vis > 0.0) {
		let sunRadiance = frame.sunColor.rgb * frame.sunColor.a * vis;
		color = color + shadePunctual(baseColor, metallic, rough, n, v, sunL, sunRadiance);
	}
	// Leaf transmission sits OUTSIDE the shadow gate: the vis term is exactly what a
	// translucent leaf bypasses - a card shadowed by the cards above it still transmits
	// the sun through itself. Gating by vis measured the crown solid black at low sun
	// (541k pixels lit the moment the gate lifted), and leaving the term inside the
	// if-block measured zero changed pixels for the same reason.
	color = color + baseColor * frame.sunColor.rgb * (frame.sunColor.a * 0.55)
		* pow(sat(dot(v, -sunL)), 1.5);`)
