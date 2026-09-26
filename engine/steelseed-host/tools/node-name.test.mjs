// A node's name is published as hostName in the public room list.
// Run: node --test node-name.test.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import { publicNodeName } from './roomhost.mjs';

test('a node without --name never publishes the machine hostname', () => {
	assert.equal(publicNodeName(undefined), 'Redline host');
	assert.equal(publicNodeName('   '), 'Redline host');
	assert.notEqual(publicNodeName(undefined), os.hostname());
	assert.equal(publicNodeName('  Rita  '), 'Rita');
	assert.ok(publicNodeName('x'.repeat(200)).length < 200);
});
