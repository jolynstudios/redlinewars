# Disabled gates

Gates excluded from the standard 201-command inventory by owner decision. Every tool
stays runnable by hand; nothing here is deleted. Re-enable by restoring the npm script
(and, for file-based gates, the inventory entry) once the listed condition is met.

Owner decisions of 2026-09-19, recorded in the session inventory as `ownerDisabled`.

## vehicleproportiongate

- **Disabled:** 2026-09-19 (owner decision)
- **What it guards:** vehicle proportions against the approved Blender promotion study
- **Why disabled:** the Blender studies were reviewed and approved; the study exports
  are no longer regenerated automatically
- **Manual run:** `node tools/vehicleproportiongate.mjs`
- **Re-enable when:** vehicle models change or a new promotion study is made

## humanstudygate

- **Disabled:** 2026-09-19 (owner decision)
- **What it guards:** MakeHuman infantry proportions against the approved study renders
- **Why disabled:** studies approved; the study export directory was removed earlier
- **Manual run:** `node tools/humanstudygate.mjs`
- **Re-enable when:** infantry models/rigs change or a new human study is made

## deploymentpackagegate

- **Disabled:** 2026-09-19 (owner decision)
- **What it guards:** the MCV → Construction Yard deployment animation study frames
- **Why disabled:** deployment study approved
- **Manual run:** `node tools/deploymentpackagegate.mjs`
- **Re-enable when:** the deployment transform or the MCV/yard models change

## actormaskgate

- **Disabled:** 2026-09-19 (owner decision, option A)
- **What it guards:** the Blender-baked UV1 wear/detail masks (ao, cavity, dirt, wear)
  stay visibly present on vehicle/building materials (cosmetic only, no gameplay role)
- **Why disabled:** KNOWN-RED at fixture level, not product level — the staged
  surface-test scene frames an empty view (45 draws / 125k triangles submitted, all
  staged assets bound, but the camera views bare ground beside the staged cluster).
  The mask shading itself is untested in this state. Fix is estimated at 1–2 hours of
  camera/staging math in `tools/artreview.mjs`.
- **Manual run:** `node tools/actormaskgate.mjs`
- **Re-enable when:** the artreview staging framing regression is fixed

## meadowgate

- **Disabled:** 2026-09-19 (owner decision, option A)
- **What it guards:** decorative grass determinism and behaviour — zero-wind stillness,
  wind sway band, pose hold, fog-of-war obedience, ground-type restriction. Indirectly
  also replay/sync trust in the grass rendering
- **Why disabled:** KNOWN-RED at fixture level, with one open product question: the
  grass window-scan returns unstable instance populations per capture (582/713 and
  1052/528 observed) with the camera parked identically. Either the scenery scan
  lifecycle is nondeterministic (a real bug that would touch replay/sync trust) or the
  fixture's window assumptions are wrong. Fix estimated at 2–3 hours reading the
  scenery registry scan path
- **Manual run:** `node tools/meadowgate.mjs`
- **Re-enable when:** the scan-window population is stabilised (fixture or product fix)

## Removed entirely

- **motiongate.wip.mjs** — deleted 2026-09-19 (commit ce0bed9). Superseded WIP
  diagnostic whose own header documented its zero-diff A/B limitation; the live
  successor is `motiongate.mjs`.
