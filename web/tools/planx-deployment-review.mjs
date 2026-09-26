#!/usr/bin/env node
// Staged MCV/fact material and joint proof using the production renderer.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { WEB_ROOT, launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'

const root = resolve(WEB_ROOT, '..'), studyIndex = process.argv.indexOf('--study')
assert.ok(studyIndex < 0 || (process.argv[studyIndex + 1] && !process.argv[studyIndex + 1].startsWith('--')), '--study requires a path')
const study = resolve(root, studyIndex < 0 ? '.artifacts/planx/deployment' : process.argv[studyIndex + 1]), pack = join(study, 'promotion'), out = join(pack, 'gpu')
mkdirSync(out, { recursive: true })
const read = p => JSON.parse(readFileSync(p)), hash = b => createHash('sha256').update(b).digest('hex')
const contract = read(join(study, 'mechanism-contract.json')), boneCount = contract.boneCount
assert.ok(Number.isInteger(boneCount) && boneCount >= 119 && boneCount <= 256)
assert.ok(study === resolve(root, '.artifacts/planx/deployment') ? boneCount === 119 : boneCount > 119)
const contractKeys = ['boneCount', 'scaleChannels', 'deployedIsBindPose', 'channels']
if ('prefixEnd' in contract) { assert.ok(Number.isFinite(contract.prefixEnd) && contract.prefixEnd > 0 && contract.prefixEnd < 1); contractKeys.push('prefixEnd') }
const manifest = read(join(pack, 'blender/manifest.json')), roster = readFileSync(join(pack, 'blender/roster.ssasset'))
const damage = read(join(pack, 'damage-states/fact/manifest.json')), damageBytes = gunzipSync(readFileSync(join(pack, 'damage-states/fact/states.ssmesh.gz')))
const input = ['mcv', 'fact', 'fact.d3', 'fact.d5'].map(id => {
  const original = id.includes('.') ? damage.states[Number(id.at(-1)) - 1] : manifest.assets[id]
  assert.equal(original.rig.bones.length, boneCount)
  if (id === 'fact') assert.deepEqual(original.deployment, Object.fromEntries(contractKeys.map(k => [k, contract[k]])))
  const source = id.includes('.') ? damageBytes : roster
  const raw = source.subarray(original.offset, original.offset + original.bytes), meta = { ...original, offset: 0 }
  assert.equal(hash(raw), meta.sha256)
  assert.equal(hash(readFileSync(join(pack, 'sources', id + '.blend'))), meta.sourceSha256)
  const maskMeta = id.includes('.') ? manifest.assets.fact.detailMask : meta.detailMask
  let pixels = gunzipSync(readFileSync(join(pack, 'blender', maskMeta.file))), maskSize = maskMeta.size
  assert.equal(hash(pixels), maskMeta.sha256)
  while (maskSize > 128) {
    const side = maskSize / 2, next = new Uint8Array(side * side * 4)
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) for (let c = 0; c < 4; c++) {
      const i = (y * 2 * maskSize + x * 2) * 4 + c
      next[(y * side + x) * 4 + c] = Math.round((pixels[i] + pixels[i + 4] + pixels[i + maskSize * 4] + pixels[i + maskSize * 4 + 4]) / 4)
    }
    pixels = next; maskSize = side
  }
  return { id, meta, raw: Array.from(raw), mask: Array.from(pixels), maskSize, rawHash: hash(raw), maskSha256: maskMeta.sha256 }
})
const injection = await build({ stdin: { contents: "export {decodeBlenderAsset} from './src/units/blender-mesh';export {DeploymentRig} from './src/units/deployment-rig';export {MeshStore} from './src/render/gpumesh';export {computeWorldTransforms,computeSkinMatrices} from './src/geo/rig';", resolveDir: WEB_ROOT }, write: false, bundle: true, platform: 'browser', format: 'iife', globalName: 'deploymentApi', logLevel: 'silent' })
let preview, browser
const errors = []
try {
  preview = await startPreview(8553, process.env.DEPLOYMENT_URL ?? null)
  const launched = await launchGpuBrowser(await loadChromium('planx-deployment-review'), 'planx-deployment-review')
  browser = launched.browser
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 })
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' || m.text().includes('ShaderModule')) errors.push(m.text()) })
  await page.addInitScript(() => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {} })
  await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&quality=low`)
  await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
  await page.addScriptTag({ content: injection.outputFiles[0].text })
  const rows = await page.evaluate(async input => {
    const app = steelseed; app.stop(); app.renderOneFrame(0); app.bridge.pollSnapshot = () => null
    const ctx = app.ctx, renderer = ctx.get('render'), camera = ctx.get('camera'), device = ctx.device, materials = ctx.get('materials')
    if (ctx.backend !== 'webgpu') throw Error('WebGPU required')
    ctx.get('units').shroud = { isVisible() { return true }, stateAt() { return 2 }, unmodelled: false }
    camera.target[0] = camera.targetGoal[0] = 24; camera.target[1] = camera.targetGoal[1] = .9; camera.target[2] = camera.targetGoal[2] = 24
    camera.yawRaw = camera.yawGoal = .7; camera.height = camera.heightGoal = 5
    app.renderOneFrame(1000 / 60); renderer.setShroud(new Uint8Array(48 * 48).fill(2), 48, 48, 0, 0); renderer.probes.updatesPerFrame = 0; renderer.debugView = 0
    const store = new deploymentApi.MeshStore(device), resources = [], rows = []
    for (const item of input) {
      device.pushErrorScope('validation')
      const decoded = deploymentApi.decodeBlenderAsset(new Uint8Array(item.raw), item.meta)
      if (decoded.mesh.validate()) throw Error(decoded.mesh.validate())
      const mesh = store.upload(decoded.mesh, item.id), base = materials.get('industrial-v1')
      const texture = device.createTexture({ label: 'deployment-proof-' + item.id, size: [item.maskSize, item.maskSize], mipLevelCount: Math.log2(item.maskSize) + 1, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      resources.push(texture)
      let pixels = new Uint8Array(item.mask), side = item.maskSize
      for (let mip = 0; ; mip++) {
        device.queue.writeTexture({ texture, mipLevel: mip }, pixels, { bytesPerRow: side * 4, rowsPerImage: side }, [side, side])
        if (side === 1) break
        const next = side / 2, result = new Uint8Array(next * next * 4)
        for (let y = 0; y < next; y++) for (let x = 0; x < next; x++) for (let c = 0; c < 4; c++) {
          const i = (y * 2 * side + x * 2) * 4 + c
          result[(y * next + x) * 4 + c] = Math.round((pixels[i] + pixels[i + 4] + pixels[i + side * 4] + pixels[i + side * 4 + 4]) / 4)
        }
        pixels = result; side = next
      }
      const surface = Object.assign(Object.create(base), { id: 'deployment-proof:' + item.id, detailMaskView: texture.createView() })
      materials.sets.set(surface.id, surface); materials.bindGroupFor(surface)
      const skeleton = decoded.rig.skeleton, pose = skeleton.createPose(), world = skeleton.createMatrixBuffer(), skin = skeleton.createMatrixBuffer()
      const deployment = item.meta.deployment ? new deploymentApi.DeploymentRig(skeleton, item.meta.deployment) : null
      const views = item.id === 'fact' ? [['000', 0, 0, 5], ['025', .25, 0, 5], ['050', .5, 0, 5], ['075', .75, 0, 5], ['100', 1, 0, 5], ['near', 1, 0, 6], ['mid', 1, 1, 12], ['far', 1, 2, 20]] : [['bind', 1, 0, item.id === 'mcv' ? 3 : 5]]
      if (item.id === 'fact' && item.meta.deployment?.prefixEnd !== undefined) views.push(['prefixEnd', item.meta.deployment.prefixEnd, 0, 5])
      for (const [view, progress, lod, height] of views) {
        const drawMesh = { ...mesh, lods: [mesh.lods[lod], mesh.lods[lod], mesh.lods[lod]] }
        camera.target[1] = camera.targetGoal[1] = item.id === 'mcv' ? .45 : .9
        camera.height = camera.heightGoal = height; camera.update(0, ctx)
        let png
        for (let frame = 0; frame < 12; frame++) {
          pose.resetToBind(); if (deployment) deployment.sample(pose, progress)
          deploymentApi.computeWorldTransforms(pose, world); deploymentApi.computeSkinMatrices(skeleton, world, skin)
          const palette = renderer.reserveBones(skeleton.boneCount)
          if (!palette) throw Error('Bone palette reservation failed')
          palette.matrices.set(skin)
          renderer.submit({ mesh: drawMesh, paletteBases: Uint16Array.of(palette.base), boneCount: skeleton.boneCount, surfaceSet: surface.id, instances: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 24, 0, 24, 1), instanceCount: 1, playerColors: Uint8Array.of(0), damages: Float32Array.of(item.id === 'fact.d3' ? .6 : item.id === 'fact.d5' ? 1 : 0), castsShadow: true })
          renderer.historyValid = false; renderer.frameIndex = 0; renderer.lateUpdate(1 / 60, ctx)
          if (frame === 11) { const canvas = document.createElement('canvas'); canvas.width = ctx.canvas.width; canvas.height = ctx.canvas.height; canvas.getContext('2d').drawImage(ctx.canvas, 0, 0); png = canvas.toDataURL() }
        }
        rows.push({ id: item.id, view, progress, lod, cameraHeight: height, png, dropped: renderer.stats.dropped, backend: ctx.backend, quality: ctx.config.q.name, bones: skeleton.boneCount, lodTriangles: mesh.lods.map(l => l.indexCount / 3), materialLayers: base.layerCount, maskSize: item.maskSize, sourceSha256: item.meta.sourceSha256, materialTextureBytes: materials.totalVramBytes, materialCap: ctx.config.q.textureVram, additionalFixtureMaskBytes: 4 * (128 * 128 + 64 * 64 + 32 * 32 + 16 * 16 + 8 * 8 + 4 * 4 + 2 * 2 + 1), modelScale: 1 })
      }
      const gpuError = await device.popErrorScope(); if (gpuError) throw Error(gpuError.message)
    }
    store.dispose(); for (const texture of resources) texture.destroy()
    return rows
  }, input)
  assert.deepEqual(errors, [])
  for (const row of rows) {
    assert.equal(row.dropped, 0); assert.equal(row.bones, boneCount); assert.equal(row.quality, 'low'); assert.equal(row.materialLayers, 30)
    assert.ok(row.materialTextureBytes + input.length * row.additionalFixtureMaskBytes <= row.materialCap)
    writeFileSync(join(out, row.id + '-' + row.view + '.png'), Buffer.from(row.png.split(',')[1], 'base64')); delete row.png
  }
  assert.equal(rows.length, 11 + ('prefixEnd' in contract ? 1 : 0))
  if ('prefixEnd' in contract) assert.equal(rows.find(r => r.id === 'fact' && r.view === 'prefixEnd')?.progress, contract.prefixEnd)
  const report = { status: 'PASS', errors, rows, geometryHashes: input.map(p => ({ id: p.id, sha256: p.rawHash, sourceSha256: p.meta.sourceSha256, maskSha256: p.maskSha256 })), stagedManifestSha256: hash(readFileSync(join(pack, 'blender/manifest.json'))), stagedDamageManifestSha256: hash(readFileSync(join(pack, 'damage-states/fact/manifest.json'))), scope: 'Isolated low-quality production WebGPU decoder, contract-bound DeploymentRig, shared industrial arrays and exact staged masks. Explicit near/mid/far LODs and d3/d5. No timing or ordinary-game integration claims.' }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('DEPLOYMENT_GPU_PASS', rows.length)
} catch (error) {
  writeFileSync(join(out, 'report.json'), JSON.stringify({ status: 'FAIL', errors: [...errors, String(error)] }, null, 2) + '\n')
  throw error
} finally { await browser?.close(); if (preview) await stopChild(preview.server) }
