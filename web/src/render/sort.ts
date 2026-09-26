// STEELSEED — render/sort
// Allocation-free sorting for the per-frame draw lists.
//
// Hard rule 6 rules out the obvious approaches. `array.sort(cmp)` allocates a closure
// frame per comparison on some engines, `keys.subarray(0, n).sort()` allocates a view
// every frame, and a comparator on an array of objects is a megamorphic call site. What
// is left is a bottom-up merge sort over a preallocated Float64Array with an explicit
// element count and a preallocated scratch buffer — no allocation on any path.
//
// Keys are PACKED: the sort field goes in the high bits and the item index in the low 12,
// so one numeric sort orders the items and carries their identity with them. f64 holds
// integers exactly up to 2^53, which leaves 41 bits for the sort field — far more than
// the 20-bit quantised depth and 21-bit state key this renderer uses.

/** Item indices are 12 bits, so one frame can carry 4096 draw items. */
export const INDEX_BITS = 12
export const INDEX_MASK = (1 << INDEX_BITS) - 1
export const MAX_SORTABLE = 1 << INDEX_BITS

export function packKey(sortField: number, itemIndex: number): number {
	return sortField * MAX_SORTABLE + (itemIndex & INDEX_MASK)
}

export function unpackIndex(packed: number): number {
	return packed % MAX_SORTABLE
}

/**
 * Ascending in-place merge sort of `keys[0..n)`. `scratch` must be at least `n` long and
 * is clobbered. Stable, which matters: two items with identical state keys keep their
 * submission order, so a frame's draw order is a pure function of what was submitted and
 * `baseline.mjs` stays bit-identical across runs (§5.2).
 */
export function sortKeys(keys: Float64Array, scratch: Float64Array, n: number): void {
	if (n < 2) return
	let src = keys
	let dst = scratch
	for (let width = 1; width < n; width *= 2) {
		for (let lo = 0; lo < n; lo += width * 2) {
			const mid = lo + width < n ? lo + width : n
			const hi = lo + width * 2 < n ? lo + width * 2 : n
			let i = lo
			let j = mid
			let k = lo
			while (i < mid && j < hi) dst[k++] = src[i] <= src[j] ? src[i++] : src[j++]
			while (i < mid) dst[k++] = src[i++]
			while (j < hi) dst[k++] = src[j++]
		}
		const swap = src
		src = dst
		dst = swap
	}
	// An odd number of passes leaves the result in scratch. Copy element by element
	// rather than with set(subarray) — subarray allocates a view, and this runs per frame.
	if (src !== keys) for (let i = 0; i < n; i++) keys[i] = src[i]
}

/**
 * Quantise a non-negative float into `bits` bits for use as a sort field. Saturates
 * instead of wrapping: a unit 40 km away must sort last, not first.
 */
export function quantise(value: number, scale: number, bits: number): number {
	const max = 2 ** bits - 1
	if (!(value > 0)) return 0
	const q = Math.round(value * scale)
	return q > max ? max : q
}
