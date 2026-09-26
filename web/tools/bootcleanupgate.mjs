#!/usr/bin/env node
// Production App/Registry/Input/EventBus; recording DOM/backend, no browser or dist writes.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bundle = await build({ stdin: { contents: `export { App } from './src/core/app.ts'`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { App } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const names = ['navigator', 'window', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
const originalDispose = App.prototype.dispose, originalError = console.error
const checks = [], secondaryReports = []
let capturedApp
App.prototype.dispose = function () { capturedApp = this; return originalDispose.call(this) }
const flatten = error => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error]

async function scenario(options = {}) {
  const { stage = 'init-async', throwing = false, loggingThrows = false } = options
  const reason = 'reason' in options ? options.reason : new Error(stage)
  const trace = [], observers = [], frames = new Map(), nodes = [], cleanupErrors = []
  let context, eventHits = 0, allocations = 0, sequence = 0
  capturedApp = undefined
  const target = label => ({
    listeners: new Map(), added: 0, removed: 0,
    addEventListener(type, fn, opts) {
      if (stage === 'attach' && label === 'window') throw reason
      let list = this.listeners.get(type)
      if (!list) this.listeners.set(type, list = new Map())
      assert.ok(!list.has(fn)); list.set(fn, opts); this.added++
    },
    removeEventListener(type, fn, opts) {
      const list = this.listeners.get(type)
      assert.ok(list?.has(fn), `${label}/${type} removes an attached listener`)
      assert.equal(list.get(fn), opts); list.delete(fn); this.removed++
    },
  })
  const win = target('window'), canvas = Object.assign(target('canvas'), {
    clientWidth: 640, clientHeight: 360, width: 300, height: 150,
    getContext(kind) { assert.equal(kind, 'webgl2'); return {} },
  })
  const bindings = {
    navigator: {}, window: win,
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.disconnects = 0; observers.push(this) }
      observe(observed) {
        assert.equal(observed, canvas)
        if (stage === 'observe') throw reason
        this.callback() // Includes real resize during the partial-initialization window.
      }
      disconnect() { this.disconnects++ }
    },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { assert.ok(frames.delete(id)) },
  }
  for (const [name, value] of Object.entries(bindings)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  console.error = (...args) => {
    assert.equal(args[0], '[app] failed boot cleanup'); secondaryReports.push(args[1])
    assert.deepEqual(flatten(args[1]), cleanupErrors)
    if (loggingThrows) throw new Error('logger failed too')
  }
  function system(id, deps) {
    return class {
      static id = id
      static deps = deps
      constructor() {
        if (stage === 'constructor' && id === 'b') throw reason
        nodes.push(this); this.id = id; this.releases = 0; this.allocated = false
      }
      init(ctx) {
        context = ctx; trace.push(`init:${id}`)
        assert.equal(ctx.snapshot, null); assert.equal(ctx.prevSnapshot, null)
        assert.equal(ctx.session.available, false)
        this.allocated = true; allocations++
        ctx.events.on('cleanup-gate', () => eventHits++)
        if (id === 'b' && stage === 'init-sync') throw reason
        if (id === 'b' && stage === 'init-async') return Promise.reject(reason)
      }
      prewarm() {
        trace.push(`prewarm:${id}`)
        if (id === 'b' && stage === 'prewarm-sync') throw reason
        if (id === 'b' && stage === 'prewarm-async') return Promise.reject(reason)
      }
      dispose() {
        trace.push(`dispose:${id}`); this.releases++
        for (const dep of deps) assert.ok(context.has(dep), 'dependency still registered during reverse cleanup')
        if (this.allocated) { this.allocated = false; allocations-- }
        if (throwing) { const error = new Error(`dispose:${id}`); cleanupErrors.push(error); throw error }
      }
    }
  }
  const A = system('a', []), B = system('b', ['a']), C = system('c', ['b'])
  const systems = stage === 'duplicate' ? [A, A] : stage === 'missing-dependency' ? [B] : [C, B, A]
  const progress = []
  let error, rejected = false, app
  try {
    app = await App.boot({ canvas, systems, deterministic: true, onProgress(label) {
      progress.push(label)
      if (stage === `progress:${label}`) throw reason
    } })
  } catch (caught) { rejected = true; error = caught }
  if (stage === 'success') {
    assert.equal(rejected, false); assert.equal(capturedApp, undefined, 'successful boot does not dispose')
    assert.equal(allocations, 3); assert.equal(canvas.added + win.added, 10)
    context.events.emit('cleanup-gate'); assert.equal(eventHits, 3)
    assert.deepEqual(progress, ['selecting backend', 'loading a', 'loading b', 'loading c', 'prewarming pipelines', 'prewarming pipelines', 'prewarming pipelines', 'ready'])
    app.start(); assert.equal(frames.size, 1)
    if (throwing) assert.throws(() => app.dispose(), caught => {
      assert.deepEqual(flatten(caught), cleanupErrors); return true
    })
    else app.dispose()
  } else {
    assert.equal(rejected, true, stage)
    if (stage === 'duplicate') assert.match(error.message, /duplicate id/)
    else if (stage === 'missing-dependency') assert.match(error.message, /unregistered/)
    else assert.equal(error, reason, 'original rejection identity preserved, including non-Error values')
  }
  assert.ok(capturedApp, 'failure cleanup uses App.dispose')
  assert.equal(allocations, 0)
  assert.deepEqual(trace.filter(s => s.startsWith('dispose:')), nodes.map(n => `dispose:${n.id}`).reverse())
  assert.ok(nodes.every(n => n.releases === 1), 'every constructed/partially initialized node disposed exactly once')
  if (stage.startsWith('init')) assert.ok(!trace.some(s => s.startsWith('prewarm:')))
  if (stage.startsWith('prewarm')) assert.ok(!trace.includes('prewarm:c'), 'prewarm stops at original rejection')
  for (const t of [canvas, win]) {
    assert.equal(t.added, t.removed)
    assert.ok([...t.listeners.values()].every(list => list.size === 0))
  }
  assert.ok(observers.every(o => o.disconnects === 1)); assert.equal(capturedApp.resizeObserver, null)
  assert.equal(frames.size, 0)
  assert.deepEqual(capturedApp.registry.systemIds, [])
  for (const id of ['a', 'b', 'c']) assert.equal(capturedApp.registry.peek(id), null)
  const previousHits = eventHits
  context?.events.emit('cleanup-gate'); assert.equal(eventHits, previousHits, 'event bus cleared despite throwing node disposal')
  capturedApp.dispose(); capturedApp.registry.dispose(); capturedApp.start()
  assert.equal(frames.size, 0, 'disposed app cannot restart')
  assert.ok(nodes.every(n => n.releases === 1)); assert.ok(observers.every(o => o.disconnects === 1))
  checks.push(`${stage}; throwingDisposers=${throwing}; reason=${String(reason)}; loggingThrows=${loggingThrows}`)
}

try {
  for (const stage of ['init-sync', 'init-async', 'prewarm-sync', 'prewarm-async', 'constructor',
    'progress:loading b', 'progress:prewarming pipelines', 'progress:ready', 'attach', 'observe',
    'duplicate', 'missing-dependency', 'success']) {
    for (const throwing of [false, true]) await scenario({ stage, throwing })
  }
  for (const reason of [undefined, null, 0, 'primitive rejection']) await scenario({ reason, throwing: true })
  await scenario({ stage: 'init-async', throwing: true, loggingThrows: true })
  assert.ok(secondaryReports.length > 0, 'cleanup failures remain visible separately from original rejection')
  console.log('bootcleanupgate: PASS', JSON.stringify({ cases: checks.length, secondaryReports: secondaryReports.length,
    checks, limitation: 'Recording DOM/backend with real lifecycle code; no GPU allocation/device-loss or real-browser proof. A disposer that throws before releasing its own resources remains responsible for those resources.' }))
} finally {
  App.prototype.dispose = originalDispose; console.error = originalError
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
}
