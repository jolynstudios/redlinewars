import test from 'node:test';
import assert from 'node:assert/strict';
import { dedicatedServerEnv } from './roomhost.mjs';

test('dedicated game servers inherit runtime paths but not host credentials', () => {
	const parent = {
		PATH: '/bin', HOME: '/tmp/redline', REDLINE_NODE_FIXTURE_RUNNER: '1',
		REDLINE_NODE_TOKEN: 'owner-secret', REDLINE_NODE_KEY: 'node-identity',
		STEELSEED_SPINE_TOKEN: 'legacy-spine', NODE_TOKEN: 'legacy-node',
		AWS_SECRET_ACCESS_KEY: 'cloud-secret', AWS_ACCESS_KEY_ID: 'cloud-id',
		CUSTOM_CREDENTIAL: 'unknown-secret', REDLINE_RANKED_INBOX: '/private/replay-inbox',
		GITHUB_TOKEN: 'git-secret',
	};
	const child = dedicatedServerEnv(parent, '/mods');
	assert.deepEqual(child, {
		PATH: '/bin', HOME: '/tmp/redline', REDLINE_NODE_FIXTURE_RUNNER: '1',
		MOD_SEARCH_PATHS: '/mods', REDLINE_BIND: 'loopback',
	});
	assert.equal(parent.REDLINE_NODE_TOKEN, 'owner-secret', 'the node keeps its own relay credential');
});
