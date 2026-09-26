// Bundle entry for `tools/rostergate.mjs` ONLY.
//
// It exists because the gate needs the real generators — measuring parameters alone cannot
// see a generator that clamps or ignores one — and Node's type stripper cannot resolve this
// project's extensionless imports. Bundling through esbuild keeps `src/` writing imports the
// way the rest of the project writes them.
//
// Deliberately NOT `index.ts`: `web/src/main.ts` globs `./{...,units,...}/index.ts` to
// discover nodes, and a second index in a subdirectory is one rename away from being picked
// up as a node. This file is a build artifact's entry point, not a module boundary.
export { deriveChassis, DISPERSION_FIELDS, Family, Faction, norm, BREAKPOINTS, FACTION_OPERATOR } from './params'
export { buildTrackedVehicle } from './tracked'
export { buildWheeledVehicle } from './wheeled'
export { buildPlantStructure, buildEmplacement } from './plant'
export { buildInfantryFigure } from './infantry'
export { buildAircraft } from './aircraft'
export { buildVessel } from './vessel'
export { evalSdf, sdfAabb, aabb } from '../../geo/sdf'
