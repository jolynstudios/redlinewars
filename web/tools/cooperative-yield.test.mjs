import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MessageChannel } from 'node:worker_threads'
import { yieldCooperatively } from '../src/units/cooperative-yield.ts'

test('uses scheduler.yield when available', async () => {
	let calls = 0
	await yieldCooperatively({
		scheduler: { yield: async () => { calls++ } },
		MessageChannel: class { constructor() { throw new Error('fallback used') } },
	})
	assert.equal(calls, 1)
})

test('MessageChannel fallback resolves asynchronously without a timer', async () => {
	let resumed = false
	const pending = yieldCooperatively({ MessageChannel }).then(() => { resumed = true })
	assert.equal(resumed, false)
	await pending
	assert.equal(resumed, true)
})
