/** What the co-commander may ask the commander. Every entry is a question: the companion is
 * subordinate, it suggests and asks, and the main game stays in command. Ids are the wire
 * format (relay validated to [a-z0-9-]); texts appear on both screens. */
export interface Ask { id: string; text: string }
export const REQUESTS: Ask[] = [
	{ id: 'new-attack-group', text: 'Form a new attack group?' },
	{ id: 'attack-now', text: 'Attack now?' },
	{ id: 'tank-battalion', text: 'Build a tank battalion?' },
	{ id: 'rifle-battalion', text: 'Build a rifle battalion?' },
	{ id: 'fill-groups', text: 'Fill all groups back up?' },
	{ id: 'aircraft', text: 'Ready the aircraft?' },
	{ id: 'paratroopers', text: 'Drop the paratroopers?' },
	{ id: 'nuke', text: 'Launch the nuke?' },
	{ id: 'harvesters', text: 'Build another harvester?' },
	{ id: 'defenses', text: 'Shore up the defenses?' },
]
export const requestById = (id: string): Ask | undefined => REQUESTS.find(r => r.id === id)
