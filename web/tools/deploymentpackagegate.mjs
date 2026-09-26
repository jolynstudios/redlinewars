// OWNER-DISABLED from the standard inventory (2026-09-19): the Blender studies this
// gate compares against were reviewed and approved by the owner. The tool stays
// runnable for manual verification; re-enable in the inventory when models change.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const root = new URL('../..', import.meta.url).pathname
const studyIndex = process.argv.indexOf('--study')
assert.ok(studyIndex < 0 || (process.argv[studyIndex + 1] && !process.argv[studyIndex + 1].startsWith('--')), '--study requires a path')
const study = resolve(root, studyIndex < 0 ? '.artifacts/planx/deployment' : process.argv[studyIndex + 1])
const out = join(study, 'promotion') + '/'
const read = p => JSON.parse(readFileSync(p))
const sha = b => createHash('sha256').update(b).digest('hex')
const contract = read(join(study, 'mechanism-contract.json')), boneCount = contract.boneCount
assert.ok(Number.isInteger(boneCount) && boneCount >= 119 && boneCount <= 256)
assert.ok(study === resolve(root, '.artifacts/planx/deployment') ? boneCount === 119 : boneCount > 119)
const contractKeys = ['boneCount', 'scaleChannels', 'deployedIsBindPose', 'channels']
if ('prefixEnd' in contract) { assert.ok(Number.isFinite(contract.prefixEnd) && contract.prefixEnd > 0 && contract.prefixEnd < 1); contractKeys.push('prefixEnd') }
const plan = read(out + 'promotion-plan.json')
const roster = read(out + 'blender/manifest.json')
const bytes = readFileSync(out + 'blender/roster.ssasset')
const result = await build({ stdin: { contents: "export {decodeBlenderAsset} from './src/units/blender-mesh'; export {DeploymentRig} from './src/units/deployment-rig'; export {Pose} from './src/geo/rig'", resolveDir: root + '/web' }, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
const module = { exports: {} }
new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports)
const { decodeBlenderAsset, DeploymentRig, Pose } = module.exports
assert.equal(sha(bytes), roster.sha256)
assert.deepEqual(gunzipSync(readFileSync(out + 'blender/roster.ssasset.gz')), bytes)
for (const row of plan.unchangedRosterPayloads) {
  const entry = roster.assets[row.id]
  assert.equal(sha(bytes.subarray(entry.offset, entry.offset + entry.bytes)), row.sha256)
  assert.deepEqual({ ...entry, offset: row.metadata.offset }, row.metadata, row.id + ' metadata unchanged')
}
for (const [path, hash] of Object.entries(plan.expectedCurrentFiles)) {
  if (hash === null) { assert.equal(existsSync(root + '/' + path), false, 'new target must remain absent'); continue }
  assert.equal(sha(readFileSync(root + '/' + path)), hash, 'canonical guard ' + path)
  assert.equal(sha(readFileSync(out + 'baseline/files/' + path)), hash, 'immutable backup ' + path)
}
for (const [path, hash] of Object.entries({ ...plan.unchangedMaskFiles, ...plan.unchangedDamageFiles })) assert.equal(sha(readFileSync(root + '/web/.forge/' + path)), hash, 'unrelated file ' + path)
for (const preview of plan.sourceBoundPreviews) {
  const file = preview.direction ? `damage-states/fact/renders/${preview.id}.${preview.direction}.png` : `blender/previews/${preview.id}.png`
  assert.equal(sha(readFileSync(out + file)), preview.sha256)
  assert.equal(sha(readFileSync(out + 'sources/' + preview.id + '.blend')), preview.sourceSha256)
}
const rows = []
for (const actor of ['mcv', 'fact']) {
  const entry = roster.assets[actor]
  const decoded = decodeBlenderAsset(bytes, entry)
  assert.equal(decoded.mesh.validate(), null)
  assert.equal(decoded.rig.skeleton.boneCount, boneCount)
  assert.ok(Array.from(decoded.rig.capturedVertices).every(n => n > 0), 'every actual source bone owns geometry')
  assert.equal(sha(readFileSync(out + 'sources/' + actor + '.blend')), entry.sourceSha256)
  assert.equal(sha(readFileSync(out + 'blender/scenes/' + actor + '.blend')), entry.sourceSha256)
  const mask = entry.detailMask
  assert.equal(mask.sourceSha256, entry.sourceSha256)
  assert.equal(sha(gunzipSync(readFileSync(out + 'blender/' + mask.file))), mask.sha256)
  assert.equal(entry.deploymentNativeScale, 1)
  if (actor === 'fact') {
    assert.deepEqual(entry.deployment, Object.fromEntries(contractKeys.map(k => [k, contract[k]])))
    const rig = new DeploymentRig(decoded.rig.skeleton, entry.deployment)
    const pose = new Pose(decoded.rig.skeleton)
    for (let i = 0; i <= 160; i++) {
      pose.resetToBind()
      rig.sample(pose, i / 160)
      assert.ok(pose.t.every(Number.isFinite) && pose.r.every(Number.isFinite))
      assert.ok(pose.s.every(n => n === 1))
      if (i === 0 || i === 160) for (const c of entry.deployment.channels) {
        const t = i ? c.bindTranslationM : c.foldedTranslationM
        const r = i ? c.bindRotationQuat : c.foldedRotationQuat
        for (let a = 0; a < 3; a++) assert.ok(Math.abs(pose.t[c.index * 3 + a] - t[a]) < 1e-6)
        let dot = 0
        for (let a = 0; a < 4; a++) dot += pose.r[c.index * 4 + a] * r[a]
        assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-6)
      }
    }
    const changed = structuredClone(entry.deployment)
    changed.channels[0].bindTranslationM[0] += .01
    assert.throws(() => new DeploymentRig(decoded.rig.skeleton, changed), 'stale source bind contract must fail')
  } else assert.equal(entry.deployment, undefined, 'native transport uses its own folded rig')
  rows.push({ id: actor, triangles: entry.triangles, vertices: entry.vertices, bytes: entry.bytes, bones: decoded.rig.skeleton.boneCount, sourceSha256: entry.sourceSha256, maskSourceBound: true })
}
const damageRows = []
if (plan.damage) {
  const damage = read(out + 'damage-states/fact/manifest.json')
  const raw = readFileSync(out + 'damage-states/fact/states.ssmesh')
  assert.equal(sha(raw), damage.sha256)
  assert.deepEqual(gunzipSync(readFileSync(out + 'damage-states/fact/states.ssmesh.gz')), raw)
  const parent = roster.assets.fact
  const authors = read(out + 'damage-states/fact/states.author.json')
  assert.equal(damage.parentSourceSha256, parent.sourceSha256)
  assert.equal(damage.states.length, 5)
  for (let i = 0; i < 5; i++) {
    const entry = damage.states[i], author = authors[i], actor = 'fact.d' + (i + 1)
    const decoded = decodeBlenderAsset(raw, entry)
    assert.equal(decoded.mesh.validate(), null)
    assert.ok(Array.from(decoded.rig.capturedVertices).every(n => n > 0))
    assert.deepEqual(entry.rig.bones, parent.rig.bones)
    assert.equal(sha(raw.subarray(entry.offset, entry.offset + entry.bytes)), entry.sha256)
    assert.equal(sha(readFileSync(out + 'sources/' + actor + '.blend')), entry.sourceSha256)
    assert.equal(entry.sourceSha256, author.sourceSha256)
    assert.equal(author.parentSourceSha256, parent.sourceSha256)
    assert.equal(author.maskSha256, parent.detailMask.sha256)
    assert.equal(author.UVPreserved, true)
    assert.equal(entry.detailMask, undefined, 'exact parent UV/mask inherited')
    assert.equal(entry.sourcePath, 'art/blender/assets/' + actor + '.blend')
    damageRows.push({ id: actor, triangles: entry.triangles, vertices: entry.vertices, bytes: entry.bytes, bones: decoded.rig.skeleton.boneCount, sourceSha256: entry.sourceSha256, inheritedMaskSha256: author.maskSha256 })
  }
}
const report = { passed: true, scope: plan.damage ? 'intact and damage package; live GPU and coordinator review pending' : 'intact package only; damage and live GPU gates pending', rows, damageRows, actualSkeletonConstructor: true, sampledPoses: 161, sourceBindNegativeControl: true, unchangedRosterPayloads: plan.unchangedRosterPayloads.length, unchangedMaskFiles: Object.keys(plan.unchangedMaskFiles).length, unchangedDamageFiles: Object.keys(plan.unchangedDamageFiles).length }
writeFileSync(out + 'intact-package-gate.json', JSON.stringify(report, null, 2) + '\n')
if (plan.damage) writeFileSync(out + 'package-gate.json', JSON.stringify(report, null, 2) + '\n')
console.log('DEPLOYMENT_PACKAGE_PASS', JSON.stringify(report))
