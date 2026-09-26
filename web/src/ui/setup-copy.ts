// Plain-language copy for the pre-match screens.
//
// Engine refusals arrive as a stable code plus a developer-facing sentence that names
// internal slot ids ('Multi1'). Players read "Player 2" and a next step instead.

/** A refusal from the simulation host: its stable code travels next to the message. */
export class StartRefused extends Error {
	constructor(readonly code: string, readonly userMessage: string) {
		super(`${code}: ${userMessage}`)
		this.name = 'StartRefused'
	}
}

interface SlotList { readonly slots: readonly { readonly id: string }[] }

/** "Player N" for an internal slot id, by its position in the map's slot list. */
export function playerName(map: SlotList | null, slotId: string): string {
	const index = map?.slots.findIndex(slot => slot.id === slotId) ?? -1
	return index >= 0 ? `Player ${index + 1}` : 'A player'
}

/** The engine's refusal as one sentence a player can act on. Unknown codes keep the engine's words. */
export function humanizeStartError(code: string, message: string, map: SlotList | null): string {
	const slot = /'([^']+)'/.exec(message)?.[1] ?? ''
	const who = slot ? playerName(map, slot) : 'A player'
	switch (code) {
		case 'duplicate-spawn': {
			const spawn = /Spawn (\d+)/.exec(message)?.[1] ?? '?'
			return `Two players picked spawn ${spawn}. Give one of them another spawn, or set it to Random.`
		}
		case 'invalid-spawn': return `${who} has a spawn this map does not have. Pick another spawn, or Random.`
		case 'invalid-team': return `${who} has a team this map does not allow. Pick another team.`
		case 'invalid-faction': return `${who} has a faction this map does not offer. Pick another faction.`
		case 'invalid-color': return `${who} has a colour that is not available. Pick another colour.`
		case 'required-slot-empty': return `${who} must be filled on this map. Set it to a bot.`
		case 'bot-not-allowed': return `${who} cannot be a bot on this map. Set it to Open or Closed.`
		case 'unknown-bot': return `${who} has an unknown bot type. Pick another bot.`
		case 'human-count':
		case 'invalid-human-slot':
		case 'human-slot-conflict': return 'Exactly one slot must be you.'
		case 'missing-map': return 'Choose a map.'
		case 'unknown-map': return 'That map is not available any more. Choose another.'
		case 'unknown-option':
		case 'locked-option':
		case 'invalid-option-value': {
			const rule = /option '([^']+)'/.exec(message)?.[1] ?? ''
			return `A match rule is not valid for this map${rule ? ` (${rule})` : ''}. Reset the match rules and try again.`
		}
		default: return message
	}
}

/** WCAG relative luminance of a `#RRGGBB[AA]` colour; NaN for anything else. */
export function relativeLuminance(hex: string): number {
	const m = /^#?([0-9a-f]{6})/i.exec(hex)
	if (!m) return Number.NaN
	const channel = (i: number): number => {
		const c = parseInt(m[1].slice(i, i + 2), 16) / 255
		return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4
	}
	return .2126 * channel(0) + .7152 * channel(2) + .0722 * channel(4)
}

/** One line per match rule, keyed by the catalog's lobby option id. */
export const RULE_COPY: Readonly<Record<string, string>> = {
	startingcash: 'Credits each player starts with.',
	startingunits: 'Units that deploy with your MCV at the start.',
	crates: 'Crates appear on the map; picking one up gives a random bonus or penalty.',
	bounty: 'Earn cash for every enemy unit you destroy.',
	gamespeed: 'How fast the simulation runs for everyone.',
	techlevel: 'Limits which units and buildings anyone can build.',
	timelimit: 'Ends the match when the time runs out.',
	shortgame: 'You are defeated when your base is destroyed, even with units left.',
	fog: 'You only see enemies within your units’ sight.',
	explored: 'The map starts uncovered.',
	buildradius: 'Buildings must go near your construction yards.',
	allybuild: 'You and your allies can build in each other’s base area.',
	separateteamspawns: 'Random spawns start as far from enemies as possible.',
	factundeploy: 'Construction yards can pack up and move.',
	'reusable-engineers': 'Engineers survive capturing a building.',
}

