// A supplied URL lets this diagnostic exercise the packaged AppBundle renderer.
// An invalid explicit URL must never fall back to the development preview.
export function cutoutGateUrl(args) {
 const supplied = args.filter(arg => arg === '--url' || arg.startsWith('--url='));
 if (supplied.length === 0) return null;
 if (supplied.length !== 1) throw new Error('cutoutgate: provide --url once');
 const flag = supplied[0];
 const value = flag === '--url' ? args[args.indexOf(flag) + 1] : flag.slice(6);
 if (!value || value.startsWith('--')) throw new Error('cutoutgate: --url requires a URL');
 const url = new URL(value);
 if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
  throw new Error('cutoutgate: --url must be an HTTP(S) URL without credentials');
 return url.href;
}
