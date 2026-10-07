import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { waitForLocalServer } from './server-ready.mjs';

const child = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null, signalCode: null });
test('waits for this child on the selected port, including split output', async () => {
  const c = child(); let ready = false;
  const promise = waitForLocalServer(c, { port: 18078 }).then(() => { ready = true; });
  c.stdout.write('[server] serving /bundle at http://127.0.0.1:18077/\n');
  await Promise.resolve(); assert.equal(ready, false);
  c.stdout.write('[server] serving /bundle at http://127.0.0.1:');
  c.stdout.write('18078/\n'); await promise;
  assert.equal(ready, true); assert.equal(c.listenerCount('exit'), 0); assert.equal(c.stdout.listenerCount('data'), 0);
});
test('early error, early exit and timeout fail instead of declaring the engine ready', async () => {
  for (const mode of ['error', 'exit', 'timeout']) {
    const c = child(); const p = waitForLocalServer(c, { port: 18077, timeoutMs: 10 });
    if (mode === 'error') c.emit('error', new Error('launch failed'));
    if (mode === 'exit') c.emit('exit', 1, null);
    await assert.rejects(p); assert.equal(c.listenerCount('error'), 0); assert.equal(c.stdout.listenerCount('data'), 0);
  }
});

test('returns the ephemeral port printed by the child', async () => {
  const c = child();
  const promise = waitForLocalServer(c);
  c.stdout.write('[server] serving /bundle at http://127.0.0.1:43817/\n');
  assert.equal(await promise, 43817);
});
