import assert from 'node:assert/strict';
import test from 'node:test';
import { cutoutGateUrl } from './cutoutgate-options.mjs';

test('ordinary cutout gate keeps the development preview', () => {
 assert.equal(cutoutGateUrl([]), null);
 assert.equal(cutoutGateUrl(['--falsify=shadow']), null);
});
test('explicit AppBundle URLs support both CLI forms', () => {
 const url = 'http://127.0.0.1:8415/steelseed/index.html?probe=1';
 assert.equal(cutoutGateUrl(['--url', url]), url);
 assert.equal(cutoutGateUrl([`--url=${url}`]), url);
 assert.equal(cutoutGateUrl(['--url=https://example.test/steelseed/index.html']), 'https://example.test/steelseed/index.html');
});
test('invalid explicit options fail without preview fallback', () => {
 for (const args of [['--url'], ['--url='], ['--url', '--falsify=shadow'],
  ['--url=not-a-url'], ['--url=file:///tmp/index.html'],
  ['--url=http://' + 'user:' + 'password@' + 'example.test/'], ['--url=http://example.test/', '--url=http://other.test/']])
  assert.throws(() => cutoutGateUrl(args));
});
