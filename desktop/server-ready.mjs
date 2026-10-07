// Read the actual bound loopback port from this child's listen callback.
// A selected port may be supplied by tests; otherwise the server uses port 0.
export function waitForLocalServer(child, { port, timeoutMs = 15_000 } = {}) {
  let output = '';
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const finish = (error, boundPort) => { cleanup(); error ? reject(error) : resolve(boundPort); };
    const onData = chunk => {
      output = (output + String(chunk)).slice(-65_536);
      for (const match of output.matchAll(/\[server\] serving [^\r\n]* at http:\/\/127\.0\.0\.1:(\d+)\//g)) {
        const bound = Number(match[1]);
        if (bound >= 1 && bound <= 65535 && (port === undefined || port === bound)) return finish(null, bound);
      }
    };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error(`Local game server exited before readiness (${code ?? signal})`));
    const timer = setTimeout(() => finish(new Error('Local game server did not become ready')), timeoutMs);
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode != null || child.signalCode != null) onExit(child.exitCode, child.signalCode);
  });
}
