// Exact supplied-input exception. Downloaded art keeps its existing license policy.
// The rules live in core/role-pack now, shared by every role pack and by materials; these
// names keep the rifle's pinned identity for its existing gates and tools.
import { RIFLE_PACK, canonicalRoleValue, roleDigest, roleHashValid, validateRoleInput, type RolePackInput } from '../core/role-pack'
import type { RolePackManifest } from './role-assets'

export const RIFLE_ID = RIFLE_PACK.id
export type RifleInput = RolePackInput
export type RifleManifest = RolePackManifest
export const rifleHashValid = roleHashValid
export const canonicalRifleValue = canonicalRoleValue
export const rifleDigest = roleDigest
export function validateRifleInput(ref: RifleInput): void {
	validateRoleInput(ref, RIFLE_PACK.input)
}
export function rifleSourcePath(path: unknown, level: number): boolean {
	return path === `art/blender/assets/studies/planx-rifle-lod${level}-v1.blend`
}
