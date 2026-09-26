// STEELSEED — render barrel.
//
// `main.ts` collects nodes by looking for exported classes carrying a static `id`, so the
// Renderer must be exported from here. The types are re-exported because §12.2 pins them
// and other nodes describe their own data against those shapes — they reach the INSTANCE
// at runtime with ctx.get('render'), never by importing this module (hard rule 3).

export { Renderer } from './renderer'
export type { Camera, DrawItem, GpuMesh, RenderApi } from './types'
export { COLOR_FORMAT, DEPTH_FORMAT } from './targets'
