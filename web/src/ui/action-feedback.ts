import type { ContextOrderPreview } from '../core'

export interface ActionFeedback {
	label: string
	glyph: string
	attack: boolean
	actorAction: boolean
	blocked: boolean
}

/** Fixed CSS-pixel reticle: circle with a short center cross; never scaled to target bounds. */
export const ATTACK_GLYPH = 'M-8 0A8 8 0 1 1 8 0A8 8 0 1 1 -8 0M-3 0H3M0-3V3'
const ENTER_GLYPH = 'M1-7H7V7H1M-8 0H4M0-4L4 0L0 4'
const FLAG_GLYPH = 'M-5 8V-8M-5-7H7L4-3L7 1H-5'
const TOOL_GLYPH = 'M-6 7L2-1M1-7L0-2L3 1L8 0L7-5L4-2L2-4L5-7Z'

/** Labels describe an engine-resolved order; this table grants no abilities. */
export function actionFeedback(preview: ContextOrderPreview | null): ActionFeedback | null {
	if (!preview) return null
	const order = preview.order.toLowerCase()
	const cursor = preview.cursor.toLowerCase()
	const blocked = cursor.includes('blocked')
	const make = (label: string, glyph: string, attack = false, actorAction = true): ActionFeedback =>
		({ label, glyph, attack, actorAction: actorAction && !blocked, blocked })
	if (order === 'c4' || order.includes('demolition') || cursor === 'c4')
		return make('C4 · demolish', 'M-8-5H8V7H-8ZM-3-5V-8H3V-5M-4 0H-1M2 0H5M-4 3H5', true)
	if (order.includes('capture') || cursor === 'capture') return make('Capture building', FLAG_GLYPH)
	if (order.includes('infiltrat')) return make('Infiltrate', ENTER_GLYPH)
	if (order.includes('disguise')) return make('Disguise', 'M-8-3Q0-8 8-3L6 4L2 2H-2L-6 4ZM-5-1H-2M2-1H5')
	if (order.includes('attack') && !order.includes('move')) return make('Attack', ATTACK_GLYPH, true)
	if (order.includes('heal') || cursor === 'heal') return make('Heal', 'M-3-8H3V-3H8V3H3V8H-3V3H-8V-3H-3Z')
	if (order.includes('repair') || cursor.includes('wrench')) return make('Repair', TOOL_GLYPH)
	if (order.includes('harvest') || cursor === 'harvest') return make('Harvest', 'M-7-5H7L4 3H-4ZM-3 3V7H3V3')
	if (order.includes('enter') || order.includes('load') || cursor === 'enter') return make('Enter', ENTER_GLYPH)
	if (order === 'sell') return make('Sell building', 'M5-6H-3Q-8-6-6-1L5 2Q9 7 3 7H-6M0-9V10')
	if (order.includes('move') || order.includes('rally') || order.includes('guard')) return null
	// Existing targeted specials retain their engine name if no bespoke symbol is needed.
	return make(preview.order.replace(/([a-z])([A-Z])/g, '$1 $2'), ENTER_GLYPH)
}
