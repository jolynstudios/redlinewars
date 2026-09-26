// Presentation foundation only; the FX consumer and authoritative projectile observer
// must be bound separately. A profile never supplies speed, flight time or trajectory.
import manifest from '../weapon-visual-manifest.json'

export interface ProjectileStyle {
 readonly body:'missile'|'heavy-rocket'|'torpedo'|'bomb'|'depth-charge'|'grenade'
 readonly material:'off-white'|'light-grey'|'olive'
 readonly lengthM:number;readonly radiusM:number;readonly exhaust:boolean
 readonly trail:{readonly widthM:number;readonly lifetimeS:number;readonly colorLinearRGB:readonly number[];readonly opacity:number;readonly turbulence:number}
}
export interface WeaponVisualStyle {
  readonly projectile?: ProjectileStyle
  readonly family: 'bullet' | 'mg' | 'cannon' | 'artillery' | 'rocket' | 'torpedo' | 'electric' | 'flame' | 'melee' | 'heal' | 'utility' | 'unknown'
  readonly tracer: {
    readonly style: 'none' | 'line' | 'streak' | 'exhaust' | 'wake' | 'arc' | 'flame'
    /** Linear RGB material color; do not apply an sRGB-to-linear conversion again. */
    readonly colorLinearRGB: readonly number[]
    /** Artistic world-metre width; not a damage-derived bore measurement. */
    readonly widthM: number
    /** Visual fade/persistence only; never controls projectile motion or hit timing. */
    readonly lifetimeSeconds: number
  }
  readonly muzzle: {
    readonly style: 'none' | 'compact' | 'star' | 'cone' | 'heavy' | 'exhaust' | 'arc' | 'flame'
    readonly scaleM: number
  }
  readonly smoke: 'none' | 'faint' | 'puff' | 'plume' | 'trail' | 'soot'
  readonly impact: 'none' | 'chip' | 'spark' | 'shell' | 'heavy-shell' | 'blast' | 'water' | 'electrical' | 'burn' | 'flak'
}

function freezeStyle(style: WeaponVisualStyle): WeaponVisualStyle {
  if(style.projectile){Object.freeze(style.projectile.trail.colorLinearRGB);Object.freeze(style.projectile.trail);Object.freeze(style.projectile)}
  Object.freeze(style.tracer.colorLinearRGB)
  Object.freeze(style.tracer)
  Object.freeze(style.muzzle)
  return Object.freeze(style)
}

export const UNKNOWN_WEAPON_VISUAL = freezeStyle(manifest.fallback as WeaponVisualStyle)
export const WEAPON_VISUAL_COUNT = manifest.profiles.length
/** Fingerprint of the authoritative RA catalog used to author the name bindings. */
export const RA_WEAPON_VISUAL_SOURCE_SHA256 = manifest.source.sha256
if (manifest.schemaVersion !== 1 || WEAPON_VISUAL_COUNT > 256 || manifest.profileCount !== WEAPON_VISUAL_COUNT)
  throw new Error('Invalid weapon visual manifest version/count')

// At most 256 entries, allocated once at module load. Exact numeric compound key,
// sorted table + binary search: at most 9 comparisons; no strings/arrays/objects per lookup.
const ordered = [...manifest.profiles].sort((a, b) => (a.weaponClass * 65536 + a.caliber) - (b.weaponClass * 65536 + b.caliber))
const keys = new Uint32Array(WEAPON_VISUAL_COUNT)
const styles: WeaponVisualStyle[] = new Array(WEAPON_VISUAL_COUNT)
const raStylesByName = new Map<string, WeaponVisualStyle>()
const raStylesByLowerName = new Map<string, WeaponVisualStyle>()
for (let i = 0; i < ordered.length; i++) {
  const profile = ordered[i]
  if (!Number.isInteger(profile.weaponClass) || profile.weaponClass < 1 || profile.weaponClass > 255 ||
      !Number.isInteger(profile.caliber) || profile.caliber < 0 || profile.caliber > 65535)
    throw new Error('Invalid weapon visual binding')
  keys[i] = profile.weaponClass * 65536 + profile.caliber
  styles[i] = freezeStyle(profile.style as WeaponVisualStyle)
  if (i > 0 && keys[i] === keys[i - 1] && JSON.stringify(styles[i]) !== JSON.stringify(styles[i - 1]))
    throw new Error('Conflicting weapon visual binding')
  if (typeof profile.weapon !== 'string' || profile.weapon.length === 0)
    throw new Error('Invalid RA weapon visual name binding')
  const previous = raStylesByName.get(profile.weapon)
  if (previous && JSON.stringify(previous) !== JSON.stringify(styles[i]))
    throw new Error('Conflicting RA weapon visual name binding')
  if (!previous) {
    raStylesByName.set(profile.weapon, styles[i])
    raStylesByLowerName.set(profile.weapon.toLowerCase(), styles[i])
  }
}

/** Explicit legacy FNV8 + absolute-first-damage ABI only, NOT the active RA host.
 * RA fire IDs are shared string-table indices; passing them here can accidentally
 * match an unrelated weapon. Use lookupRaWeaponVisual with the resolved name instead.
 * Missing/unknown pairs are silent;
 * never guess a style by class alone (8-bit ids can collide), damage, or actor type.
 * Returned values are shared and deeply frozen. No allocation in this lookup.
 */
export function lookupWeaponVisual(weaponClass: number, caliber: number): WeaponVisualStyle {
  if (!Number.isInteger(weaponClass) || weaponClass < 1 || weaponClass > 255 ||
      !Number.isInteger(caliber) || caliber < 0 || caliber > 65535) return UNKNOWN_WEAPON_VISUAL
  const key = weaponClass * 65536 + caliber
  let low = 0
  let high = keys.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const candidate = keys[middle]
    if (candidate === key) return styles[middle]
    if (candidate < key) low = middle + 1
    else high = middle - 1
  }
  return UNKNOWN_WEAPON_VISUAL
}

/** Active assetless RA host: caller resolves the fire event's u16 string-table ID
 * through ctx.actorTypeName(id), then passes that exact weapon name here. Despite
 * its accessor name, the host table also contains weapon names. Never pass an actor
 * archetype, raw ID, FNV ID or a normalized/guessed name. No numeric fallback.
 *
 * RA's fire magnitude is a sum of positive damage warheads (Heal/Repair emit zero),
 * not the legacy profile caliber; it deliberately is not an argument to this API.
 * This binds presentation only: a fire name supplies no target or projectile flight.
 * Shared frozen result, one Map read, no per-lookup allocation or table mutation.
 */
export function lookupRaWeaponVisual(weaponName: string): WeaponVisualStyle {
  if (typeof weaponName !== 'string') return UNKNOWN_WEAPON_VISUAL
  const exact = raStylesByName.get(weaponName)
  if (exact !== undefined) return exact
  // Case-insensitive fallback, added after a live match published a rocket soldier's missile as
  // "dragon" while this catalogue holds "Dragon": `Ruleset.Weapons` is keyed by the LOWERCASED
  // name, so any future path that resolves a weapon through that dictionary rather than through
  // an armament arrives here in the wrong case. An exact match still wins, so nothing that works
  // today changes; the only effect is that a casing mismatch costs one extra Map read instead of
  // silently blanking every visual the weapon has.
  return raStylesByLowerName.get(weaponName.toLowerCase()) ?? UNKNOWN_WEAPON_VISUAL
}
