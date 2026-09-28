import type { TacticalState } from './model'
export type TacticalFrame = Omit<TacticalState,'terrain'|'heights'|'visibility'> & { grid?: string; baseSequence?: number; cells?: number[] }
const LIMIT = 512 * 512
/** Pack only the already player-filtered cells. Baselines plus patches avoid retransmitting the map. */
export function encodeFrame(state: TacticalState, previous: TacticalState | null): TacticalFrame {
 const {terrain,heights,visibility,...facts} = state
 const same = previous && previous.session === state.session && JSON.stringify(previous.bounds) === JSON.stringify(state.bounds)
 if (!same || state.sequence % 25 === 0) {
  const bytes = new Uint8Array(terrain.length * 3)
  for (let i=0;i<terrain.length;i++) { bytes[i*3]=terrain[i]; bytes[i*3+1]=heights[i]; bytes[i*3+2]=visibility[i] }
  let binary=''; for(let i=0;i<bytes.length;i+=16384) binary+=String.fromCharCode(...bytes.subarray(i,i+16384))
  return {...facts,grid:btoa(binary)}
 }
 const cells:number[]=[]
 for(let i=0;i<terrain.length;i++) if (terrain[i]!==previous.terrain[i] || heights[i]!==previous.heights[i] || visibility[i]!==previous.visibility[i]) cells.push(i,terrain[i],heights[i],visibility[i])
 if(cells.length>terrain.length/2)return encodeFrame(state,null)
 return {...facts,baseSequence:previous.sequence,cells}
}
export function decodeFrame(frame: TacticalFrame, previous: TacticalState | null): TacticalState | null {
 const count=frame.bounds?.w*frame.bounds?.h
 if(frame.schema!==1 || !Number.isSafeInteger(frame.sequence) || frame.sequence<1 || !Number.isSafeInteger(frame.bounds?.w) || !Number.isSafeInteger(frame.bounds?.h) || frame.bounds.w<1 || frame.bounds.h<1 || !Number.isSafeInteger(count) || count<1 || count>LIMIT) return null
 let terrain:number[], heights:number[], visibility:number[]
 if(typeof frame.grid==='string') {
  let bytes: string; try { bytes=atob(frame.grid) } catch { return null }; if(bytes.length!==count*3) return null
  terrain=new Array(count); heights=new Array(count); visibility=new Array(count)
  for(let i=0;i<count;i++){terrain[i]=bytes.charCodeAt(i*3);heights[i]=bytes.charCodeAt(i*3+1);visibility[i]=bytes.charCodeAt(i*3+2);if(visibility[i]>2)return null}
 } else {
  if(!previous || previous.session!==frame.session || previous.sequence!==frame.baseSequence || JSON.stringify(previous.bounds)!==JSON.stringify(frame.bounds) || previous.terrain.length!==count || !Array.isArray(frame.cells) || frame.cells.length%4!==0) return null
  // An unchanged grid retains its identity: terrain caches do no work during unit-only updates.
  terrain=frame.cells.length?previous.terrain.slice():previous.terrain;heights=frame.cells.length?previous.heights.slice():previous.heights;visibility=frame.cells.length?previous.visibility.slice():previous.visibility
  for(let i=0;i<frame.cells.length;i+=4){const index=frame.cells[i];if(!Number.isInteger(index)||index<0||index>=count) return null;if(!frame.cells.slice(i+1,i+4).every(n=>Number.isInteger(n)&&n>=0&&n<=255)||frame.cells[i+3]>2) return null;terrain[index]=frame.cells[i+1];heights[index]=frame.cells[i+2];visibility[index]=frame.cells[i+3]}
 }
 const {grid,baseSequence,cells,...facts}=frame
 return {...facts,terrain,heights,visibility}
}
