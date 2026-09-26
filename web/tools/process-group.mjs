// STEELSEED — tools/process-group
// Own a spawned process tree as one POSIX process group, and do not report it stopped
// merely because the direct wrapper process exited before its descendants.

import { spawn, spawnSync } from 'node:child_process'

const DEFAULT_GRACE_MS = 2000
const DEFAULT_KILL_WAIT_MS = 2000
const POLL_MS = 25

export function spawnProcessGroup(command, args, options = {}) {
	return spawn(command, args, {
		...options,
		// A detached POSIX child becomes leader of a new process group. Windows has no
		// negative-PID group signalling, so retain direct-child behaviour there.
		detached: process.platform !== 'win32',
	})
}

/**
 * Stop a child and every descendant that retained its process group.
 *
 * Returns the signal that completed shutdown, or null when the tree was already gone.
 * The group is polled directly: waiting only for `child` is insufficient when an npm
 * wrapper exits before the Vite/Node process it spawned.
 */
export async function stopProcessGroup(child, options = {}) {
	if (child == null || !Number.isSafeInteger(child.pid) || child.pid <= 0)
		return null

	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
	const killWaitMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS
	const target = signalTree(child, 'SIGTERM')
	if (target == null)
		return null
	if (await waitForTreeExit(child, target, graceMs))
		return 'SIGTERM'

	const killed = signalTree(child, 'SIGKILL', target)
	if (killed == null)
		return 'SIGTERM'
	if (!await waitForTreeExit(child, killed, killWaitMs))
		throw new Error(`process ${target === 'group' ? 'group ' : ''}${child.pid} survived SIGKILL`)
	return 'SIGKILL'
}

function signalTree(child, signal, preferredTarget = null) {
	// Windows does not have POSIX process groups and child.kill() only reaches
	// the direct process.  That left roomhost's dedicated-server descendants
	// alive after integration tests (and can do the same after an Electron
	// host shutdown).  taskkill /T is the native process-tree equivalent; /F
	// is required because Node maps SIGTERM to forced termination on Windows
	// anyway, so there is no graceful signal semantics to preserve here.
	if (process.platform === 'win32') {
		if (child.exitCode != null || child.signalCode != null)
			return null
		const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
			stdio: 'ignore',
			windowsHide: true,
		})
		if (result.status === 0)
			return 'child'
	}

	if (preferredTarget !== 'child' && process.platform !== 'win32') {
		try {
			process.kill(-child.pid, signal)
			return 'group'
		} catch (error) {
			if (error?.code !== 'ESRCH')
				throw error
		}
	}

	if (child.exitCode != null || child.signalCode != null)
		return null
	try {
		return child.kill(signal) ? 'child' : null
	} catch (error) {
		if (error?.code === 'ESRCH')
			return null
		throw error
	}
}

async function waitForTreeExit(child, target, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (treeIsAlive(child, target)) {
		const remaining = deadline - Date.now()
		if (remaining <= 0)
			return false
		await new Promise(resolveWait => setTimeout(resolveWait, Math.min(POLL_MS, remaining)))
	}
	return true
}

function treeIsAlive(child, target) {
	if (target === 'child')
		return child.exitCode == null && child.signalCode == null
	try {
		process.kill(-child.pid, 0)
		return true
	} catch (error) {
		if (error?.code === 'ESRCH')
			return false
		if (error?.code === 'EPERM')
			return true
		throw error
	}
}
