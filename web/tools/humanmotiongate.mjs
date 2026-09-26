#!/usr/bin/env node
// In-memory module bundle, mocked same-origin fetch and real saved artifacts. No build outputs.
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { build } from 'esbuild'
import ts from 'typescript'

const web = resolve(import.meta.dirname, '..'), game = resolve(web, '..')
const hash = value => createHash('sha256').update(value).digest('hex')
const actual = JSON.parse(readFileSync(resolve(web, '.forge/human-motion/manifest.json')))
const binding = JSON.parse(readFileSync(resolve(web, '.forge/human-lods/manifest.json')))
const stored = readFileSync(resolve(web, '.forge/human-motion/walk.ssanim.gz'))
const raw = gunzipSync(stored, { maxOutputLength: 257 * 20 * 7 * 4 })
const clipBytes = Object.fromEntries(actual.clips.map(clip => {
  const packed = readFileSync(resolve(web, '.forge/human-motion', clip.file))
  return [clip.file, { stored: packed, raw: gunzipSync(packed, { maxOutputLength: 257 * 20 * 7 * 4 }) }]
}))
const clipUrl = file => `/assets/${file.replace('.ssanim.gz', '')}-gate.gz`
const url = '/assets/walk.ssanim-gate.gz', slots = { manifest: {}, pack: {} }
const savedFetch = globalThis.fetch, savedLocation = globalThis.location
globalThis.location = { href: 'http://localhost/humanmotiongate', origin: 'http://localhost' }
globalThis.__humanMotionGateSlots = slots
let responseBytes = stored, responseStatus = 200, requests = 0
const served = new Map()
globalThis.fetch = async requested => {
  assert.ok(requested === url || served.has(requested), 'Never fetch external references or saved Blender sources')
  requests++
  if (requested !== url) return new Response(served.get(requested), { status: responseStatus })
  return new Response(responseBytes, { status: responseStatus })
}
const bundle = await build({ stdin: { contents: `
  export * from './src/units/human-motion.ts'
  export { Pose, Skeleton } from './src/geo/rig.ts'
`, resolveDir: web }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  define: { 'import.meta.glob': '__gateGlob' }, banner: { js: `const __gateGlob = pattern => globalThis.__humanMotionGateSlots[pattern.endsWith('manifest.json') ? 'manifest' : 'pack'];` } })
const { loadHumanMotion, verifyHumanMotionPack, validateHumanMotionPose, sampleHumanMotion,
  verifyHumanMotionTimedClip, loadHumanMotionTimedClips, overlayHumanMotionClip, humanMotionClipUrl, Pose, Skeleton } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const checks = [], check = async (name, run) => { await run(); checks.push(name) }
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`)
const poseFor = clip => { const pose = new Pose(new Skeleton(clip.manifest.rig.bones)); validateHumanMotionPose(clip, pose); return pose }
const withPayload = (manifest, bytes) => {
  const compressed = gzipSync(bytes)
  return { manifest: { ...manifest, bytes: bytes.length, storedBytes: compressed.length, sha256: hash(bytes) }, compressed }
}
try {
  await check('absent/incomplete loader globs; no fetch', async () => {
    assert.equal(await loadHumanMotion(binding), null)
    slots.manifest['../../.forge/human-motion/manifest.json'] = actual
    await assert.rejects(() => loadHumanMotion(binding), /Incomplete/)
    delete slots.manifest['../../.forge/human-motion/manifest.json']
    slots.pack['../../.forge/human-motion/walk.ssanim.gz'] = url
    await assert.rejects(() => loadHumanMotion(binding), /Incomplete/)
    delete slots.pack['../../.forge/human-motion/walk.ssanim.gz']; assert.equal(requests, 0)
  })
  let clip
  await check('actual gzip loader + source/parent/model SHA audits', async () => {
    assert.equal(stored.length, actual.storedBytes); assert.equal(raw.length, actual.bytes); assert.equal(hash(raw), actual.sha256)
    for (const [path, sha] of [[actual.sourcePath, actual.sourceSha256], [binding.parentSourcePath, actual.parentSourceSha256],
      [binding.levels[0].sourcePath, actual.modelSourceSha256]]) {
      const absolute = realpathSync(resolve(game, path))
      assert.ok(absolute.startsWith(realpathSync(resolve(game, 'art/blender')) + sep))
      assert.equal(hash(readFileSync(absolute)), sha, `Saved source mismatch: ${path}`)
    }
    const lock = JSON.parse(readFileSync(resolve(game, 'art/sources.lock.json')))
    for (const source of actual.externalSources) {
      const pinned = lock.sources.find(s => s.id === source.id); assert.ok(pinned)
      for (const key of ['sha256', 'url', 'license']) assert.equal(source[key], pinned[key])
    }
    slots.manifest['../../.forge/human-motion/manifest.json'] = actual
    slots.pack['../../.forge/human-motion/walk.ssanim.gz'] = url
    for (const clip of actual.clips) {
      const served_url = clipUrl(clip.file)
      slots.pack[`../../.forge/human-motion/${clip.file}`] = served_url
      served.set(served_url, clipBytes[clip.file].stored)
    }
    responseBytes = stored
    clip = await loadHumanMotion(binding)
    assert.equal(clip.frames, 33); assert.equal(clip.samples, 32); assert.equal(clip.boneCount, 20)
    assert.equal(clip.data.byteLength, actual.bytes); assert.equal(requests, 1)
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    for (let i = 0; i < clip.data.length; i++) assert.equal(clip.data[i], view.getFloat32(i * 4, true))
    poseFor(clip)
  })
  await check('host-decompressed bytes accepted; canonical rig key order', async () => {
    responseBytes = raw
    const reordered = structuredClone(binding)
    reordered.levels[0].rig = Object.fromEntries(Object.entries(reordered.levels[0].rig).reverse())
    const decoded = await verifyHumanMotionPack(actual, url, reordered)
    assert.deepEqual(decoded.data, clip.data)
  })

  const negatives = [
    ['schema', m => { m.schema = 2 }], ['id', m => { m.id = 'other' }],
    ['frame count', m => { m.frames-- }], ['fractional samples', m => { m.samples = 32.5 }],
    ['too few samples', m => { m.samples = 7; m.frames = 8 }], ['too many samples', m => { m.samples = 257; m.frames = 258 }],
    ['bone count', m => { m.boneCount = 19 }], ['channel layout', m => { m.channels = 'rotation-only' }],
    ['byte count', m => { m.bytes += 4 }], ['stored budget', m => { m.storedBytes = 10000000 }],
    ['stored zero', m => { m.storedBytes = 0 }], ['hash shape', m => { m.sha256 = 'bad' }],
    ['compression', m => { m.compression = 'raw' }], ['pack name', m => { m.file = 'other.gz' }],
    ['zero stride', m => { m.strideM = 0 }], ['negative stride', m => { m.strideM = -.19 }],
    ['nan stride', m => { m.strideM = NaN }], ['unbounded stride', m => { m.strideM = 11 }],
    ['stance', m => { m.stanceFraction = 1 }], ['source traversal', m => { m.sourcePath = 'art/blender/../bad.blend' }],
    ['source hash', m => { m.sourceSha256 = 'bad' }], ['missing refs', m => { m.externalSources = [] }],
    ['duplicate refs', m => { m.externalSources.push(m.externalSources[0]) }],
    ['unknown license', m => { m.externalSources[0].license = 'unknown' }],
    ['rig count', m => { m.rig.bones.pop() }], ['duplicate bone', m => { m.rig.bones[1].name = m.rig.bones[0].name }],
    ['parent order', m => { m.rig.bones[1].parent = 2 }], ['bind translation', m => { m.rig.bones[1].pos[0] = NaN }],
    ['bind rotation', m => { m.rig.bones[1].rot = [0, 0, 0, 0] }],
    ['bind scale', m => { m.rig.bones[1].scale = [1, 0, 1] }],
    ['rig stride', m => { m.rig.strideM = .2 }],
    ['parent binding', (m, e) => { e.parentSourceSha256 = '0'.repeat(64) }],
    ['model binding', (m, e) => { e.levels[0].sourceSha256 = '0'.repeat(64) }],
    ['lower LOD rig', (m, e) => { e.levels[2].rig.bones[3].name = 'wrong' }],
    ['missing LOD', (m, e) => { e.levels.pop() }],
  ]
  for (const [name, mutate] of negatives) await check(`prefetch reject: ${name}`, async () => {
    const m = structuredClone(actual), e = structuredClone(binding); mutate(m, e)
    const before = requests
    await assert.rejects(() => verifyHumanMotionPack(m, url, e)); assert.equal(requests, before)
  })
  await check('external/data URL rejected before fetch', async () => {
    const before = requests
    for (const other of ['https://example.com/walk.ssanim.gz', '//example.com/a', 'data:application/gzip;base64,AA=='])
      await assert.rejects(() => verifyHumanMotionPack(actual, other, binding), /same-origin/)
    assert.equal(requests, before)
  })
  for (const [name, mutate, pattern] of [
    ['nonfinite sample', b => b.writeFloatLE(NaN, 0), /Non-finite/],
    ['translation bounds', b => b.writeFloatLE(11, 0), /translation out of bounds/],
    ['zero quaternion', b => b.fill(0, 12, 28), /quaternion/],
    ['quaternion norm', b => b.writeFloatLE(2, 12), /quaternion/],
    ['translation endpoint', b => b.writeFloatLE(.5, actual.samples * actual.boneCount * 28), /loop mismatch/],
    ['rotation endpoint', b => { const at = actual.samples * actual.boneCount * 28 + 12; b.fill(0, at, at + 16); b.writeFloatLE(1, at) }, /loop mismatch/],
  ]) await check(`integrity-valid malformed payload: ${name}`, async () => {
    const bytes = Buffer.from(raw); mutate(bytes); const changed = withPayload(actual, bytes)
    responseBytes = changed.compressed
    await assert.rejects(() => verifyHumanMotionPack(changed.manifest, url, binding), pattern)
  })
  await check('bad SHA, compressed size, decompressed size, HTTP and corrupt gzip', async () => {
    responseBytes = stored
    await assert.rejects(() => verifyHumanMotionPack({ ...actual, sha256: '0'.repeat(64) }, url, binding), /SHA-256/)
    await assert.rejects(() => verifyHumanMotionPack({ ...actual, storedBytes: actual.storedBytes + 1 }, url, binding), /size/)
    responseBytes = raw.subarray(4)
    await assert.rejects(() => verifyHumanMotionPack(actual, url, binding), /size/)
    responseStatus = 404
    await assert.rejects(() => verifyHumanMotionPack(actual, url, binding), /HTTP 404/)
    responseStatus = 200; responseBytes = Buffer.from(stored); responseBytes[responseBytes.length - 5] ^= 255
    await assert.rejects(() => verifyHumanMotionPack(actual, url, binding))
  })

  // Deliberately alternate quaternion signs; endpoint is -q0 (same orientation).
  const synthetic = Buffer.alloc(actual.bytes)
  for (let f = 0; f < actual.frames; f++) for (let b = 0; b < actual.boneCount; b++) {
    const angle = f / actual.samples * Math.PI * 2, sign = f % 2 ? -1 : 1, offset = (f * actual.boneCount + b) * 28
    synthetic.writeFloatLE(Math.sin(angle) * .02, offset)
    synthetic.writeFloatLE(Math.sin(angle / 2) * sign, offset + 20)
    synthetic.writeFloatLE(Math.cos(angle / 2) * sign, offset + 24)
  }
  const generated = withPayload(actual, synthetic); responseBytes = generated.compressed
  const syntheticClip = await verifyHumanMotionPack(generated.manifest, url, binding)
  await check('known midpoint: shortest hemisphere, normalized nlerp, translation plus bind', () => {
    const pose = poseFor(syntheticClip), beforeScale = pose.s.slice()
    sampleHumanMotion(syntheticClip, pose, syntheticClip.strideM / syntheticClip.samples / 2)
    for (let b = 0; b < syntheticClip.boneCount; b++) {
      near(pose.t[b * 3], pose.skeleton.bindT[b * 3] + Math.sin(2 * Math.PI / 32) * .01)
      near(pose.r[b * 4 + 2], Math.sin(Math.PI / 64)); near(pose.r[b * 4 + 3], Math.cos(Math.PI / 64))
    }
    assert.deepEqual(pose.s, beforeScale)
  })
  await check('actual endpoints, all interval midpoints, wrap, negative phase, stable pause and scales', () => {
    const pose = poseFor(clip), other = poseFor(clip), bytesBefore = hash(clip.data)
    pose.s.fill(1.25); const scale = pose.s.slice(), tRef = pose.t, rRef = pose.r, sRef = pose.s
    for (let f = 0; f < clip.samples; f++) {
      sampleHumanMotion(clip, pose, (f + .5) / clip.samples * clip.strideM)
      for (let b = 0; b < clip.boneCount; b++) {
        const a = (f * clip.boneCount + b) * 7, z = a + clip.boneCount * 7
        for (let c = 0; c < 3; c++) near(pose.t[b * 3 + c], pose.skeleton.bindT[b * 3 + c] + (clip.data[a + c] + clip.data[z + c]) / 2)
        const qa = Array.from(clip.data.subarray(a + 3, a + 7)), qb = Array.from(clip.data.subarray(z + 3, z + 7))
        const sign = qa.reduce((s, x, c) => s + x * qb[c], 0) < 0 ? -1 : 1
        const q = qa.map((x, c) => (x + sign * qb[c]) / 2), norm = Math.hypot(...q)
        for (let c = 0; c < 4; c++) near(pose.r[b * 4 + c], q[c] / norm)
      }
    }
    for (const distance of [0, clip.strideM, -clip.strideM, clip.strideM * 2]) {
      sampleHumanMotion(clip, pose, distance); sampleHumanMotion(clip, other, 0)
      assert.deepEqual(pose.t, other.t); assert.deepEqual(pose.r, other.r)
    }
    sampleHumanMotion(clip, pose, -.023); sampleHumanMotion(clip, other, clip.strideM - .023)
    assert.deepEqual(pose.t, other.t); assert.deepEqual(pose.r, other.r)
    sampleHumanMotion(clip, pose, .047); const t = pose.t.slice(), r = pose.r.slice()
    for (let i = 0; i < 10000; i++) sampleHumanMotion(clip, pose, .047)
    assert.deepEqual(pose.t, t); assert.deepEqual(pose.r, r)
    sampleHumanMotion(clip, pose, Number.MAX_VALUE)
    assert.ok(pose.t.every(Number.isFinite) && pose.r.every(Number.isFinite))
    assert.deepEqual(pose.s, scale); assert.equal(pose.t, tRef); assert.equal(pose.r, rRef); assert.equal(pose.s, sRef)
    assert.equal(hash(clip.data), bytesBefore)
    for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => sampleHumanMotion(clip, pose, bad), /finite/)
  })
  await check('boot pose rejects dimension/name/parent/bind mismatch', () => {
    assert.throws(() => validateHumanMotionPose(clip, new Pose(new Skeleton([{ name: 'root' }]))), /dimensions/)
    for (const mutate of [p => { p.skeleton.names[1] = 'wrong' }, p => { p.skeleton.parent[1] = -1 }, p => { p.skeleton.bindT[3] += 1 },
      p => { p.skeleton.bindR[4] = .5 }, p => { p.skeleton.bindS[3] = 2 }]) {
      const pose = poseFor(clip); mutate(pose); assert.throws(() => validateHumanMotionPose(clip, pose), /mismatch/)
    }
  })
  await check('sampler AST contains no allocating operations on valid-call path', () => {
    const source = ts.createSourceFile('human-motion.ts', readFileSync(resolve(web, 'src/units/human-motion.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    const fn = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'sampleHumanMotion'); assert.ok(fn)
    // Math.sqrt reviewed: quaternion normaliser, components <= 1 by construction, IEEE-exact
    // (deterministic), and explicitly chosen over hypot because V8 does not inline the
    // 4-argument form on this per-bone per-actor per-frame path. See human-motion.ts:247.
    const calls = new Set(['Number.isFinite', 'Math.min', 'Math.floor', 'Math.hypot', 'Math.sqrt'])
    function visit(node) {
      assert.ok(!ts.isArrayLiteralExpression(node) && !ts.isObjectLiteralExpression(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isSpreadElement(node))
      if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), 'Error', 'Only exceptional invalid-input path may construct')
      if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(source)), `Unreviewed sampler call: ${node.getText(source)}`)
      ts.forEachChild(node, visit)
    }
    visit(fn.body)
  })
  let timed, recoil
  await check('timed clips load, bind outside their mask, and carry their own provenance', async () => {
    timed = await loadHumanMotionTimedClips(clip)
    assert.equal(timed.length, actual.clips.length)
    assert.deepEqual(timed.map(c => c.entry.id).sort(), ['infantry-aim-v1', 'infantry-fire-v1'])
    const owned = new Set(actual.upperBodyBones)
    assert.ok(!owned.has(0), 'A clip must never own the pelvis')
    for (const name of ['thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'foot_l', 'foot_r'])
      assert.ok(!owned.has(actual.rig.bones.findIndex(b => b.name === name)), `${name} must stay on the walk`)
    for (const one of timed) {
      const entry = actual.clips.find(c => c.id === one.entry.id)
      const bytes = clipBytes[entry.file]
      assert.equal(bytes.stored.length, entry.storedBytes); assert.equal(bytes.raw.length, entry.bytes)
      assert.equal(hash(bytes.raw), entry.sha256)
      assert.equal(one.data.byteLength, entry.bytes)
      assert.deepEqual(Array.from(one.bones), actual.upperBodyBones)
      const view = new DataView(bytes.raw.buffer, bytes.raw.byteOffset, bytes.raw.byteLength)
      for (let i = 0; i < one.data.length; i++) assert.equal(one.data[i], view.getFloat32(i * 4, true))
      for (let f = 0; f < one.frames; f++) for (let b = 0; b < one.boneCount; b++) {
        if (owned.has(b)) continue
        const at = (f * one.boneCount + b) * 7
        for (let c = 0; c < 3; c++) near(one.data[at + c], 0)
        for (let c = 3; c < 6; c++) near(one.data[at + c], 0)
        near(Math.abs(one.data[at + 6]), 1)
      }
    }
  })
  await check('overlay: zero weight, clamped ends, wrapped loop, exact frames, no leg writes', () => {
    const aim = timed.find(c => c.entry.id === 'infantry-aim-v1')
    const fire = timed.find(c => c.entry.id === 'infantry-fire-v1')
    assert.equal(aim.loop, false); assert.equal(fire.loop, true)
    const pose = poseFor(clip), reference = poseFor(clip)
    sampleHumanMotion(clip, pose, .047); sampleHumanMotion(clip, reference, .047)
    const tRef = pose.t, rRef = pose.r, scale = pose.s.slice()
    overlayHumanMotionClip(aim, pose, .2, 0)
    assert.deepEqual(pose.t, reference.t); assert.deepEqual(pose.r, reference.r)
    overlayHumanMotionClip(aim, pose, 0, 1)
    for (const bone of actual.upperBodyBones) for (let c = 0; c < 3; c++)
      near(pose.t[bone * 3 + c], pose.skeleton.bindT[bone * 3 + c])
    // Everything outside the mask is exactly what the walk wrote, at any weight or time.
    const legs = ['thigh_l', 'calf_r', 'foot_l', 'chassis'].map(n => actual.rig.bones.findIndex(b => b.name === n))
    for (const seconds of [0, .1, .55, 4, -3]) {
      sampleHumanMotion(clip, pose, .047)
      overlayHumanMotionClip(aim, pose, seconds, 1)
      for (const bone of legs) {
        for (let c = 0; c < 3; c++) assert.equal(pose.t[bone * 3 + c], reference.t[bone * 3 + c])
        for (let c = 0; c < 4; c++) assert.equal(pose.r[bone * 4 + c], reference.r[bone * 4 + c])
      }
    }
    // A one-shot clip holds its last frame; a looping pulse wraps to its first.
    const held = poseFor(clip), late = poseFor(clip)
    sampleHumanMotion(clip, held, 0); sampleHumanMotion(clip, late, 0)
    overlayHumanMotionClip(aim, held, aim.durationS, 1); overlayHumanMotionClip(aim, late, aim.durationS * 9, 1)
    assert.deepEqual(held.t, late.t); assert.deepEqual(held.r, late.r)
    const start = poseFor(clip), wrapped = poseFor(clip), negative = poseFor(clip)
    sampleHumanMotion(clip, start, 0); sampleHumanMotion(clip, wrapped, 0); sampleHumanMotion(clip, negative, 0)
    overlayHumanMotionClip(fire, start, 0, 1); overlayHumanMotionClip(fire, wrapped, fire.durationS * 3, 1)
    overlayHumanMotionClip(fire, negative, -fire.durationS * 2, 1)
    assert.deepEqual(start.t, wrapped.t); assert.deepEqual(start.r, wrapped.r)
    assert.deepEqual(start.t, negative.t); assert.deepEqual(start.r, negative.r)
    // Every authored sample is reproduced exactly at its own instant.
    for (let f = 0; f <= aim.samples; f++) {
      sampleHumanMotion(clip, pose, .047)
      overlayHumanMotionClip(aim, pose, f / aim.samples * aim.durationS, 1)
      for (const bone of actual.upperBodyBones) {
        const at = (Math.min(f, aim.samples) * aim.boneCount + bone) * 7
        for (let c = 0; c < 3; c++) near(pose.t[bone * 3 + c], pose.skeleton.bindT[bone * 3 + c] + aim.data[at + c])
        const norm = Math.hypot(aim.data[at + 3], aim.data[at + 4], aim.data[at + 5], aim.data[at + 6])
        const sign = pose.r[bone * 4 + 3] * aim.data[at + 6] < 0 ? -1 : 1
        for (let c = 0; c < 4; c++) near(pose.r[bone * 4 + c], sign * aim.data[at + 3 + c] / norm, 1e-5)
      }
    }
    assert.deepEqual(pose.s, scale); assert.equal(pose.t, tRef); assert.equal(pose.r, rRef)
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => overlayHumanMotionClip(aim, pose, bad, 1), /finite/)
      assert.throws(() => overlayHumanMotionClip(aim, pose, 1, bad), /finite/)
    }
  })
  await check('recoil is a bounded weapon impulse that returns to the aim, measured at the muzzle', () => {
    const fire = timed.find(c => c.entry.id === 'infantry-fire-v1')
    const aim = timed.find(c => c.entry.id === 'infantry-aim-v1')
    const bones = actual.rig.bones, hand = bones.findIndex(b => b.name === 'hand_r')
    const mul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]
    const spin = (q, v) => {
      const t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])]
      return [v[0] + q[3] * t[0] + q[1] * t[2] - q[2] * t[1], v[1] + q[3] * t[1] + q[2] * t[0] - q[0] * t[2],
        v[2] + q[3] * t[2] + q[0] * t[1] - q[1] * t[0]]
    }
    // The weapon rides hand_r, so what a viewer sees is the COMPOSED chain, not one channel.
    // Reading hand_r's local rotation alone reports 2.5 deg for a 6.7 deg muzzle rise.
    const chain = (one, frame) => {
      const rotation = [], position = []
      for (let i = 0; i < bones.length; i++) {
        const at = (frame * one.boneCount + i) * 7
        const offset = [bones[i].pos[0] + one.data[at], bones[i].pos[1] + one.data[at + 1], bones[i].pos[2] + one.data[at + 2]]
        const local = [one.data[at + 3], one.data[at + 4], one.data[at + 5], one.data[at + 6]]
        if (bones[i].parent === undefined) { rotation.push(local); position.push(offset); continue }
        const p = bones[i].parent, turned = spin(rotation[p], offset)
        rotation.push(mul(rotation[p], local))
        position.push([position[p][0] + turned[0], position[p][1] + turned[1], position[p][2] + turned[2]])
      }
      return { rotation, position }
    }
    // Recover the muzzle's fixed offset inside the weapon hand from the aim clip's own report.
    const aimed = chain(aim, aim.samples), q = aimed.rotation[hand]
    const reported = aim.entry.report.muzzleM
    const relative = spin([-q[0], -q[1], -q[2], q[3]],
      [reported[0] - aimed.position[hand][0], reported[1] - aimed.position[hand][1], reported[2] - aimed.position[hand][2]])
    const muzzleAt = frame => {
      const state = chain(fire, frame), turned = spin(state.rotation[hand], relative)
      return [state.position[hand][0] + turned[0], state.position[hand][1] + turned[1], state.position[hand][2] + turned[2]]
    }
    const angleAt = frame => {
      const a = chain(fire, frame).rotation[hand], b = chain(fire, 0).rotation[hand]
      return 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI
    }
    const start = muzzleAt(0), end = muzzleAt(fire.samples)
    let rise = 0, riseFrame = 0, back = 0, dip = 0
    for (let f = 0; f <= fire.samples; f++) {
      const m = muzzleAt(f)
      if (m[1] - start[1] > rise) { rise = m[1] - start[1]; riseFrame = f }
      back = Math.max(back, start[0] - m[0])
      dip = Math.min(dip, m[1] - start[1])
    }
    // acos has unbounded slope at 1, so float32 sample noise reads as hundredths of a degree.
    assert.ok(angleAt(fire.samples) < .05, `Recoil must end on the aim pose: ${angleAt(fire.samples)}`)
    for (let c = 0; c < 3; c++) near(end[c], start[c], 2e-5)
    const stature = .363
    assert.ok(rise / stature > .02 && rise / stature < .12,
      `Muzzle rise must read at gameplay zoom without becoming a cartoon: ${(rise / stature * 100).toFixed(2)}% of stature`)
    assert.ok(back > .001 && back < .02, `Rearward travel into the shoulder out of range: ${back}`)
    assert.ok(dip < 0, 'The shooter must drive the muzzle back down through the sight line, not float up to it')
    const peakSeconds = riseFrame / fire.samples * fire.durationS
    assert.ok(peakSeconds > .02 && peakSeconds < .10, `Recoil must peak within tens of ms: ${peakSeconds}`)
    assert.ok(fire.durationS <= .6, 'Recovery must sit inside a real rifle split time')
    // The aim clip must actually shoulder the weapon: the muzzle has to travel a long way up.
    const readyMuzzle = (() => {
      const state = chain(aim, 0), turned = spin(state.rotation[hand], relative)
      return [state.position[hand][0] + turned[0], state.position[hand][1] + turned[1], state.position[hand][2] + turned[2]]
    })()
    assert.ok((reported[1] - readyMuzzle[1]) / stature > .10,
      'Aim must lift the muzzle from the ready by more than a tenth of the figure')
    recoil = { muzzleRiseM: rise, muzzleRiseStatureFraction: rise / stature, rearwardM: back,
      undershootM: dip, peakSeconds, aimMuzzleLiftM: reported[1] - readyMuzzle[1],
      handRotationPeakDeg: Math.max(...Array.from({ length: fire.samples + 1 }, (_, f) => angleAt(f))) }
  })
  const clipNegatives = [
    ['empty bone mask', m => { m.upperBodyBones = [] }],
    ['pelvis in mask', m => { m.upperBodyBones = [0, ...m.upperBodyBones] }],
    ['unsorted mask', m => { m.upperBodyBones = [...m.upperBodyBones].reverse() }],
    ['mask out of range', m => { m.upperBodyBones = [...m.upperBodyBones.slice(0, -1), 20] }],
    ['clip id shape', m => { m.clips[0].id = 'walk' }],
    ['duplicate clip id', m => { m.clips[1].id = m.clips[0].id }],
    ['clip file shape', m => { m.clips[0].file = '../aim.ssanim.gz' }],
    ['clip file collides with the walk', m => { m.clips[0].file = m.file }],
    ['clip byte count', m => { m.clips[0].bytes += 4 }],
    ['clip frame count', m => { m.clips[0].frames++ }],
    ['clip duration zero', m => { m.clips[0].durationS = 0 }],
    ['clip duration absurd', m => { m.clips[0].durationS = 9 }],
    ['clip loop type', m => { m.clips[0].loop = 'yes' }],
    ['clip hash shape', m => { m.clips[0].sha256 = 'bad' }],
    ['too many clips', m => { m.clips = [...m.clips, ...m.clips, ...m.clips] }],
  ]
  for (const [name, mutate] of clipNegatives) await check(`clip metadata reject: ${name}`, async () => {
    const m = structuredClone(actual); mutate(m)
    const before = requests
    await assert.rejects(() => verifyHumanMotionPack(m, url, binding)); assert.equal(requests, before)
  })
  await check('clip payload rejects out-of-mask motion, a lying loop flag and a dead transition', async () => {
    const fireEntry = actual.clips.find(c => c.id === 'infantry-fire-v1')
    const aimEntry = actual.clips.find(c => c.id === 'infantry-aim-v1')
    const thigh = actual.rig.bones.findIndex(b => b.name === 'thigh_l')
    const serve = (entry, bytes) => {
      const compressed = gzipSync(bytes)
      const patched = { ...entry, bytes: bytes.length, storedBytes: compressed.length, sha256: hash(bytes) }
      const m = structuredClone(actual)
      m.clips = actual.clips.map(c => c.id === entry.id ? patched : c)
      const target = clipUrl(entry.file) + '-mutated'
      served.set(target, compressed)
      return [m, m.clips.find(c => c.id === entry.id), target]
    }
    const moved = Buffer.from(clipBytes[fireEntry.file].raw)
    moved.writeFloatLE(.05, (2 * actual.boneCount + thigh) * 28)
    let [m, entry, target] = serve(fireEntry, moved)
    await assert.rejects(() => verifyHumanMotionTimedClip(m, entry, target), /outside its declared mask/)
    const broken = Buffer.from(clipBytes[fireEntry.file].raw)
    const spine = actual.upperBodyBones[0]
    broken.writeFloatLE(.02, (fireEntry.samples * actual.boneCount + spine) * 28)
    ;[m, entry, target] = serve(fireEntry, broken)
    await assert.rejects(() => verifyHumanMotionTimedClip(m, entry, target), /does not close/)
    const inert = Buffer.from(clipBytes[aimEntry.file].raw)
    for (let f = 0; f < aimEntry.frames; f++)
      inert.set(clipBytes[aimEntry.file].raw.subarray(0, actual.boneCount * 28), f * actual.boneCount * 28)
    ;[m, entry, target] = serve(aimEntry, inert)
    await assert.rejects(() => verifyHumanMotionTimedClip(m, entry, target), /ends where it started/)
    await assert.rejects(() => verifyHumanMotionTimedClip(actual, { ...aimEntry }, clipUrl(aimEntry.file)),
      /not part of this manifest/)
    for (const other of ['https://example.com/aim.ssanim.gz', 'data:application/gzip;base64,AA=='])
      await assert.rejects(() => verifyHumanMotionTimedClip(actual, aimEntry, other), /same-origin/)
  })
  await check('overlay AST contains no allocating operations on valid-call path', () => {
    const source = ts.createSourceFile('human-motion.ts', readFileSync(resolve(web, 'src/units/human-motion.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    const fn = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'overlayHumanMotionClip'); assert.ok(fn)
    // Same reviewed Math.sqrt as the sampler allowlist above: quaternion normaliser on
    // the per-bone overlay path, IEEE-exact, chosen over non-inlined hypot. See human-motion.ts:247.
    const calls = new Set(['Number.isFinite', 'Math.min', 'Math.floor', 'Math.hypot', 'Math.sqrt'])
    function visit(node) {
      assert.ok(!ts.isArrayLiteralExpression(node) && !ts.isObjectLiteralExpression(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isSpreadElement(node))
      if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), 'Error', 'Only exceptional invalid-input path may construct')
      if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(source)), `Unreviewed overlay call: ${node.getText(source)}`)
      ts.forEachChild(node, visit)
    }
    visit(fn.body)
  })
  console.log('humanmotiongate: PASS', JSON.stringify({ checks: checks.length, metadataNegativeCases: negatives.length,
    actual: { frames: clip.frames, samples: clip.samples, bones: clip.boneCount, rawBytes: clip.data.byteLength, storedBytes: stored.length, sha256: actual.sha256 },
    clips: timed.map(c => ({ id: c.entry.id, samples: c.samples, durationS: c.durationS, loop: c.loop, storedBytes: c.entry.storedBytes })),
    maskedBones: actual.upperBodyBones.length, recoil,
    limitation: 'CPU loader/sampler and static allocation audit; no GPU integration, locomotion contacts or caller distance/scale interpolation proof.' }))
} finally {
  globalThis.fetch = savedFetch
  if (savedLocation === undefined) delete globalThis.location; else globalThis.location = savedLocation
  delete globalThis.__humanMotionGateSlots
}
