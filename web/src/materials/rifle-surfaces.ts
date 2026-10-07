// Rifle-only original unique-UV atlas, now the first entry of the role-atlas registry
// (role-surfaces.ts). These names keep its pinned identity for the rifle's existing gates.
import { RIFLE_PACK, ROLE_SURFACE_SIZE } from '../core/role-pack'
import { planRoleSurfaces, validateRoleSurfaceManifest, verifyRoleSurfacePack, type RoleSurfaceManifest } from './role-surfaces'
import type { SourceSurfaces } from './source-surfaces'

export type RifleSurfaceManifest = RoleSurfaceManifest
export const RIFLE_SURFACE_ID = RIFLE_PACK.id
export const RIFLE_SURFACE_SIZE = ROLE_SURFACE_SIZE
export const planRifleSurfaces = planRoleSurfaces

/** Validate shape/ranges BEFORE downloading, decompressing, hashing or GPU allocation. */
export function validateRifleSurfaceManifest(manifest: RifleSurfaceManifest): void {
	validateRoleSurfaceManifest(manifest, RIFLE_PACK.dir)
}

export function verifyRifleSurfacePack(manifest: RifleSurfaceManifest, url: string): Promise<SourceSurfaces> {
	return verifyRoleSurfacePack(manifest, RIFLE_PACK.dir, url)
}
