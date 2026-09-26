-- Presentation defaults; OpenRA owns gameplay statistics.
INSERT OR IGNORE INTO particle_effects VALUES
 ('smoke','smoke','{"count":12,"lifetime":3.8,"size":0.65,"speed":0.7,"color":[0.38,0.40,0.43],"opacity":0.75,"emission":0}'),
 ('fire','fire','{"count":12,"lifetime":0.75,"size":0.38,"speed":1.2,"color":[4.5,0.8,0.08],"opacity":0.9,"emission":1}'),
 ('debris','debris','{"count":14,"lifetime":1.6,"size":0.06,"speed":2.8,"color":[1.8,0.7,0.16],"opacity":1,"emission":0.7}'),
 ('dust','dust','{"count":8,"lifetime":1.4,"size":0.28,"speed":0.5,"color":[0.53,0.42,0.27],"opacity":0.55,"emission":0}'),
 ('splash','splash','{"count":10,"lifetime":0.7,"size":0.07,"speed":1.4,"color":[0.55,0.77,0.86],"opacity":0.8,"emission":0.2}'),
 -- The three flight wakes below are what src/content-manifest.json has shipped (fx/particles
 -- `wake` family): they were edited into the manifest without this seed, so a clean rebuild
 -- regressed rocket, exhaust and jet trails. The seed now carries them.
 ('trail','wake','{"count":1,"lifetime":1.55,"size":0.48,"speed":0.04,"color":[0.74,0.72,0.68],"opacity":0.78,"emission":0.04}'),
 ('exhausttrail','wake','{"count":1,"lifetime":0.52,"size":0.34,"speed":0.06,"color":[2.4,0.62,0.1],"opacity":0.92,"emission":1}'),
 ('jetcontrail','wake','{"count":1,"lifetime":2.6,"size":0.28,"speed":0.03,"color":[0.9,0.94,1],"opacity":0.46,"emission":0.08}'),
 -- A chimney is not an explosion. `smoke` is a 12-particle puff that lives 3.8 s, so a single
 -- flue emitting it would hold ~114 particles against a 2048 pool shared with combat, and the
 -- first firefight would drop shell bursts to keep a refinery smoking. A stack wants the
 -- opposite shape: ONE particle per emission, long-lived and slow, so the column reads as a
 -- continuous thread rather than a series of coughs.
 ('stack','smoke','{"count":1,"lifetime":4.6,"size":0.3,"speed":0.32,"color":[0.44,0.45,0.47],"opacity":0.42,"emission":0}'),
 -- ------------------------------------------------------------------------------------
 -- Building death: the seven layers of a mushroom cloud (fx/mushroom-cloud.ts).
 --
 -- A rifle round and a construction yard were spawning the SAME three presets. What makes
 -- a cloud read as a mushroom rather than a bigger puff is that its parts arrive at
 -- different times and cool as they climb, and the pool has no over-life colour ramp — so
 -- the ramp is spelled out as separate presets and the schedule picks which one to emit at
 -- which height and which second.
 --
 -- BUDGET. `count` is deliberately 1 on every sustained layer: the emitter owns the
 -- cadence, so 156 particles buy a six-second cloud instead of 12 arriving at once. The
 -- whole schedule is 156 particles and the module caps four concurrent clouds, so a
 -- building death can never take more than 624 of the 2048-slot pool (30%) away from the
 -- rest of the battle. Only the two instantaneous layers carry a count above 1.
 --
 -- SIZES ARE SMALL ON PURPOSE. `particles.ts` grows every non-ballistic particle to 3.3x its
 -- birth radius over its life, and the emitter multiplies by a per-building scale that reaches
 -- 1.24 on the construction yard. A 0.6 m preset therefore ends up a 2.5 m ball, and the first
 -- composed capture of this cloud was an orange fog bank with no shape in it at all. Half those
 -- sizes, and the cap reads as a ring of puffs instead of one wash.
 ('blastcore','fire','{"count":3,"lifetime":0.30,"size":0.42,"speed":1.10,"color":[7.0,4.0,1.5],"opacity":1,"emission":1}'),
 ('fireball','fire','{"count":2,"lifetime":1.05,"size":0.34,"speed":0.85,"color":[4.0,1.0,0.12],"opacity":0.8,"emission":1}'),
 -- The stem between the fireball and the cap: still burning, no longer white.
 ('stemfire','smoke','{"count":1,"lifetime":2.6,"size":0.30,"speed":0.45,"color":[1.3,0.45,0.10],"opacity":0.8,"emission":0.45}'),
 -- The cap. Long-lived, slow and large, because it has to still be there when the stem
 -- that fed it has gone out — that persistence is what the eye reads as a head.
 ('mushcap','smoke','{"count":1,"lifetime":4.6,"size":0.42,"speed":0.14,"color":[0.13,0.125,0.135],"opacity":0.85,"emission":0}'),
 -- Concrete fines thrown outward along the ground at the collapse instant. Slow enough
 -- that `update`'s vertical term keeps it under a metre for its whole life.
 ('dustskirt','dust','{"count":1,"lifetime":3.2,"size":0.32,"speed":0.20,"color":[0.60,0.51,0.37],"opacity":0.58,"emission":0}'),
 -- What is still going after everything combustible has burnt: the authored d5 `smoulder`.
 ('ruinsmoke','smoke','{"count":1,"lifetime":5.2,"size":0.30,"speed":0.34,"color":[0.18,0.17,0.17],"opacity":0.62,"emission":0}'),
 -- Structural debris, not shell splinters: heavier, slower and larger than `debris`.
 ('rubble','debris','{"count":10,"lifetime":1.9,"size":0.11,"speed":2.0,"color":[1.2,0.55,0.18],"opacity":1,"emission":0.35}'),
 -- ------------------------------------------------------------------------------------
 -- The per-weapon vocabulary (fx/weapon-fx.ts).
 --
 -- `weapon-visual-manifest.json` names a `smoke` and an `impact` word for all 50 weapons —
 -- none, faint, puff, plume, trail, soot; chip, spark, shell, heavy-shell, blast, water,
 -- electrical, burn, flak — and nothing read either. Every shot in the game spawned `smoke`
 -- at the muzzle and `dust` plus, above 20 damage, `fire` at the target, so a rifle chip, a
 -- shell burst, a tesla hit and a demolition blast were the same two presets at four sizes.
 --
 -- THIS IS CHEAPER THAN WHAT IT REPLACES, and that is not a coincidence. `smoke` is 12
 -- particles living 3.8 s: 45.6 particle-seconds held per ROUND, from a 2048-slot pool shared
 -- with every explosion on the map, for a rifleman firing twice a second. Small arms want one
 -- wisp for half a second — 0.55 particle-seconds — and giving them one is worth more pool
 -- than every effect below costs.
 ('gunsmoke','smoke','{"count":1,"lifetime":0.55,"size":0.10,"speed":0.35,"color":[0.62,0.62,0.63],"opacity":0.42,"emission":0}'),
 -- A tank gun clearing its bore: two puffs, gone before the reload.
 ('barrelsmoke','smoke','{"count":2,"lifetime":1.6,"size":0.20,"speed":0.50,"color":[0.45,0.44,0.43],"opacity":0.55,"emission":0}'),
 -- Artillery and rocket launch. Warmer and faster than a gun puff because it is still burning
 -- when it leaves; the rocket emission is displaced BEHIND the tube by fx/index.ts.
 ('launchsmoke','smoke','{"count":3,"lifetime":1.7,"size":0.26,"speed":0.90,"color":[0.55,0.50,0.46],"opacity":0.62,"emission":0.06}'),
 -- Unburnt fuel. The only near-black smoke in the table, which is what separates a
 -- flamethrower from every other weapon at a glance once the flame itself has gone.
 ('soot','smoke','{"count":3,"lifetime":2.2,"size":0.24,"speed":0.55,"color":[0.10,0.095,0.09],"opacity":0.72,"emission":0}'),
 -- Impacts. All four ballistic families arc and fall; a spark that floats is a firefly.
 -- A bullet taking a flake off masonry: pale, small, and over in under half a second.
 ('chip','debris','{"count":3,"lifetime":0.45,"size":0.035,"speed":1.7,"color":[0.55,0.53,0.50],"opacity":1,"emission":0.05}'),
 -- An autocannon round off armour: fewer, faster, and genuinely emissive.
 ('spark','debris','{"count":5,"lifetime":0.32,"size":0.028,"speed":2.6,"color":[3.4,2.1,0.5],"opacity":1,"emission":1}'),
 -- Shell splinters. Heavier and longer-lived than sparks, dimmer than burning debris.
 ('frag','debris','{"count":6,"lifetime":0.85,"size":0.055,"speed":3.0,"color":[1.6,0.65,0.15],"opacity":1,"emission":0.55}'),
 -- An electrical hit. Cool, because the pool takes an arbitrary colour where the emissive
 -- MESH path takes one of two — which is the whole reason a tesla strike used to spark orange.
 ('zapspark','debris','{"count":6,"lifetime":0.30,"size":0.030,"speed":2.4,"color":[0.55,1.5,3.6],"opacity":1,"emission":1}'),
 -- An anti-aircraft airburst: dark, static and lingering, unlike anything that hit ground.
 ('flakpuff','smoke','{"count":4,"lifetime":1.2,"size":0.22,"speed":0.80,"color":[0.22,0.22,0.23],"opacity":0.70,"emission":0}'),
 -- ------------------------------------------------------------------------------------
 -- Ultra combat vocabulary (vfx.md Epics 5/6; fx/vfx-budget gates it to Ultra and Ultra+).
 --
 -- Muzzle: a cannon clears its bore as a directed cone of gas that keeps moving forward and
 -- rolls out over half a second, not as a 0.1 m wisp. A heavy gun also lifts a skirt of dust
 -- off the ground under the muzzle. fx spawns both along the barrel axis.
 ('muzzlegas','smoke','{"count":4,"lifetime":1.1,"size":0.3,"speed":2.6,"color":[0.55,0.53,0.5],"opacity":0.55,"emission":0.02}'),
 ('muzzleglow','fire','{"count":2,"lifetime":0.1,"size":0.16,"speed":1.6,"color":[5,2.1,0.45],"opacity":0.9,"emission":1}'),
 ('muzzledust','dust','{"count":7,"lifetime":1.4,"size":0.3,"speed":1.3,"color":[0.5,0.43,0.32],"opacity":0.38,"emission":0}'),
 -- Impact haze: what hangs over a strike after the burst, coloured by the struck surface.
 -- It outlives the burst (2-3 s) at low opacity so a firefight leaves its ground dusted
 -- instead of wiping clean in half a second. One preset per surface family.
 ('hazesoil','dust','{"count":6,"lifetime":3.0,"size":0.3,"speed":0.5,"color":[0.4,0.32,0.22],"opacity":0.45,"emission":0}'),
 ('hazesand','dust','{"count":6,"lifetime":3.2,"size":0.3,"speed":0.55,"color":[0.64,0.54,0.38],"opacity":0.42,"emission":0}'),
 ('hazerock','dust','{"count":6,"lifetime":2.6,"size":0.28,"speed":0.5,"color":[0.56,0.54,0.51],"opacity":0.45,"emission":0}'),
 ('hazesnow','dust','{"count":5,"lifetime":2.0,"size":0.26,"speed":0.55,"color":[0.86,0.89,0.93],"opacity":0.42,"emission":0}'),
 ('hazeash','dust','{"count":5,"lifetime":2.4,"size":0.26,"speed":0.45,"color":[0.21,0.2,0.19],"opacity":0.42,"emission":0}'),
 -- Thrown material: dark earth clods, grey stone chips, snow chunks, ore, and short sparks off
 -- metal. Ballistic (debris), so they arc and fall rather than drift.
 ('clods','debris','{"count":7,"lifetime":0.9,"size":0.05,"speed":2.6,"color":[0.2,0.16,0.11],"opacity":1,"emission":0}'),
 ('chips','debris','{"count":6,"lifetime":0.7,"size":0.034,"speed":2.9,"color":[0.55,0.54,0.52],"opacity":1,"emission":0}'),
 ('snowclods','debris','{"count":6,"lifetime":0.8,"size":0.045,"speed":2.4,"color":[0.9,0.92,0.95],"opacity":1,"emission":0}'),
 ('orechips','debris','{"count":6,"lifetime":0.8,"size":0.04,"speed":2.6,"color":[0.62,0.46,0.16],"opacity":1,"emission":0.08}'),
 ('armorsparks','debris','{"count":7,"lifetime":0.34,"size":0.024,"speed":3.4,"color":[4,2.4,0.6],"opacity":1,"emission":1}'),
 -- Water: a shell raises a column, not a ring of droplets, and leaves a low mist.
 ('splashcolumn','splash','{"count":14,"lifetime":1.1,"size":0.08,"speed":3.2,"color":[0.72,0.84,0.9],"opacity":0.85,"emission":0.1}'),
 ('watermist','smoke','{"count":3,"lifetime":1.8,"size":0.3,"speed":0.4,"color":[0.78,0.84,0.88],"opacity":0.3,"emission":0}'),
 -- Tesla (vfx.md Epic 7): the discharge crawls over what it struck as short blue-white sparks,
 -- and the coil flares where the bolt left it. Both are brief; the bolt itself is fx/tesla-arc.
 ('teslacrawl','debris','{"count":8,"lifetime":0.3,"size":0.022,"speed":2.2,"color":[1.6,2.4,4.2],"opacity":1,"emission":1}'),
 ('teslacorona','fire','{"count":3,"lifetime":0.18,"size":0.12,"speed":0.6,"color":[1.4,2.0,4.0],"opacity":0.9,"emission":1}'),
 -- Support actions (vfx.md Epic 6: "restrained repair sparks or feedback, no magic healing
 -- lasers"). A medic's heal leaves a few faint motes rising off the soldier; a mechanic's repair
 -- throws a small fountain of weld sparks off the hull. Neither travels from the healer.
 ('mendglow','fire','{"count":5,"lifetime":1.1,"size":0.06,"speed":0.35,"color":[0.9,2.6,1.1],"opacity":0.6,"emission":1}'),
 ('weldspark','debris','{"count":6,"lifetime":0.36,"size":0.028,"speed":1.6,"color":[3.8,3.0,1.8],"opacity":1,"emission":1}'),
 -- Nuclear stages (vfx.md §14, fx/nuclear-strike): the blast-dust front that walks the weapon's
 -- damage rings along the ground, its foam counterpart on water, steam, the cooling smoke that
 -- drifts off ground zero after the column has gone, and embers in the scorch. One puff each;
 -- the stage places and sizes them.
 ('dustfront','dust','{"count":1,"lifetime":2.6,"size":0.34,"speed":0.6,"color":[0.56,0.48,0.36],"opacity":0.5,"emission":0}'),
 ('foam','dust','{"count":1,"lifetime":4.0,"size":0.3,"speed":0.4,"color":[0.9,0.93,0.95],"opacity":0.45,"emission":0}'),
 ('steam','smoke','{"count":1,"lifetime":5.0,"size":0.5,"speed":0.5,"color":[0.85,0.87,0.9],"opacity":0.4,"emission":0}'),
 ('coolsmoke','smoke','{"count":1,"lifetime":7.0,"size":0.5,"speed":0.25,"color":[0.2,0.19,0.19],"opacity":0.45,"emission":0}'),
 ('nukeember','fire','{"count":3,"lifetime":1.3,"size":0.05,"speed":0.5,"color":[3.2,1.1,0.25],"opacity":0.9,"emission":1}'),
 -- A chronoshift: a cold blue-white flash where the unit left and where it arrived (fx chronoFlashes).
 ('chronoflash','fire','{"count":6,"lifetime":0.45,"size":0.22,"speed":0.9,"color":[1.6,2.4,4.6],"opacity":0.85,"emission":1}'),
 -- A GPS satellite launch: the rocket's hot exhaust, and the white smoke it leaves standing (fx supportEffect).
 ('satplume','fire','{"count":2,"lifetime":0.35,"size":0.2,"speed":0.7,"color":[3.6,2.2,0.8],"opacity":0.95,"emission":1}'),
 ('satsmoke','wake','{"count":1,"lifetime":4.2,"size":0.42,"speed":0.05,"color":[0.86,0.86,0.84],"opacity":0.55,"emission":0.02}'),
 -- A sonar pulse: faint cyan rings spreading over the water where it was sent (fx supportEffect).
 ('sonarping','wake','{"count":1,"lifetime":1.8,"size":0.3,"speed":0.9,"color":[0.35,1.5,1.9],"opacity":0.5,"emission":1}'),
 -- Ultra: a spent brass case thrown sideways from a small arm (fx weapon fire).
 ('casing','debris','{"count":1,"lifetime":0.55,"size":0.02,"speed":1.1,"color":[1.3,0.95,0.35],"opacity":1,"emission":0.15}'),
 -- Ultra: splinters and bark off a struck tree or wooden wall (fx spawnStrikeMaterial).
 ('woodchips','debris','{"count":7,"lifetime":0.8,"size":0.045,"speed":2.2,"color":[0.36,0.23,0.12],"opacity":1,"emission":0}'),
 -- Ultra: wet mud from a strike in the shallows: dark clods and a brown spray, not a clear column.
 ('mudclods','debris','{"count":7,"lifetime":0.75,"size":0.055,"speed":2.3,"color":[0.14,0.1,0.06],"opacity":1,"emission":0}'),
 ('mudsplash','splash','{"count":10,"lifetime":0.8,"size":0.075,"speed":2.2,"color":[0.34,0.27,0.18],"opacity":0.85,"emission":0.05}');

-- ------------------------------------------------------------------------------------
-- Weather presets (sky/index.ts).
--
-- `weather_presets` has existed since the first content schema and has NEVER HELD A ROW.
-- `content-db.mjs` selected from it into `content-manifest.json`, the manifest shipped a
-- literal `"weather": []`, and nothing in `src/` imported that key — so this table was an
-- authored surface with no data AND no consumer, which is the same failure this project has
-- already paid for seven times. Both halves are closed here: the rows below are the whole
-- vocabulary, and `sky/index.ts` reads them.
--
-- COLUMN MEANINGS. `sunlight`/`moonlight` are multipliers on the direct beam that the
-- atmospheric model computes for the hour — they are what makes overcast overcast — and
-- `fog_density` is aerial extinction per metre. `rain`/`snow` are precipitation rates in
-- 0..1; the kind the model uses (§4.2: 0 clear, 1 overcast, 2 rain, 3 snow) is DERIVED, so a
-- preset cannot claim to be raining and carry no rain.
--
-- THE FLOOR IS THE POINT. Night was once measured at 5.5% of day luminance and the player's
-- report was "it is dark i cant see anything"; it now sits near 26% and `model.ts` holds
-- that with a floor. A storm at midnight multiplies the storm's 0.16 by the night's already
-- low beam, so the moonlight column is deliberately NOT allowed to collapse with the
-- sunlight column — 0.42 under storm against 0.30 under clear, because an overcast night sky
-- scatters city and moon light back down and is genuinely no darker than a clear one. The
-- model clamps the composed result as well; this table just does not fight it.
--
-- Thunder is not a column, and adding one would be inventing schema for something the data
-- already says: a thunderstorm is heavy rain. `sky/model.ts` derives it from `rain` crossing
-- 0.62, so `storm` thunders and `rain` does not.
INSERT OR IGNORE INTO weather_presets VALUES
 -- id          sunlight moonlight rain  snow  fog_density
 -- A clear day. Not a null preset: it names the reference the other four are scaled against.
 ('clear',        1.00,    0.30,   0.00, 0.00, 0.0015),
 -- Overcast. No precipitation at all, and it still has to read as weather — the whole cue is
 -- that the beam collapses to about half while the sky gets BRIGHTER and cooler, so shadows
 -- go soft and shallow instead of the picture going dark. Moonlight rises for the same
 -- physical reason a cloudy night is lighter than a clear one.
 ('cloudy',       0.52,    0.46,   0.00, 0.00, 0.0080),
 -- Steady rain. Below the thunder threshold on purpose: this is the common wet state, and if
 -- every shower flashed, lightning would stop meaning anything.
 ('rain',         0.34,    0.40,   0.55, 0.00, 0.0180),
 -- Thunderstorm. The darkest preset, and the only one above the 0.62 thunder threshold.
 ('storm',        0.16,    0.42,   0.95, 0.00, 0.0280),
 -- Snow. Brighter than rain at the same coverage because the falling column and the settled
 -- ground both scatter the beam back — snow is the one bad-weather state that raises ground
 -- albedo rather than lowering it.
 ('snow',         0.44,    0.52,   0.00, 0.85, 0.0160);