/** Friendlier names than the humanised lobby keys, where those read awkwardly. */
export const RULE_LABEL: Readonly<Record<string, string>> = {
	allybuild: 'Build near allies',
	factundeploy: 'Redeployable MCVs',
	'reusable-engineers': 'Reusable engineers',
	separateteamspawns: 'Separate team spawns',
}

/** Match-rule groups in reading order; unknown option ids land in "Other". */
export const RULE_GROUPS: readonly { readonly title: string; readonly ids: readonly string[] }[] = [
	{ title: 'Economy', ids: ['startingcash', 'startingunits', 'crates', 'bounty'] },
	{ title: 'Tempo', ids: ['gamespeed', 'techlevel', 'timelimit', 'shortgame'] },
	{ title: 'Vision', ids: ['fog', 'explored'] },
	{ title: 'Construction', ids: ['buildradius', 'allybuild', 'separateteamspawns', 'factundeploy', 'reusable-engineers'] },
]
/** Options that never sit in the match rules: owned elsewhere or developer-only. */
export const RULES_ELSEWHERE: ReadonlySet<string> = new Set(['tod', 'weather', 'cheats'])
/** Lobby options no menu offers. The debug menu (cheats) stays at the map's default: off. */
export const HIDDEN_OPTIONS: ReadonlySet<string> = new Set(['cheats'])

/** Time of day and weather captions, one per value. */
export const CONDITION_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	tod: {
		auto: 'Follows the match clock: a full day every 24 minutes.',
		day: 'Daylight for the whole match.',
		night: 'Night for the whole match.',
		world: 'Your real local time of day.',
	},
	weather: {
		off: 'Clear skies.',
		on: 'Rain, storms, snow and mud take turns.',
		live: 'Your region’s real weather, from ipwho.is and open-meteo.com.',
	},
}

/** One line per graphics preset for the settings sheet. */
export const GRAPHICS_COPY: Readonly<Record<string, string>> = {
	detect: 'Picks a preset for this device once.',
	dynamic: 'Adjusts detail automatically, based on how your computer performs, to keep the game smooth. The default on laptops and integrated graphics.',
	low: 'Fastest. For older laptops and integrated graphics.',
	medium: 'Balanced detail for most laptops.',
	high: 'Full lighting and shadows for a dedicated GPU.',
	turbo: 'High detail, tuned for 60 fps.',
	classic: 'The full Redline Wars look at fixed detail, and the default on a strong graphics card. If the game stutters, choose Dynamic: it adjusts detail automatically to your computer’s performance.',
	ultra: 'Every effect on, for a strong GPU.',
	'ultra-max': 'Everything at maximum. The strongest GPUs only.',
}

/** Names for the catalog's sixteen colour presets (first six hex digits); unknown ones read as hex. */
const COLOUR_NAMES: Readonly<Record<string, string>> = {
	'391D1D': 'Maroon', '98331F': 'Rust', F57606: 'Orange', F50606: 'Red',
	DDB8FF: 'Lavender', ACF218: 'Lime', '06F739': 'Green', F2BC18: 'Gold',
	'200738': 'Aubergine', '280DF6': 'Blue', '79F2AA': 'Mint', '34BA93': 'Teal',
	F861A4: 'Pink', C718F2: 'Violet', '79CEF2': 'Sky', '2F86F2': 'Azure',
}
export function colourName(hex: string): string {
	const key = hex.replace('#', '').slice(0, 6).toUpperCase()
	return COLOUR_NAMES[key] ?? `#${key}`
}

/**
 * A faction's one-word identity from its catalog description, whose first line reads
 * "England: Counterintelligence" (or "Random Country").
 */
export function factionTagline(description: string | undefined): string {
	const first = (description ?? '').split('\n')[0] ?? ''
	const colon = first.indexOf(':')
	return (colon >= 0 ? first.slice(colon + 1) : '').trim()
}
