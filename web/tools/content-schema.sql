PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('actor','building','wall','environment','wildlife','effect')),
  source TEXT NOT NULL,
  scale REAL NOT NULL DEFAULT 1.0,
  collision_radius REAL NOT NULL DEFAULT 0.0,
  collision_height REAL NOT NULL DEFAULT 0.0
);
CREATE TABLE IF NOT EXISTS animations (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  clip TEXT NOT NULL,
  loop INTEGER NOT NULL DEFAULT 1 CHECK (loop IN (0,1)),
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0)
);
CREATE TABLE IF NOT EXISTS particle_effects (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  preset_json TEXT NOT NULL CHECK (json_valid(preset_json))
);
CREATE TABLE IF NOT EXISTS wall_connection_variants (
  asset_id TEXT NOT NULL REFERENCES assets(id),
  connection_mask INTEGER NOT NULL CHECK (connection_mask BETWEEN 0 AND 15),
  variant TEXT NOT NULL,
  PRIMARY KEY (asset_id, connection_mask)
);
CREATE TABLE IF NOT EXISTS weather_presets (
  id TEXT PRIMARY KEY,
  sunlight REAL NOT NULL,
  moonlight REAL NOT NULL,
  rain REAL NOT NULL DEFAULT 0,
  snow REAL NOT NULL DEFAULT 0,
  fog_density REAL NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO meta VALUES ('schema_version', '1');
