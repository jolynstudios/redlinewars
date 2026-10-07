import assert from 'node:assert/strict'
import test from 'node:test'
import { hasBattleLoad } from './battle-load.mjs'

test('battle qualification requires four armies of fifty', () => {
	assert.equal(hasBattleLoad([[0, 35], [1, 45]]), false, 'old 80-unit bot peak is insufficient')
	assert.equal(hasBattleLoad([[0, 200]]), false, 'total unit count cannot replace four armies')
	assert.equal(hasBattleLoad([[0, 50], [0, 50], [0, 50], [0, 50]]), false, 'each army must have a different owner')
	assert.equal(hasBattleLoad([[0, 50], [1, 50], [2, 50], [3, 49]]), false)
	assert.equal(hasBattleLoad([[0, 50], [1, 50], [2, 50], [3, 50]]), true)
})
