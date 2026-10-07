import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}

export function read(path) {
	return readFileSync(path, 'utf8')
}

export function walk(root, excluded = new Set()) {
	const files = []
	function visit(current) {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (excluded.has(entry.name)) continue
			const path = join(current, entry.name)
			if (entry.isDirectory()) visit(path)
			else if (entry.isFile()) files.push(path)
		}
	}
	visit(root)
	return files
}

export function slashRelative(root, path) {
	return relative(root, path).split(sep).join('/')
}

export function indentOf(line) {
	let indent = 0
	while (line.charCodeAt(indent) === 9) indent++
	return indent
}

export function yamlNode(line) {
	const indent = indentOf(line)
	const content = line.slice(indent)
	if (!content || content.startsWith('#')) return null
	const colon = content.indexOf(':')
	if (colon < 0) return null
	return {
		indent,
		key: content.slice(0, colon).trim(),
		value: content.slice(colon + 1).trim(),
	}
}

export function baseTrait(key) {
	let trait = key.startsWith('-') ? key.slice(1) : key
	const suffix = trait.indexOf('@')
	if (suffix >= 0) trait = trait.slice(0, suffix)
	return trait
}

export function fail(tool, message) {
	throw new Error(`${tool}: ${message}`)
}
