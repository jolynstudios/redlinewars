type YieldRuntime = {
	scheduler?: { yield?: () => Promise<void> }
	MessageChannel: typeof MessageChannel
}

/** Let rendering and input run between expensive mesh builds, even in a hidden tab. */
export function yieldCooperatively(runtime: YieldRuntime = globalThis as YieldRuntime): Promise<void> {
	if (typeof runtime.scheduler?.yield === 'function') return runtime.scheduler.yield()
	return new Promise(resolve => {
		const channel = new runtime.MessageChannel()
		channel.port1.onmessage = () => {
			channel.port1.close()
			channel.port2.close()
			resolve()
		}
		channel.port2.postMessage(null)
	})
}
