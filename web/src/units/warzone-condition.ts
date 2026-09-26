/** Pre-existing civilian wear is presentation, independent of health and owner/capture. */
export function warzoneSeed(name: string): number {
 let h=2166136261
 for(let i=0;i<name.length;i++)h=Math.imul(h^name.charCodeAt(i),16777619)
 return h>>>0
}

/** Stable 30% of building placements: 20% light, 10% moderate, 70% intact geometry.
 * World coordinates are authoritative integer WPos; camera, quality and time never enter.
 */
export function warzoneCondition(seed:number,xWPos:number,zWPos:number):0|1|2 {
 let h=seed^Math.imul(xWPos,73856093)^Math.imul(zWPos,19349663)
 h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);h=(h^(h>>>16))>>>0
 const roll=h%100
 return roll<20?1:roll<30?2:0
}

export function warzoneSurfaceDamage(condition:number):number {
 return condition===2?.18:condition===1?.075:0
}
