let marks = 0

/**
 * The JOA mark: Redline Wars' notched red tile (the game logo's silhouette: chamfered top-left
 * corner, stepped foot), with an orbit and its satellite cut out of it over a watching lens.
 * Inline SVG, so it stays crisp at every size and needs no asset download.
 */
export function joaMark(size = 32, title = 'JOA'): string {
	const id = `joa-cut-${++marks}`
	const label = title ? `role="img" aria-label="${title}"` : 'aria-hidden="true"'
	return `<svg class="joa-mark" width="${size}" height="${size}" viewBox="0 0 48 48" ${label}>
<defs><mask id="${id}" maskUnits="userSpaceOnUse"><rect width="48" height="48" fill="#fff"/>
<circle cx="24" cy="23" r="7.2" fill="none" stroke="#000" stroke-width="3.2"/>
<circle cx="24" cy="23" r="2.4" fill="#000"/>
<path d="M7.5 30.5C12 16 30 8.5 41 12.5" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round"/>
<rect x="36.6" y="8.4" width="6.4" height="6.4" transform="rotate(20 39.8 11.6)" fill="#000"/>
</mask></defs>
<path d="M11 3H45V45H32L28 41H3V11Z" fill="#C93630" mask="url(#${id})"/>
</svg>`
}
