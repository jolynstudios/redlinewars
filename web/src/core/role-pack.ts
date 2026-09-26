// Identity rules shared by both halves of an anatomical role pack: the skinned LOD bundle that
// `units` draws and the unique-UV atlas that `materials` uploads. Pure helpers over plain
// values -- no GPU, no fetch, no node -- so both may import them (rule 3 forbids materials
// from importing units, which is where these used to live for the rifle alone).
import SUPPLIED from '../../../art/supplied-inputs.lock.json'

/**
 * The one pack that predates the registry. Its identity, its saved study and its veteran actor
 * are pinned exactly as shipped; every other pack is admitted by schema. The remodelled
 * rifleman pack (`web/.forge/e1`, built on the male soldier base) owns e1.
 */
export const RIFLE_PACK = {
	dir: 'planx-rifle', id: 'planx-rifle-v1', role: 'rifle', slots: ['e1r1'],
	study: 'planx-rifle-v1', input: 'military-game-character',
} as const
/**
 * The rifleman experiment family. e1 and e1r1 are both Rifle Infantry carrying the same
 * M1 Carbine: the pinned veteran pack and the remodelled rifleman pack each dress one of
 * them, and when the experiment flags strip those packs both actors fall back to the
 * shared anatomical reference (`units` RIFLE_INFANTRY). Every other actor answers to the
 * role flag alone.
 */
export const RIFLE_FAMILY_ACTORS: readonly string[] = ['e1', 'e1r1']

/**
 * How the `rifleunits`/`roleunits` experiment flags treat a pack dressing `slots`. The
 * flags govern actors: rifle-family actors answer to `rifleunits`, every other actor to
 * `roleunits`, so a pack is off when any actor it dresses is stripped, and demanded
 * (`=1` makes a refusal fatal) when any actor it dresses is explicitly requested.
 */
export function rolePackFlagState(slots: readonly string[], rifleFlag: string | null, roleFlag: string | null): 'off' | 'demanded' | 'on' {
	let family = false, other = false
	for (const slot of slots) {
		if (RIFLE_FAMILY_ACTORS.includes(slot)) family = true
		else other = true
	}
	if ((family && rifleFlag === '0') || (other && roleFlag === '0')) return 'off'
	return (family && rifleFlag === '1') || (other && roleFlag === '1') ? 'demanded' : 'on'
}

 /** `web/.forge/<dir>/` and `web/.forge/<dir>-surfaces/`. */
export const ROLE_PACK_DIR = /^[a-z][a-z0-9.-]{1,39}$/
/** Pack id == material set id == atlas id, e.g. `planx-rifle-v1`, `troop-e3-v1`. */
export const ROLE_PACK_ID = /^[a-z][a-z0-9.-]{1,39}-v[1-9][0-9]{0,2}$/
/** One OpenRA actor name: `e3`, `medi`, `spy.england`. */
export const ROLE_SLOT = /^[a-z][a-z0-9]{0,15}(\.[a-z0-9]{1,15})?$/
/** Every role atlas is baked at this size; `low` uploads from mip 1. */
export const ROLE_SURFACE_SIZE = 1024

export interface RolePackInput {
	readonly id: string
	readonly origin: string
	readonly sha256: string
	readonly bytes: number
	readonly licenseStatus: string
	readonly authorization: string
}

export const roleHashValid = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)

/** Structural JSON, independent of property insertion order. Boot only. */
export function canonicalRoleValue(value: unknown): string {
	if (Array.isArray(value)) return '[' + value.map(canonicalRoleValue).join(',') + ']'
	if (value !== null && typeof value === 'object') {
		const o = value as Record<string, unknown>
		return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonicalRoleValue(o[k])).join(',') + '}'
	}
	return JSON.stringify(value) ?? 'null'
}

export async function roleDigest(bytes: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
	return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('')
}

const INPUT_KEYS = ['id', 'origin', 'sha256', 'bytes', 'licenseStatus', 'authorization']

/** The rights states a lock record may carry; the release gate (sourcelicensegate) ships only `verified`. */
const LICENSE_STATES = ['unverified', 'verified']

/**
 * A pack may only rest on an exact user-supplied input recorded in art/supplied-inputs.lock.json,
 * under the local-project authorization, with downloading refused. `expectedId` pins one record.
 * A pack carries the rights state stamped when it was built (the pinned packs say `unverified`);
 * the lock carries the current one, with its evidence, so a pack's stamp may lag behind the lock.
 */
export function validateRoleInput(ref: RolePackInput, expectedId?: string): void {
	const pin = SUPPLIED.inputs.find(s => s.id === ref?.id)
	if (!pin || !ref || typeof ref !== 'object' || Object.keys(ref).some(k => !INPUT_KEYS.includes(k)) ||
		(expectedId !== undefined && ref.id !== expectedId) || ref.origin !== 'user-supplied' || pin.origin !== 'user-supplied' ||
		ref.sha256 !== pin.sha256 || !roleHashValid(ref.sha256) || ref.bytes !== pin.bytes ||
		!LICENSE_STATES.includes(pin.licenseStatus) || (ref.licenseStatus !== 'unverified' && ref.licenseStatus !== pin.licenseStatus) ||
		ref.authorization !== pin.authorization || ref.authorization !== 'local-project-remodel-and-in-game-use' || pin.downloadAllowed !== false)
		throw new Error('Role pack supplied-input exception does not match its exact local-project record')
}

/**
 * Actor -> pack. The shipped rifle keeps e1r1 and the remodelled rifleman pack claims e1;
 * nobody else may claim either. A claim on an actor that cannot wear a human body, or on an
 * actor two packs both claim, is refused for that actor alone: two bodies for one actor would
 * be a silent substitution whichever one won, so the actor keeps its roster model and the
 * refusal is reported. `units` draws with this and the production palette picks portraits with
 * it, so the two cannot disagree about who wears what.
 */
export function assignRoleSlots<T extends { readonly dir: string; readonly manifest: { readonly slots: readonly string[] } }>(
	loaded: readonly T[], canWear: (actor: string) => boolean): { actors: Map<string, T>; refused: string[] } {
	const claims = new Map<string, T[]>(), refused: string[] = []
	for (const pack of loaded) for (const actor of pack.manifest.slots) {
		if ((RIFLE_PACK.slots as readonly string[]).includes(actor) && pack.dir !== RIFLE_PACK.dir) refused.push(`${pack.dir}: ${actor} belongs to ${RIFLE_PACK.dir}`)
		else if (!canWear(actor)) refused.push(`${pack.dir}: ${actor} is not a rendered human infantry actor`)
		else claims.set(actor, [...claims.get(actor) ?? [], pack])
	}
	const actors = new Map<string, T>()
	for (const [actor, holders] of claims) {
		if (holders.length === 1) actors.set(actor, holders[0])
		else refused.push(`${holders.map(p => p.dir).join(' and ')}: ${actor} is claimed more than once; it keeps its roster model`)
	}
	return { actors, refused }
}

const STUDY = /^art\/blender\/assets\/studies\/([a-z][a-z0-9.-]{1,39})-lod([0-2])-v([1-9][0-9]{0,2})\.blend$/

/**
 * The saved study one LOD was exported from, as `<stem>-v<n>` (`planx-rifle-v1`), or null.
 * Provenance only: nothing fetches the path. Every LOD of a pack names the same study.
 */
export function roleStudyFamily(path: unknown, level: number): string | null {
	const m = typeof path === 'string' ? STUDY.exec(path) : null
	return m && Number(m[2]) === level ? `${m[1]}-v${m[3]}` : null
}
