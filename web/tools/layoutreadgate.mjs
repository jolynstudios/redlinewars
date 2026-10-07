#!/usr/bin/env node
// No layout reads in frame code. Reading a layout property (clientWidth, offsetWidth,
// getBoundingClientRect, getComputedStyle, ...) after the frame has written the DOM makes the
// browser lay the page out synchronously, inside the frame. The UI read canvas.clientWidth in
// its marks right after writing the health-bar overlay. The same four-player battle, switched
// every 5 s between that and a cached size, measured main-thread frame p95 18.1 → 6.9 ms, with
// 40% more frames drawn (vfxbaselinegate A/B, 2026-09-25).
//
// Frame code reads the canvas size through canvasCssWidth/canvasCssHeight (ctx.canvasCss,
// which the app's ResizeObserver keeps). Every remaining layout read in web/src is listed
// below with the reason it can't run mid-frame. A new read fails this gate until it moves
// out of the frame or is added here with that reason.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(import.meta.dirname, '../src')
const LAYOUT_READ = /\.(clientWidth|clientHeight|clientTop|clientLeft|offsetWidth|offsetHeight|offsetTop|offsetLeft|scrollWidth|scrollHeight|innerWidth|innerHeight)\b|getBoundingClientRect\(|getClientRects\(|getComputedStyle\(/

// file → trimmed source line → why it never runs inside a frame.
const ALLOWED = {
	'core/ctx.ts': {
		'return ctx.canvasCss?.width || ctx.canvas?.clientWidth || 0': 'fallback before the first observer report and in DOM-free gates',
		'return ctx.canvasCss?.height || ctx.canvas?.clientHeight || 0': 'fallback before the first observer report and in DOM-free gates',
	},
	'core/app.ts': {
		'this.host.canvasCss.width = canvas.clientWidth': 'the ResizeObserver callback (after layout) and render-scale changes',
		'this.host.canvasCss.height = canvas.clientHeight': 'the ResizeObserver callback (after layout) and render-scale changes',
	},
	'core/input.ts': {
		'const r = canvas.getBoundingClientRect()': 'pointer event handlers, between frames',
	},
	'ui/index.ts': {
		'const css = getComputedStyle(document.documentElement)': 'palette read once at init',
		"if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'": 'overlay creation',
		'const rect = canvas.getBoundingClientRect()': 'minimap pointer handler',
	},
	'ui/setup-controls.ts': {
		"const focusables = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(f => f.getClientRects().length > 0 && !f.closest('[inert]'))": 'dialog focus trap: on open and on Tab',
	},
	// Known debt: the tutorial places its card every frame while a step is open, after writing
	// the ring's style, so those frames still pay one forced layout. It is not in battle frames.
	'ui/tutorial.ts': {
		'const rect = element.getBoundingClientRect()': 'tutorial card placement, while a tutorial step is open',
		"const key = `${step.id}:${targetRect ? `${Math.round(targetRect.left)},${Math.round(targetRect.top)},${Math.round(targetRect.width)},${Math.round(targetRect.height)}` : '-'}:${root.offsetHeight}`": 'tutorial card placement, while a tutorial step is open',
		'const vw = window.innerWidth': 'tutorial card placement, while a tutorial step is open',
		'const vh = window.innerHeight': 'tutorial card placement, while a tutorial step is open',
		'const cw = root.offsetWidth': 'tutorial card placement, while a tutorial step is open',
		'const ch = root.offsetHeight': 'tutorial card placement, while a tutorial step is open',
	},
	'boot-screen.ts': {
		'void tipCard.offsetWidth // commit the switch without its cross-fade': 'boot screen, before the first match frame',
	},
}

const files = []
const walk = dir => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) walk(path)
		else if (entry.name.endsWith('.ts')) files.push(path)
	}
}
walk(SRC)

const unexpected = [], seen = new Set()
for (const path of files) {
	const file = relative(SRC, path).split('\\').join('/')
	readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
		const code = line.replace(/\/\/(?!.*['"`]).*$/, '')
		if (!LAYOUT_READ.test(code) || /^\s*(\*|\/\*)/.test(line)) return
		const text = line.trim()
		if (ALLOWED[file]?.[text] !== undefined) { seen.add(`${file}\n${text}`); return }
		unexpected.push(`${file}:${index + 1}: ${text}`)
	})
}
const stale = Object.entries(ALLOWED).flatMap(([file, lines]) => Object.keys(lines).filter(text => !seen.has(`${file}\n${text}`)).map(text => `${file}: ${text}`))

assert.deepEqual(unexpected, [], `layout reads outside the allowlist; read ctx.canvasCss (canvasCssWidth/Height) in frame code, or list the line with the reason it never runs mid-frame:\n  ${unexpected.join('\n  ')}`)
assert.deepEqual(stale, [], `allowlisted layout reads no longer in the source; remove them from the list:\n  ${stale.join('\n  ')}`)
console.log(`layoutreadgate: PASS — ${files.length} files; ${seen.size} allowed layout reads, none in frame code`)
