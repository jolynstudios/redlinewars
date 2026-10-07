// Real shipping host, with explicit test data installed into its in-memory VFS
// before initialization. Never writes the AppBundle or injects simulation state.
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {performance} from 'node:perf_hooks'

export async function bootVfsRuntime(prepare = () => {}, bundle = resolve(import.meta.dirname,'../../bin-browser/AppBundle')) {
 globalThis.document = {getElementById:()=>null}
 const {dotnet} = await import(pathToFileURL(resolve(bundle,'_framework/dotnet.js')).href)
 const api = await dotnet.withDiagnosticTracing(false).create()
 await prepare(api.Module.FS)
 const config = api.getConfig(), exports = await api.getAssemblyExports(config.mainAssemblyName)
 const program = exports.OpenRA.Program
 if (await api.runMain(config.mainAssemblyName,[]) !== 0) throw Error('Fixture host failed initialization: '+program.HostStatus())
 const {createSteelseedBridge} = await import(pathToFileURL(resolve(bundle,'openra-steelseed-bridge.js')).href)
 return {program,bridge:createSteelseedBridge(program,api.localHeapViewU8),pump:()=>program.Frame(performance.now())}
}
