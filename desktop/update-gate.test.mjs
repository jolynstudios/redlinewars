import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { nodeRefusalNeedsDownload, shellVerdict } from './update-gate.mjs';

test('the shell asks for an update only when the relay lists builds without its own', () => {
	assert.equal(shellVerdict('9dc9b0e8d871', ['9dc9b0e8d871']), false);
	assert.equal(shellVerdict('9dc9b0e8d871', ['aaaaaaaaaaaa']), true);
	assert.equal(shellVerdict('9dc9b0e8d871', []), false, 'no list is no gate');
	assert.equal(shellVerdict('', ['aaaaaaaaaaaa']), false, 'a bundle without build.json is not gated');
});

test('a node refusal asks for a download only when a download would help', () => {
	// The app's own build is accepted: the newest installer is already installed.
	assert.equal(nodeRefusalNeedsDownload({ required: false, reachable: true }), false);
	// The app's own build is refused, or the relay could not be asked at all.
	assert.equal(nodeRefusalNeedsDownload({ required: true, reachable: true }), true);
	assert.equal(nodeRefusalNeedsDownload({ required: false, reachable: false }), true);
});

test('no shell element that starts hidden sets its display inline', () => {
	// An inline display beats the [hidden] attribute: the update modal carried
	// `hidden` + `style="display: flex"` and covered every desktop launch.
	const shellDir = path.join(import.meta.dirname, 'shell');
	for (const file of fs.readdirSync(shellDir).filter(name => name.endsWith('.html'))) {
		const html = fs.readFileSync(path.join(shellDir, file), 'utf8');
		for (const tag of html.match(/<[a-z][^>]*>/gis) ?? []) {
			if (/\shidden(\s|>|=)/i.test(tag) && /style="[^"]*\bdisplay\s*:/i.test(tag))
				assert.fail(`${file}: ${tag.replace(/\s+/g, ' ').slice(0, 120)}…`);
		}
	}
});
