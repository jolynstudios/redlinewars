// Landscape macro variation: large world-space patches above the repeating detail maps.
// Original WGSL; technique reference and limits: issues/visual-reference-techniques.md.
// No new textures, vertex displacement, frame clock, simulation data or pipeline variant.
import { Surface } from '../core'

export const TERRAIN_MACRO_WGSL = /* wgsl */ `
fn terrainMacroHash(p: vec2<i32>) -> f32 {
 var h = (bitcast<u32>(p.x) * 0x8da6b343u) ^ (bitcast<u32>(p.y) * 0xd8163841u) ^ 0xcb1ab31fu;
 h = (h ^ (h >> 16u)) * 0x7feb352du;
 h = (h ^ (h >> 15u)) * 0x846ca68bu;
 h = h ^ (h >> 16u);
 return f32(h >> 8u) / 16777215.0;
}
fn terrainMacroNoise(p: vec2<f32>) -> f32 {
 let cell = vec2<i32>(floor(p));
 let t = fract(p);
 // Quintic interpolation has zero first/second derivatives at lattice boundaries.
 let f = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
 let a = mix(terrainMacroHash(cell), terrainMacroHash(cell + vec2<i32>(1, 0)), f.x);
 let b = mix(terrainMacroHash(cell + vec2<i32>(0, 1)), terrainMacroHash(cell + vec2<i32>(1, 1)), f.x);
 return mix(a, b, f.y);
}
fn terrainMacroField(worldXZ: vec2<f32>) -> f32 {
 // Independent orientation/scale defeats both the 1 m gameplay lattice and 4 m tiles.
 let broad = terrainMacroNoise(worldXZ / 53.0 + vec2<f32>(17.3, -8.7));
 let turned = vec2<f32>(worldXZ.x * 0.8 - worldXZ.y * 0.6, worldXZ.x * 0.6 + worldXZ.y * 0.8);
 let detailPatch = terrainMacroNoise(turned / 18.0 + vec2<f32>(-31.2, 9.4));
 return (broad * 0.6 + detailPatch * 0.4) * 2.0 - 1.0;
}
fn terrainMacroStrength(surface: u32) -> f32 {
 switch surface {
  case ${Surface.soil}u: { return 0.34; }
  case ${Surface.grass}u: { return 0.38; }
  case ${Surface.sand}u: { return 0.14; }
  case ${Surface.snow}u: { return 0.06; }
  // Roads, concrete, water and other manufactured/special surfaces stay untouched.
  default: { return 0.0; }
 }
}

// Rotate the already-scaled detail UV off the gameplay lattice so a repeating
// albedo cannot re-draw the 1 m cell grid. Density stays with atlasScale.
// PURE: no frame/textures here — this module compiles standalone in the GPU gate.
fn terrainDetailUv(uv: vec2<f32>) -> vec2<f32> {
 return vec2<f32>(uv.x * 0.9397 - uv.y * 0.3420, uv.x * 0.3420 + uv.y * 0.9397);
}
fn terrainMacroAlbedo(rgb: vec3<f32>, worldXZ: vec2<f32>, strength: f32) -> vec3<f32> {
 if (strength <= 0.0) { return rgb; }
 return clamp(rgb * (1.0 + terrainMacroField(worldXZ) * strength), vec3<f32>(0.02), vec3<f32>(0.90));
}

// How far a material boundary on this surface may wander off the cell lattice.
//
// Zero is not "no effect worth having", it is a REQUIREMENT for these surfaces. A road,
// a concrete pad and the rim of an ore field are straight because something built or
// measured them, and a player reads ore by its outline — fraying those is a legibility
// bug, not a look. Water is zero for a different reason: the water plane is separate
// geometry with its own edge, and a ground boundary that wandered out from under it
// would open a mismatch no amount of blending closes.
fn terrainBlendWarpStrength(surface: u32) -> f32 {
 switch surface {
  case ${Surface.grass}u, ${Surface.soil}u, ${Surface.sand}u, ${Surface.gravel}u,
       ${Surface.rock}u, ${Surface.snow}u, ${Surface.ash}u: { return 1.0; }
  default: { return 0.0; }
 }
}

// x drives the SURFACE transition and y the VARIANT transition. They must not
// agree, or both boundaries bend the same way.
//
// The 9 m octave stays the smallest term. When it leads, whole cells
// checkerboard. The 3.4 m octave is what carries a boundary off a one-metre
// stair. The 0.9 m octave is rotated so its own lattice is not axis-aligned,
// and only frays inside a cell.
fn terrainBlendWarp(worldXZ: vec2<f32>) -> vec2<f32> {
 let coarse = terrainMacroNoise(worldXZ / 9.0 + vec2<f32>(11.7, -4.3)) - 0.5;
 // A few metres: long enough to erase a one-metre stair, short enough that
 // neighbouring cells do not all flip together.
 let midTurned = vec2<f32>(worldXZ.x * 0.6 + worldXZ.y * 0.8, -worldXZ.x * 0.8 + worldXZ.y * 0.6);
 let mid = terrainMacroNoise(midTurned / 3.4 + vec2<f32>(4.2, 19.6)) - 0.5;
 let turned = vec2<f32>(worldXZ.x * 0.8 - worldXZ.y * 0.6, worldXZ.x * 0.6 + worldXZ.y * 0.8);
 let fine = terrainMacroNoise(turned / 0.9 + vec2<f32>(-27.4, 13.9)) - 0.5;
 // Coarse stays the smallest term. When it leads, whole cells checkerboard.
 return vec2<f32>(
  coarse * 0.28 + mid * 0.95 + fine * 0.85,
  coarse * -0.22 + mid * 1.05 + fine * 0.70
 );
}
`
