// The battlefield plot on the setup screen: the one light source of the console.
//
// It draws only what the catalog really knows — the playable bounds, the spawn points and the
// theatre — as a blueprint: grid lines every 8 and 32 cells, corner brackets, a north tick
// and a scale label. No fake terrain and no image assets. Spawn markers are real buttons:
// clicking one claims that spawn for you.
import type { SkirmishMapCatalog } from '../core'
import { rovingGroup } from './setup-controls'

export interface SpawnMarker {
	readonly id: number
	/** Filled with this colour when a player holds the spawn; hollow when free. */
	readonly color?: string
	/** "YOU", or the player number. */
	readonly label?: string
	readonly you?: boolean
}

export interface Schematic {
	readonly root: HTMLElement
	show(map: SkirmishMapCatalog | null, markers?: readonly SpawnMarker[]): void
}

const THEATRE: Readonly<Record<string, string>> = { SNOW: 'Snow', TEMPERAT: 'Temperate', DESERT: 'Desert' }

/** Readable ink on a marker fill: void on light colours, warm white on dark ones. */
function markerInk(hex: string): string {
	const m = /^#?([0-9a-f]{6})/i.exec(hex)
	if (!m) return '#090D11'
	const n = parseInt(m[1], 16)
	const luma = (.2126 * ((n >> 16) & 255) + .7152 * ((n >> 8) & 255) + .0722 * (n & 255)) / 255
	return luma > .55 ? '#090D11' : '#FFF5E8'
}

export function createSchematic(opts: { size: 'card' | 'thumb'; onSpawn?: (spawnId: number) => void }): Schematic {
	const root = document.createElement('div')
	root.className = 'schematic'
	root.dataset.size = opts.size
	const plot = document.createElement('div')
	plot.className = 'schematic__plot'
	const corners = ['tl', 'tr', 'bl', 'br'].map(c => {
		const s = document.createElement('span')
		s.className = `schematic__corner schematic__corner--${c}`
		s.setAttribute('aria-hidden', 'true')
		return s
	})
	const north = document.createElement('span')
	north.className = 'schematic__north'
	north.textContent = 'N'
	north.setAttribute('aria-hidden', 'true')
	const theatre = document.createElement('span')
	theatre.className = 'schematic__label schematic__label--theatre'
	const scale = document.createElement('span')
	scale.className = 'schematic__label schematic__label--scale'
	const hint = document.createElement('span')
	hint.className = 'schematic__label schematic__label--hint'
	const markers = document.createElement('div')
	markers.className = 'schematic__markers'
	markers.setAttribute('role', 'group')
	markers.setAttribute('aria-label', 'Spawn points')
	plot.append(...corners, north, markers)
	root.append(plot, theatre, scale)
	if (opts.onSpawn) root.append(hint)
	if (opts.onSpawn) rovingGroup(markers, '.spawn-marker')

	return {
		root,
		show(map, list = []) {
			if (!map) {
				root.hidden = true
				return
			}
			root.hidden = false
			const { width: w, height: h, x: bx, y: by } = map.bounds
			root.dataset.tileset = map.tileSet
			plot.style.setProperty('--plot-ratio', `${w} / ${h}`)
			plot.style.setProperty('--cell-x', `${100 / w}%`)
			plot.style.setProperty('--cell-y', `${100 / h}%`)
			theatre.textContent = THEATRE[map.tileSet] ?? map.tileSet.toLowerCase()
			scale.textContent = `${w} × ${h}`
			const byId = new Map(list.map(m => [m.id, m]))
			const mine = list.find(m => m.you)
			hint.textContent = mine ? `You start at spawn ${mine.id}` : 'Click a spawn to take it'
			markers.replaceChildren(...map.spawnPoints.map(spawn => {
				const marker = byId.get(spawn.id)
				const b = document.createElement(opts.onSpawn ? 'button' : 'span')
				b.className = 'spawn-marker'
				b.style.left = `${((spawn.x - bx + .5) / w) * 100}%`
				b.style.top = `${((spawn.y - by + .5) / h) * 100}%`
				b.dataset.state = marker?.you ? 'you' : marker?.color ? 'taken' : 'free'
				if (marker?.color) {
					b.style.setProperty('--marker', marker.color.slice(0, 7))
					b.style.setProperty('--marker-ink', markerInk(marker.color))
				}
				const num = document.createElement('span')
				num.className = 'spawn-marker__num'
				num.textContent = String(spawn.id)
				b.append(num)
				if (marker?.label) {
					const tag = document.createElement('span')
					tag.className = 'spawn-marker__tag'
					tag.textContent = marker.label
					b.append(tag)
				}
				const holder = marker?.you ? 'you' : marker?.label ? `player ${marker.label}` : 'free'
				if (b instanceof HTMLButtonElement) {
					b.type = 'button'
					b.setAttribute('aria-label', `Spawn ${spawn.id}, ${holder}${marker?.you ? '' : ' — take this spawn'}`)
					b.addEventListener('click', () => opts.onSpawn?.(spawn.id))
				} else {
					b.setAttribute('aria-hidden', 'true')
				}
				return b
			}))
		},
	}
}
