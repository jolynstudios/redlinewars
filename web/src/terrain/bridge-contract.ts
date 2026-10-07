import CONTRACT from './hero-bridge.json'
import type { Ctx, Snapshot } from '../core'
export { CONTRACT as HERO_BRIDGE }
export type BridgeState = 'intact' | 'partial' | 'dead'
export interface BridgeLandmark { readonly id:number; readonly x:number; readonly z:number; readonly state:BridgeState }
export function bridgeState(health:number):BridgeState {return health===0?'dead':health<128?'partial':'intact'}
export function bridgeContains(b:BridgeLandmark,x:number,z:number):boolean {return Math.abs(x-b.x)<4 && Math.abs(z-b.z)<2.5}
export function bridgeSupportHeight(b:BridgeLandmark,x:number,z:number):number|null {
 const lx=x-b.x,lz=z-b.z-CONTRACT.meshOffsetM[2];if(Math.abs(lx)>4)return null
 const gap=lx>CONTRACT.failedBayX[0]&&lx<CONTRACT.failedBayX[1]
 if(lz>=CONTRACT.healthyLaneZ[0]&&lz<=CONTRACT.healthyLaneZ[1]&&!(b.state==='dead'&&gap))return 0
 if(lz>=CONTRACT.failedLaneZ[0]&&lz<=CONTRACT.failedLaneZ[1]&&!(b.state!=='intact'&&gap))return 0
 return null
}
export function bridgeCellVisible(snap:Snapshot,x:number,z:number):boolean {
 const world=snap.world;if(!world)return false;const w=world.boundsRight-world.boundsLeft
 const index=(Math.floor(z)-world.boundsTop)*w+Math.floor(x)-world.boundsLeft
 for(const run of snap.shroud)if(index>=run.cellIndex&&index<run.cellIndex+run.runLength)return run.state===2
 return false
}
/** Keeps the last witnessed state under fog; full terrain updates never reveal hidden damage. */
export class BridgeKnowledge {
 readonly known=new Map<number,BridgeLandmark>();private tick=-1
 observe(snap:Snapshot,ctx:Ctx):boolean {
  let changed=false;if(snap.tick<this.tick){this.known.clear();changed=true}this.tick=snap.tick
  const actors=snap.actors;if(!actors)return changed
  for(let i=0;i<actors.count;i++){
   if(ctx.actorTypeName(actors.typeId[i])!==CONTRACT.actor)continue
   const x=actors.posX[i]/1024,z=actors.posY[i]/1024
   let visible=false;for(let dz=-2;dz<=2&&!visible;dz++)for(let dx=-3;dx<=3;dx++)if(bridgeCellVisible(snap,x+dx,z+dz)){visible=true;break}
   if(!visible)continue
   const state=bridgeState(actors.health[i]),old=this.known.get(actors.id[i]);if(old&&old.x===x&&old.z===z&&old.state===state)continue
   this.known.set(actors.id[i],{id:actors.id[i],x,z,state});changed=true
  }
  return changed
 }
}
