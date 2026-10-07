// Serve the canonical, already composed AppBundle on an owned ephemeral port.
// Gates must never pick up a different checkout's long-running dev server.
import { resolve } from 'node:path'
import { WEB_ROOT, stopChild } from './harness.mjs'
import { spawnProcessGroup } from './process-group.mjs'

export async function startComposedPreview() {
	const root = resolve(WEB_ROOT, '../engine/bin-browser/AppBundle')
	const server = spawnProcessGroup(process.execPath, [resolve(WEB_ROOT, '../engine/OpenRA.Browser/tests/server.mjs'),
		'--root', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
	try {
		const origin = await new Promise((resolveReady, reject) => {
			let output = ''
			const timer = setTimeout(() => reject(new Error('Composed preview startup timeout')), 20000)
			server.once('error', error => { clearTimeout(timer); reject(error) })
			server.once('exit', code => { clearTimeout(timer); reject(new Error(`Composed preview exited ${code}`)) })
			server.stdout.on('data', chunk => {
				output += chunk.toString()
				const url = / at (http:\/\/127\.0\.0\.1:\d+)\//.exec(output)?.[1]
				if (url) { clearTimeout(timer); resolveReady(url) }
			})
		})
		return { baseUrl: `${origin}/steelseed/index.html?mode=game&platform=null`, root,
			async close() { await stopChild(server) } }
	} catch (error) { await stopChild(server); throw error }
}
