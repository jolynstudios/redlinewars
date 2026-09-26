// Offline content registry. The browser consumes the generated manifest, never SQLite.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = dirname(fileURLToPath(import.meta.url))
const dbPath = process.argv[2] ?? join(root, '../.content/steelseed.sqlite')
const manifestPath = process.argv[3] ?? join(root, '../src/content-manifest.json')
mkdirSync(dirname(dbPath), { recursive: true })
mkdirSync(dirname(manifestPath), { recursive: true })

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;')
db.exec(readFileSync(join(root, 'content-schema.sql'), 'utf8'))
const version = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value)
if (version !== 1) throw new Error(`Unsupported content schema ${version}`)
db.exec(readFileSync(join(root, 'content-seed.sql'), 'utf8'))

const addAsset = db.prepare('INSERT OR IGNORE INTO assets VALUES (?, ?, ?, ?, ?, ?)')
// Supersede the initial scaffold's placeholders, which never had backing assets.
db.exec("DELETE FROM wall_connection_variants WHERE asset_id IN ('sandbag-wall','concrete-wall'); DELETE FROM assets WHERE id IN ('sandbag-wall','concrete-wall');")
addAsset.run('sbag', 'wall', 'art/blender/assets/sbag.blend', 1, 0, 0)
addAsset.run('brik', 'wall', 'art/blender/assets/brik.blend', 1, 0, 0)
const addVariant = db.prepare('INSERT OR IGNORE INTO wall_connection_variants VALUES (?, ?, ?)')
for (const asset of ['sbag', 'brik']) {
	for (let mask = 0; mask < 16; mask++) {
		addVariant.run(asset, mask, `${asset}.wall.${mask}`)
	}
}

const rows = (sql, ...args) => db.prepare(sql).all(...args)
const manifest = {
	schema: 1,
	wallMaskBits: { north: 1, east: 2, south: 4, west: 8 },
	assets: rows('SELECT id, kind, source, scale, collision_radius AS collisionRadius, collision_height AS collisionHeight FROM assets ORDER BY id'),
	animations: rows('SELECT id, asset_id AS assetId, clip, loop, duration_ms AS durationMs FROM animations ORDER BY id'),
	particles: rows('SELECT id, family, preset_json AS preset FROM particle_effects ORDER BY id').map(row => ({ ...row, preset: JSON.parse(row.preset) })),
	wallConnections: rows('SELECT asset_id AS assetId, connection_mask AS mask, variant FROM wall_connection_variants ORDER BY asset_id, connection_mask'),
	weather: rows('SELECT id, sunlight, moonlight, rain, snow, fog_density AS fogDensity FROM weather_presets ORDER BY id'),
}
if (rows('PRAGMA foreign_key_check').length) throw new Error('Content foreign key violation')
for (const a of manifest.assets) if (!Number.isFinite(a.scale) || a.scale <= 0 || a.collisionRadius < 0 || a.collisionHeight < 0) throw new Error(`Invalid dimensions: ${a.id}`)
for (const { id, preset: p } of manifest.particles) {
	if (!Number.isInteger(p.count) || p.count < 1 || p.count > 128 || !Number.isFinite(p.lifetime) || p.lifetime <= 0 || p.lifetime > 30 ||
		!Number.isFinite(p.size) || p.size <= 0 || !Number.isFinite(p.speed) || p.speed < 0 || !Array.isArray(p.color) || p.color.length !== 3 ||
		p.color.some(v => !Number.isFinite(v) || v < 0) || !Number.isFinite(p.opacity) || p.opacity < 0 || p.opacity > 1 ||
		!Number.isFinite(p.emission) || p.emission < 0 || p.emission > 1) throw new Error(`Invalid particle preset: ${id}`)
}
const sha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
db.exec('COMMIT')
writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, sha256 }, null, 2)}\n`)
db.close()
console.log(`content-db: wrote ${manifestPath}`)
