// Keep the existing 24-float instance ABI. Positive w is opaque damage (unchanged).
// Negative w packs an 8-bit damage band in even integer steps and alpha in [0,1).
// A pristine fading item remains exactly -opacity, preserving existing callers.
export function packDamageOpacity(damage:number,opacity:number):number {
	if(opacity>=1)return damage
	return -(Math.round(Math.max(0,Math.min(1,damage))*255)*2+opacity)
}

export const INSTANCE_APPEARANCE_WGSL = /* wgsl */ `
fn instanceDamage(w:f32) -> f32 {
	return select(clamp(w,0.0,1.0),floor(-w/2.0)/255.0,w<0.0);
}
fn instanceOpacity(w:f32) -> f32 {
	return select(1.0,-w-2.0*floor(-w/2.0),w<0.0);
}
`
