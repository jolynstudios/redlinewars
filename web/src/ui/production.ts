import { ProductionItemFlag, ProductionQueueFlag, type ProductionItemView, type ProductionQueueView } from '../core'
import { assignRoleSlots, rolePackFlagState } from '../core/role-pack'

/** OpenRA ProductionPaletteWidget semantics. The host owns cost, time and completion. */
export function productionAction(
	queue: ProductionQueueView,
	item: ProductionItemView,
	button: number,
	shift: boolean,
	ctrl: boolean,
): { orderString: string; extraData: number; queued?: boolean } | null {
	const current = (item.flags & ProductionItemFlag.current) !== 0
	const paused = current && (queue.flags & ProductionQueueFlag.paused) !== 0
	if (button === 0) {
		if ((item.flags & ProductionItemFlag.ready) !== 0 && (item.flags & ProductionItemFlag.building) !== 0) return null
		if (paused) return { orderString: 'PauseProduction', extraData: 0 }
		if ((queue.flags & ProductionQueueFlag.enabled) === 0 || (item.flags & ProductionItemFlag.buildable) === 0) return null
		return { orderString: 'StartProduction', extraData: shift ? 5 : 1, queued: !ctrl }
	}
	if (item.queued === 0) return null
	// Middle click cancels directly. Right click pauses the active, paid-for item;
	// right click again cancels. A waiting or completed item can be cancelled at once.
	if (button === 2 && current && !paused && queue.progressPermille > 0 && (item.flags & ProductionItemFlag.ready) === 0)
		return { orderString: 'PauseProduction', extraData: 1 }
	return { orderString: 'CancelProduction', extraData: ctrl ? queue.itemsQueued : shift ? 5 : 1 }
}

// Node harnesses bundling this module have no Vite glob; degrade to no portraits.
let portraits: Record<string, string> = {}
try {
	portraits = import.meta.glob<string>('../../.forge/blender/previews/*.png', { eager: true, query: '?url', import: 'default' })
} catch { /* Node harness: Vite glob unavailable */ }
/**
 * An anatomical role pack ships its own portrait beside its mesh, `web/.forge/<pack>/portrait.png`,
 * with a `portrait.json` naming the actors who wear that body. tools/roleportraits.mjs writes both
 * at build time, and only for a pack that passes the offline role-pack validator, so a pack the
 * game would refuse never advertises its body here. The sidecar exists so this chunk never
 * imports the pack manifests themselves: they belong to units, and sharing them across two
 * subsystem chunks is how a chunk cycle starts (see vite.config.ts).
 */
let rolePortraitFiles: Record<string, string> = {}
let rolePortraitSlots: Record<string, { readonly schema?: unknown; readonly slots?: unknown }> = {}
try {
	rolePortraitFiles = import.meta.glob<string>('../../.forge/*/portrait.png', { eager: true, query: '?url', import: 'default' })
	rolePortraitSlots = import.meta.glob<{ readonly schema?: unknown; readonly slots?: unknown }>('../../.forge/*/portrait.json', { eager: true, import: 'default' })
} catch { /* Node harness: Vite glob unavailable */ }
let rolePortraits: ReadonlyMap<string, string> | null = null

/**
 * Actor -> role-pack portrait, built once. The units flags apply here too: `humanunits=0` drops
 * every pack, `rifleunits=0` the rifle, `roleunits=0` every other role, so the palette never
 * shows a body the battlefield does not draw. Same claim rule as units: an actor two packs
 * claim keeps its roster model there, so it keeps its roster portrait here.
 */
function rolePortraitTable(): ReadonlyMap<string, string> {
	if (rolePortraits) return rolePortraits
	const query = new URLSearchParams(globalThis.location?.search ?? '')
	const shipped: { dir: string; url: string; manifest: { slots: readonly string[] } }[] = []
	if (query.get('humanunits') !== '0') for (const [key, url] of Object.entries(rolePortraitFiles)) {
		const dir = /\/\.forge\/([^/]+)\/portrait\.png$/.exec(key)?.[1]
		const sidecar = dir ? rolePortraitSlots[`../../.forge/${dir}/portrait.json`] : undefined
		if (!dir || dir === 'riki-meshy' || sidecar?.schema !== 1 || !Array.isArray(sidecar.slots) || !sidecar.slots.every(slot => typeof slot === 'string') ||
			rolePackFlagState(sidecar.slots, query.get('rifleunits'), query.get('roleunits')) === 'off') continue
		shipped.push({ dir, url, manifest: { slots: sidecar.slots } })
	}
	const table = new Map<string, string>()
	for (const [actor, pack] of assignRoleSlots(shipped, () => true).actors) table.set(actor, pack.url)
	return (rolePortraits = table)
}

/** A portrait is rendered from the same editable Blender scene as the game actor. */
export function productionPortrait(actorName: string, loadedRole?: string): string | null {
	// The repaired native rig is an explicit replacement, not a competing legacy role
	// claim. Only show its portrait after units successfully loaded that exact profile.
	if (actorName === 'e7' && loadedRole === 'riki-meshy-v1') {
		const repaired = rolePortraitFiles['../../.forge/riki-meshy/portrait.png']
		if (repaired) return repaired
	}
	return rolePortraitTable().get(actorName) ?? portraits[`../../.forge/blender/previews/${actorName}.png`] ?? null
}
