// Rifle-only saved geometry, now the first entry of the role-pack registry (role-assets.ts).
// It shares motion by exact rig identity without relabeling it; these wrappers keep the rifle's
// pinned identity (planx-rifle-v1, e1/e1r1) behind the entry points its gates already call.
import { RIFLE_PACK } from '../core/role-pack'
import type { HumanAssets } from './human-assets'
import { validateRolePackManifest, verifyRolePack, type RolePack } from './role-assets'
import type { RifleManifest } from './rifle-profile'

export type RifleAssets = RolePack

export function validateRifleManifest(m: RifleManifest, atlasSource: string, reference: HumanAssets): void {
	validateRolePackManifest(m, RIFLE_PACK.dir, atlasSource, reference)
}

export function verifyRifleAssets(m: RifleManifest, url: string, atlasSource: string, reference: HumanAssets, motionFile: string): Promise<RifleAssets> {
	return verifyRolePack(m, RIFLE_PACK.dir, url, atlasSource, reference, motionFile)
}
