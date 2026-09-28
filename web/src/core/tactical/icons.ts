/** Inline HUD symbols on a 24-unit grid, 1.5 stroke, square caps: the game's instrument line. */
export type HudIcon =
	| 'troops' | 'tank' | 'aircraft' | 'harvester'
	| 'map' | 'groups' | 'support' | 'alerts'
	| 'move' | 'attack' | 'stop'
	| 'fit' | 'heat' | 'vision' | 'signal' | 'plus' | 'minus' | 'base'
	| 'nuke' | 'para' | 'chrono' | 'shield' | 'radar' | 'strike' | 'taunt' | 'repair'
	| 'stats' | 'sound' | 'ask'
const paths: Record<HudIcon, string> = {
	troops: '<circle cx="12" cy="6.5" r="2.8"/><path d="M7 21v-5.5A5 5 0 0 1 12 10.5a5 5 0 0 1 5 5V21M9.5 21v-4.5M14.5 21v-4.5"/>',
	tank: '<path d="M3 14h18l-1.6 5H4.6z"/><path d="M7 14v-3.5h8V14M15 11.5l6.5-2.5"/><circle cx="7.5" cy="17" r=".4"/><circle cx="12" cy="17" r=".4"/><circle cx="16.5" cy="17" r=".4"/>',
	aircraft: '<path d="M12 2.5 14 9l7.5 5v2.5L14 14v4.5l2.2 2H7.8l2.2-2V14l-7.5 2.5V14L10 9z"/>',
	harvester: '<path d="M2.5 7.5h11v10h-11zM13.5 11h4.2l3.3 3.6v2.9h-7.5M2.5 11h11"/><circle cx="6.5" cy="18.5" r="1.8"/><circle cx="17.5" cy="18.5" r="1.8"/>',
	map: '<path d="m2.5 5.5 6-2.5 7 2.5 6-2.5v15.5l-6 2.5-7-2.5-6 2.5z"/><path d="M8.5 3v15.5M15.5 5.5V21"/>',
	groups: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
	support: '<circle cx="12" cy="12" r="5.5"/><path d="M12 1.5v6M12 16.5v6M1.5 12h6M16.5 12h6"/><circle cx="12" cy="12" r=".6"/>',
	alerts: '<path d="M12 3 22 20.5H2z"/><path d="M12 9.5v5M12 17.2v.3"/>',
	move: '<path d="M3 12h16.5M13.5 6l6 6-6 6"/>',
	attack: '<path d="M4 20 20 4M14 4h6v6M4 4l5 5M4 11V4h7"/>',
	stop: '<path d="M6 6h12v12H6z"/>',
	fit: '<path d="M8.5 3H3v5.5M15.5 3H21v5.5M3 15.5V21h5.5M21 15.5V21h-5.5"/><path d="M9 9h6v6H9z"/>',
	heat: '<path d="M12 2.5c1.8 4.3-1.7 5.5.8 8.2 1.6-.9 2.7-2.6 2.7-4.4 3.6 3.6 4.5 6.4 2.8 9.8A7.2 7.2 0 0 1 5.6 14c-.8-3.4 1.8-5.3 2.8-7.2 0 2.6 1.6 3.6 2.6 3.6-1.7-3.5 0-5.5 1-7.9Z"/>',
	vision: '<path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path d="M12 9v.01"/>',
	signal: '<path d="M4 20v-4M9 20v-8M14 20V8M19 20V4"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	minus: '<path d="M5 12h14"/>',
	base: '<path d="M3 21V10l9-6 9 6v11"/><path d="M9 21v-6h6v6"/><circle cx="12" cy="10" r="1.2"/>',
	nuke: '<circle cx="12" cy="12" r="2.2"/><path d="M12 9.8V3a9 9 0 0 1 7.8 4.5L14 11M10.1 13.1 4.2 16.5A9 9 0 0 1 3 12M13.9 13.1 19.8 16.5A9 9 0 0 1 12 21v-6.8"/>',
	para: '<path d="M3 11a9 9 0 0 1 18 0zM3 11l9 8 9-8M12 11v8M7.5 11 12 19M16.5 11 12 19"/><path d="M10.5 19h3v2.5h-3z"/>',
	chrono: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4.5l3 2M9 2.5h6M12 2.5V5"/>',
	shield: '<path d="M12 2.5 20 5.5v6c0 4.8-3.4 8.8-8 10-4.6-1.2-8-5.2-8-10v-6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
	radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 18.5 5.5"/><circle cx="15.5" cy="9" r=".6"/>',
	strike: '<path d="M4 20 11 13M13 4l7 7-4 1-5 5-1-4zM15 8l1 1"/>',
	taunt: '<path d="M3 9.5h3.5L16 4.5v15l-9.5-5H3z"/><path d="m6.5 14.5 1.6 5.5h2.6l-1.5-5.2M19 9v6M21.5 7.5v9"/>',
	repair: '<path d="M14.5 3a6.5 6.5 0 0 0-6.2 8.6L3 16.9V21h3.5l5.4-5.4A6.5 6.5 0 0 0 14.5 3z"/><circle cx="15.8" cy="8.2" r="1.7"/>',
	stats: '<path d="M4 20V10M9 20V4M14 20v-9M19 20V7"/><path d="M2.5 20h19"/>',
	sound: '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5z"/><path d="M16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
	ask: '<path d="M3.5 4.5h17v11h-9l-6 4.5v-4.5h-2z"/><path d="M9.8 8.8a2.3 2.3 0 1 1 3.2 2.1c-.9.4-1 .9-1 1.8M12 14.6v.01"/>',
}
export const icon = (name: HudIcon): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${paths[name]}</svg>`
/** One glyph per support power, by its bridge key: the nuke reads as a nuke wherever it appears. */
export const supportIconFor = (key: string): HudIcon => {
	const k = key.toLowerCase()
	return /nuke|atom|missile/.test(k) ? 'nuke' : /para/.test(k) ? 'para' : /chrono/.test(k) ? 'chrono' : /iron|curtain|invul/.test(k) ? 'shield' : /spy|gps|sat|sonar|radar/.test(k) ? 'radar' : 'strike'
}
