import { HeaderFlag, type Snapshot } from '../core'
import type { ShroudApi } from './types'

interface KnownWall { id:number; name:string; x:number; z:number }
/** Neighbor knowledge is retained under fog and refreshed only in visible cells. */
export class WallConnections {
 private readonly cells=new Map<string,KnownWall>()
 readonly masks=new Map<number,number>()
 sync(snapshot:Snapshot,names:ReadonlyMap<number,string|null>,shroud:ShroudApi):void {
  if(snapshot.flags & HeaderFlag.terrainStaticPresent){this.cells.clear();this.masks.clear()}
  for(const [key,wall] of this.cells)if(shroud.isVisible(wall.x,wall.z)){this.cells.delete(key);this.masks.delete(wall.id)}
  const actors=snapshot.actors
  if(actors)for(let i=0;i<actors.count;i++){
   const name=names.get(actors.typeId[i]);if(name!=='sbag'&&name!=='brik')continue
   const x=Math.floor(actors.posX[i]/1024),z=Math.floor(actors.posY[i]/1024)
   if(shroud.isVisible(x,z))this.cells.set(`${x},${z}`,{id:actors.id[i],name,x,z})
  }
  const frozen=snapshot.frozenActors
  if(frozen)for(let i=0;i<frozen.count;i++){
   const name=names.get(frozen.typeId[i]);if(name!=='sbag'&&name!=='brik')continue
   const x=Math.floor(frozen.posX[i]/1024),z=Math.floor(frozen.posY[i]/1024),key=`${x},${z}`
   if(shroud.stateAt(x,z)===1&&!this.cells.has(key))this.cells.set(key,{id:frozen.id[i],name,x,z})
  }
  for(const wall of this.cells.values()) {
   if(!shroud.isVisible(wall.x,wall.z)&&this.masks.has(wall.id))continue
   const {x,z,name}=wall
   // WithWallSpriteBody joins identical connector types, independently of owner.
   const mask=(this.cells.get(`${x},${z-1}`)?.name===name?1:0)|(this.cells.get(`${x+1},${z}`)?.name===name?2:0)|
    (this.cells.get(`${x},${z+1}`)?.name===name?4:0)|(this.cells.get(`${x-1},${z}`)?.name===name?8:0)
   this.masks.set(wall.id,mask)
  }
 }
 dispose():void {this.cells.clear();this.masks.clear()}
}
