import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// One authored Steelseed exception, never a replacement for the upstream witness.
export function validateDeploymentTiming(contract, baselineBytes) {
 const baseline = JSON.parse(baselineBytes)
 assert.equal(contract.schema, 1)
 assert.equal(contract.baselineSha256, createHash('sha256').update(baselineBytes).digest('hex'))
 assert.equal(baseline.makeSequenceLengths.fact, 32)
 assert.deepEqual(contract.overrides, [{image:'fact',sequence:'make',baselineFrames:32,appendedFrames:64,frames:96,frameMilliseconds:40}])
 return contract
}

export function effectiveMakeFrames(image, sequence, witnessed, contract) {
 const rule = contract.overrides.find(o => o.image === image && o.sequence === sequence)
 if (!rule) return witnessed
 assert.equal(witnessed, rule.baselineFrames, 'fact.make baseline changed')
 return rule.frames
}
