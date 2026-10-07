// STEELSEED — launch-argument allowlist (T2.7; fixes A19, X7).
//
// The page query string is NOT a free-form engine command line. On loopback
// origins (127.0.0.1 / localhost — the desktop shell, the dev harness and
// every gate) every pair passes through exactly as before: ?Player.Name=…,
// ?Launch.Map=… and ?Host.*=… are engine launch arguments (legacy driver
// contract, consumed by Main). Anywhere else — the public site — only a
// sanitised ?Player.Name survives: the value is reduced to letters, numbers,
// space and _ . - and clamped to 24 characters, so a crafted shared link
// (?Host.WsEndpoint=wss://evil.test/x&Game.Mod=cnc) changes nothing on the
// machine that opens it.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const UNSAFE_NAME = /[^\p{L}\p{N} _.\-]/gu

export function launchArgsFromQuery(search, hostname) {
	const pairs = [...new URLSearchParams(search ?? '')]
	if (LOOPBACK_HOSTS.has(String(hostname ?? ''))) {
		return pairs.map(([key, value]) => `${key}=${value}`)
	}
	return pairs
		.filter(([key]) => key === 'Player.Name')
		.map(([key, value]) => `${key}=${String(value).replace(UNSAFE_NAME, '').slice(0, 24)}`)
}
