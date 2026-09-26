// Bounded client-only remains. Only an authoritative destruction event may start a visual.
import { tiltPresentation } from './presentation-motion'
import type { AircraftVisualEvent } from '../core/events'
import type { Mesh } from '../geo/mesh'
import type { Skeleton } from '../geo/rig'
import type { DrawItem, GpuMesh, RenderApi, ShroudApi, TerrainApi } from './types'

const LIMIT=64, BONES=256
// A crashed aircraft slams flat onto what it struck, holds under its impact burst, then fades.
const SETTLE=.3, CRASH_PITCH=-.08, CRASH_ROLL=.16, CRASH_SINK=.12, WRECK_LIFE=2.6, WATER_LIFE=2.4
interface Asset { mesh:GpuMesh; kind:number; airborne:boolean; skeleton:Skeleton|null; bounds:Float32Array }
export interface DeathCapture { mesh:GpuMesh|null; surfaceSet:string; playerColor:number; boneCount:number; paletteBase:number }
interface Entry {
 active:boolean; id:number; born:number; asset:Asset|null
 child:number; altitude:number; sourceAltitude:number; sampleTime:number; ended:boolean; impactAt:number; lastTrail:number
 /** hit: untilted pose at the impact frame; tilt: flight pitch/roll at that frame. */
 flight:Float64Array; event:AircraftVisualEvent; hit:Float32Array; tilt:Float64Array
 base:Float32Array; matrix:Float32Array; original:Float32Array; skin:Float32Array
 colors:Uint8Array; palette:Uint16Array; damages:Float32Array
 item:{-readonly [P in keyof DrawItem]:DrawItem[P]}
}
function ease(x:number):number { const t=Math.max(0,Math.min(1,x));return t*t*(3-2*t) }
function random(id:number,bone:number):number { let x=Math.imul(id^Math.imul(bone+1,997),0x45d9f3b);x^=x>>>16;return (x>>>0)/4294967296 }

export class DeathVisuals {
 private readonly assets=new Map<GpuMesh,Asset>()
 private readonly entries:Entry[]=[]
 private readonly husks=new Set<number>()
 /** Husks still reported after their wreck faded, by last time seen: never drawn twice. */
 private readonly retired=new Map<number,number>()
 readonly stats={active:0,humans:0,vehicles:0,animals:0,births:0,dropped:0,hidden:0,parts:0,crashes:0,impacts:0}
 constructor(){
  for(let i=0;i<LIMIT;i++){
   const matrix=new Float32Array(16),colors=new Uint8Array(1),palette=new Uint16Array(1),damages=new Float32Array(1)
   this.entries.push({active:false,id:0,born:0,asset:null,base:new Float32Array(16),matrix,
    child:0,altitude:0,sourceAltitude:0,sampleTime:-1,ended:false,impactAt:-1,lastTrail:-1,flight:new Float64Array(6),hit:new Float32Array(16),tilt:new Float64Array(2),
    event:{id:0,x:0,y:0,z:0,time:0,water:false,linked:false},
    original:new Float32Array(BONES*16),skin:new Float32Array(BONES*16),colors,palette,damages,
    item:{mesh:null as unknown as GpuMesh,surfaceSet:'blender',instances:matrix,instanceCount:1,playerColors:colors,
     paletteBases:palette,boneCount:0,damages,castsShadow:true,opacity:1}})
  }
 }
 /** Boot only: actual source vertices define part extents; no guessed sphere debris. */
 register(mesh:GpuMesh,kind:number,skeleton:Skeleton|null,source:Mesh,airborne=false):void {
  if(!kind)return
  const count=skeleton?.boneCount??1,bounds=new Float32Array(count*6)
  for(let b=0;b<count;b++){bounds.fill(Infinity,b*6,b*6+3);bounds.fill(-Infinity,b*6+3,b*6+6)}
  for(let v=0;v<source.vertexCount;v++)for(let j=0;j<(source.skinned?4:1);j++){
   if(source.skinned&&source.skinWeights![v*4+j]<=0)continue
   const b=source.skinned?source.skinIndices![v*4+j]:0,o=b*6
   for(let k=0;k<3;k++){const p=source.positions[v*3+k];bounds[o+k]=Math.min(bounds[o+k],p);bounds[o+3+k]=Math.max(bounds[o+3+k],p)}
  }
  // Culling encloses the bounded detached-part flight, not only the intact actor.
  const padding=kind===2||kind===5?2:.6,lo=new Float32Array(mesh.aabbMin),hi=new Float32Array(mesh.aabbMax)
  for(let k=0;k<3;k++){lo[k]-=padding;hi[k]+=padding}
  const sphere=Float32Array.of((lo[0]+hi[0])/2,(lo[1]+hi[1])/2,(lo[2]+hi[2])/2,Math.hypot(hi[0]-lo[0],hi[1]-lo[1],hi[2]-lo[2])/2)
  this.assets.set(mesh,{mesh:{...mesh,aabbMin:lo,aabbMax:hi,sphere},kind,airborne,skeleton,bounds})
 }
 kind(mesh:GpuMesh|null):number{return mesh?this.assets.get(mesh)?.kind??0:0}
 /** Kind of an actor's ACTIVE death entry — set the moment its death animation
  *  starts, so consumers can classify an actor AFTER it left the snapshot. */
 kindOf(id:number):number{for(const e of this.entries)if(e.active&&e.id===id)return e.asset?.kind??0;return 0}
 airborne(mesh:GpuMesh|null):boolean{return mesh?this.assets.get(mesh)?.airborne??false:false}
 start(id:number,time:number,transform:Float32Array,capture:DeathCapture,render:RenderApi,shroud:ShroudApi,altitude=0,vx=0,vz=0):boolean {
  const asset=capture.mesh?this.assets.get(capture.mesh):null
  if(!asset||asset.kind===4)return false
  // 5 = structures: fly rigid parts like vehicles, then the wreck binds the Dead rung.
  if(!Number.isFinite(time)||!Number.isInteger(id)||!Number.isInteger(capture.boneCount)||capture.boneCount<0||
   capture.boneCount>BONES||capture.boneCount!==(asset.skeleton?.boneCount??0)||transform.length<16)return false
  for(let k=0;k<16;k++)if(!Number.isFinite(transform[k]))return false
  if(!shroud.isVisible(Math.floor(transform[12]),Math.floor(transform[14]))){this.stats.hidden++;return false}
  let slot:Entry|null=null
  for(let i=0;i<LIMIT;i++){const e=this.entries[i];if(e.active&&e.id===id)return false;if(!e.active&&!slot)slot=e}
  if(!slot){this.stats.dropped++;return false}
  if(capture.boneCount&&!render.copyCompletedBones(capture.paletteBase,capture.boneCount,slot.original)){this.stats.dropped++;return false}
  slot.active=true;slot.id=id;slot.born=time;slot.asset=asset;slot.base.set(transform);slot.matrix.set(transform)
  slot.colors[0]=capture.playerColor;slot.item.mesh=asset.mesh;slot.item.surfaceSet=capture.surfaceSet
  slot.damages[0]=asset.kind===2||asset.kind===5?1:0
  slot.item.boneCount=capture.boneCount;slot.item.opacity=1
  slot.child=0;slot.altitude=slot.sourceAltitude=Math.max(0,altitude);slot.sampleTime=-1;slot.ended=false;slot.impactAt=-1;slot.lastTrail=time-.1
  slot.flight.fill(0);slot.flight[0]=transform[12];slot.flight[1]=transform[14];slot.flight[2]=Math.atan2(-transform[2],transform[0]);slot.flight[3]=vx;slot.flight[4]=vz
  this.stats.births++
  return true
 }
 clear():void{for(let i=0;i<LIMIT;i++)this.entries[i].active=false;this.husks.clear();this.retired.clear()}
 /** Bind by immutable engine parent id, never nearest position or a reused type index. */
 follow(parent:number,child:number,time:number,x:number,z:number,altitude:number,yaw:number):boolean {
  for(const e of this.entries)if(e.active&&e.id===parent&&e.asset?.airborne){
   this.husks.add(child);e.child=child;e.sampleTime=time;e.flight[0]=x;e.flight[1]=z;e.flight[2]=yaw;e.altitude=Math.max(0,altitude);return true
  }
  if(this.retired.has(child)){this.retired.set(child,time);return true}
  return false
 }
 ownsHusk(id:number):boolean {return this.husks.has(id)||this.retired.has(id)}
 finishHusk(id:number,time?:number):boolean {
  if(this.retired.delete(id))return true
  for(const e of this.entries)if(e.active&&e.child===id&&id!==0){
   // An unseen falling husk takes its visual with it; a landed wreck keeps its own fade.
   if(e.impactAt<0&&time!==undefined&&time-e.sampleTime>.2){e.active=false;this.husks.delete(id)}else{e.ended=true;e.altitude=0}
   return true
  }
  return false
 }
 /** A wreck that outlives its still-reported husk keeps that husk hidden until it leaves the snapshot. */
 private release(e:Entry,time:number):void {
  e.active=false
  if(!e.child)return
  this.husks.delete(e.child)
  if(!e.ended&&e.impactAt>=0)this.retired.set(e.child,time)
 }
 /** Exact retained model follows the authoritative husk; legacy snapshots fall ballistically. */
 private aircraft(e:Entry,time:number,render:RenderApi,terrain:TerrainApi,shroud:ShroudApi,
  signal?: (event:AircraftVisualEvent,impact:boolean)=>void):void {
  const age=time-e.born,asset=e.asset!,count=e.item.boneCount??0
  if(age<0||age>60){this.release(e,time);return}
  // A linked husk missing from this snapshot may simply be behind fog. Never extrapolate it.
  if(e.child&&!e.ended&&e.impactAt<0&&e.sampleTime!==time)return
  const m=e.matrix,landed=e.impactAt>=0,since=landed?time-e.impactAt:-1,settle=landed?ease(since/SETTLE):0
  let pitch=e.tilt[0],roll=e.tilt[1]
  if(landed){
   // Holding the flight attitude on its lowest bounding corner left the hull up in the air.
   m.set(e.hit);pitch+=(CRASH_PITCH-pitch)*settle;roll+=((Math.sin(e.id)<0?-CRASH_ROLL:CRASH_ROLL)-roll)*settle
  }else {
   m.set(e.base)
   if(e.child){
    const ratio=e.sourceAltitude>0?Math.min(1,e.altitude/e.sourceAltitude):0
    const yaw=e.flight[2]-Math.atan2(-e.base[2],e.base[0]),c=Math.cos(yaw),s=Math.sin(yaw)
    for(let col=0;col<3;col++){const o=col*4,x=e.base[o],z=e.base[o+2];m[o]=c*x+s*z;m[o+2]=-s*x+c*z}
    m[12]=e.flight[0];m[14]=e.flight[1]
    const support=Math.max(terrain.heightAt(m[12],m[14]),terrain.waterHeightAt?.(m[12],m[14])??-Infinity)
    // Last displayed clearance decays with the real remaining altitude, including hills.
    m[13]=support+(e.base[13]-support)*ratio
   }else {m[12]+=e.flight[3]*age;m[14]+=e.flight[4]*age;m[13]-=4.9*age*age}
   pitch=e.tilt[0]=-Math.min(.65,age*.32);roll=e.tilt[1]=Math.sin(e.id)*Math.min(.85,age*.45)
   e.hit.set(m)
  }
  tiltPresentation(m,0,pitch,roll)
  for(let k=0;k<count*16;k++)e.skin[k]=e.original[k]
  let lift=-Infinity,visible=true,minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,minY=Infinity,maxY=-Infinity
  for(let b=0;b<Math.max(1,count);b++){
   const bo=b*6,o=b*16;if(!Number.isFinite(asset.bounds[bo]))continue
   for(let corner=0;corner<8;corner++){
    const x=asset.bounds[bo+(corner&1?3:0)],y=asset.bounds[bo+1+(corner&2?3:0)],z=asset.bounds[bo+2+(corner&4?3:0)]
    const sx=count?e.skin[o]*x+e.skin[o+4]*y+e.skin[o+8]*z+e.skin[o+12]:x
    const sy=count?e.skin[o+1]*x+e.skin[o+5]*y+e.skin[o+9]*z+e.skin[o+13]:y
    const sz=count?e.skin[o+2]*x+e.skin[o+6]*y+e.skin[o+10]*z+e.skin[o+14]:z
    const wx=m[0]*sx+m[4]*sy+m[8]*sz+m[12],wy=m[1]*sx+m[5]*sy+m[9]*sz+m[13],wz=m[2]*sx+m[6]*sy+m[10]*sz+m[14]
    minX=Math.min(minX,wx);maxX=Math.max(maxX,wx);minZ=Math.min(minZ,wz);maxZ=Math.max(maxZ,wz);minY=Math.min(minY,wy);maxY=Math.max(maxY,wy)
    lift=Math.max(lift,Math.max(terrain.heightAt(wx,wz),terrain.waterHeightAt?.(wx,wz)??-Infinity)+.003-wy)
   }
  }
  for(let z=Math.ceil(minZ*2)/2;z<=maxZ;z+=.5)for(let x=Math.ceil(minX*2)/2;x<=maxX;x+=.5)
   lift=Math.max(lift,Math.max(terrain.heightAt(x,z),terrain.waterHeightAt?.(x,z)??-Infinity)+.003-minY)
  for(let z=Math.floor(minZ);z<=Math.floor(maxZ)&&visible;z++)for(let x=Math.floor(minX);x<=Math.floor(maxX);x++)if(!shroud.isVisible(x,z)){visible=false;break}
  const event=e.event;event.id=e.id;event.time=time;event.x=m[12];event.z=m[14];event.linked=e.child!==0
  // Resting on the surface every frame, a little embedded once settled; water keeps sinking.
  if(landed){m[13]+=lift-CRASH_SINK*(maxY-minY)*settle;if(event.water)m[13]-=Math.min(1.4,since*.65)}
  else if(lift>=0||e.ended){
   m[13]+=lift;e.impactAt=time;this.stats.impacts++
   const water=terrain.waterHeightAt?.(m[12],m[14]);event.water=water!==null&&water!==undefined&&water>=terrain.heightAt(m[12],m[14])
   event.y=event.water?water!:terrain.heightAt(m[12],m[14]);if(visible)signal?.(event,true)
  }
  // The wreck's own clock: it never waits for a husk the player may no longer see end.
  const life=event.water?WATER_LIFE:WRECK_LIFE
  if(since>=life){this.release(e,time);return}
  if(!visible)return
  if(e.impactAt<0&&time-e.lastTrail>=.1){e.lastTrail=time;event.y=m[13]+.25;signal?.(event,false)}
  if(count){const p=render.reserveBones(count);if(!p){this.stats.dropped++;return}for(let k=0;k<count*16;k++)p.matrices[k]=e.skin[k];e.palette[0]=p.base}else e.palette[0]=0
  e.item.opacity=since<0?1:1-ease((since-(life-1))/(1));e.item.castsShadow=e.item.opacity===1
  render.submit(e.item);this.stats.active++;this.stats.vehicles++;this.stats.crashes++
 }
 update(time:number,render:RenderApi,terrain:TerrainApi,shroud:ShroudApi,signal?:(event:AircraftVisualEvent,impact:boolean)=>void):void {
  this.stats.active=this.stats.humans=this.stats.vehicles=this.stats.animals=this.stats.parts=this.stats.crashes=0
  for(const [id,seen] of this.retired)if(time-seen>1||seen>time)this.retired.delete(id)
  for(let i=0;i<LIMIT;i++){
   const e=this.entries[i];if(!e.active||!e.asset)continue
   if(e.asset.airborne){this.aircraft(e,time,render,terrain,shroud,signal);continue}
   const age=time-e.born,asset=e.asset,vehicle=asset.kind===2,structure=asset.kind===5
   const life=structure?3.6:vehicle?2.8:5.2,fadeAt=structure?2.2:vehicle?1.6:3.8
   if(age<0||age>=life){e.active=false;continue}
   if(!shroud.isVisible(Math.floor(e.base[12]),Math.floor(e.base[14])))continue
   e.matrix.set(e.base)
   if(asset.airborne)e.matrix[13]-=4.9*age*age
   const count=e.item.boneCount??0
   for(let k=0;k<count*16;k++)e.skin[k]=e.original[k]
   if(!vehicle&&!structure){
    // Retain the exact last pose at t=0, then collapse forward from the feet.
    const fall=ease(age/.78),angle=(asset.kind===1?Math.PI*.5:.38)*fall,c=Math.cos(angle),s=Math.sin(angle)
    for(let k=0;k<3;k++){e.matrix[k]=e.base[k]*c+e.base[4+k]*s;e.matrix[4+k]=-e.base[k]*s+e.base[4+k]*c}
    // Source leg segments buckle during the fall instead of a rigid whole-body pivot only.
    const sk=asset.skeleton
    if(sk)for(let b=1;b<count;b++){
     let ancestor=b
     while(ancestor>0&&sk.kind[ancestor]!==10)ancestor=sk.parent[ancestor]
     if(ancestor<=0)continue
     const a=Math.sin(Math.min(1,age/.78)*Math.PI)*.42,ca=Math.cos(a),sa=Math.sin(a),o=b*16,bo=ancestor*16
     const px=sk.bindWorld[bo+12],py=sk.bindWorld[bo+13]
     for(let col=0;col<3;col++){const at=o+col*4,x=e.skin[at],y=e.skin[at+1];e.skin[at]=ca*x-sa*y;e.skin[at+1]=sa*x+ca*y}
     const x=e.skin[o+12]-px,y=e.skin[o+13]-py
     e.skin[o+12]=px+ca*x-sa*y;e.skin[o+13]=py+sa*x+ca*y
    }
   }else{
    for(let b=1;b<count;b++){
     const o=b*16,h=random(e.id,b),a=h*Math.PI*2,t=Math.min(age,1.3),distance=(.4+h*.5)*t
     // Spin the real rigid part about its captured centre, not about the actor origin.
     const bo=b*6,x=(asset.bounds[bo]+asset.bounds[bo+3])*.5,y=(asset.bounds[bo+1]+asset.bounds[bo+4])*.5,z=(asset.bounds[bo+2]+asset.bounds[bo+5])*.5
     const cx=e.skin[o]*x+e.skin[o+4]*y+e.skin[o+8]*z+e.skin[o+12]
     const cy=e.skin[o+1]*x+e.skin[o+5]*y+e.skin[o+9]*z+e.skin[o+13]
     const spin=(h-.5)*5*t,c=Math.cos(spin),s=Math.sin(spin)
     for(let col=0;col<3;col++){const at=o+col*4,u=e.skin[at],v=e.skin[at+1];e.skin[at]=c*u-s*v;e.skin[at+1]=s*u+c*v}
     const dx=e.skin[o+12]-cx,dy=e.skin[o+13]-cy
     e.skin[o+12]=cx+c*dx-s*dy;e.skin[o+13]=cy+s*dx+c*dy
     e.skin[o+12]+=Math.cos(a)*distance;e.skin[o+14]+=Math.sin(a)*distance
     e.skin[o+13]+=(1.5+h)*t-2.8*t*t
     this.stats.parts++
    }
   }
   // Contact against actual relief using transformed source part bounds. Conservative
   // bounds may rest slightly high; they must not penetrate terrain or invent collision.
   let bodyLift=-Infinity,visible=true
   for(let b=0;b<Math.max(1,count);b++){
    const bo=b*6,o=b*16;if(!Number.isFinite(asset.bounds[bo]))continue
    let lift=-Infinity,minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity,minY=Infinity,cornerGround=-Infinity
    for(let corner=0;corner<8;corner++){
     const x=asset.bounds[bo+(corner&1?3:0)],y=asset.bounds[bo+1+(corner&2?3:0)],z=asset.bounds[bo+2+(corner&4?3:0)]
     const sx=count?e.skin[o]*x+e.skin[o+4]*y+e.skin[o+8]*z+e.skin[o+12]:x
     const sy=count?e.skin[o+1]*x+e.skin[o+5]*y+e.skin[o+9]*z+e.skin[o+13]:y
     const sz=count?e.skin[o+2]*x+e.skin[o+6]*y+e.skin[o+10]*z+e.skin[o+14]:z
     const m=e.matrix,wx=m[0]*sx+m[4]*sy+m[8]*sz+m[12],wy=m[1]*sx+m[5]*sy+m[9]*sz+m[13],wz=m[2]*sx+m[6]*sy+m[10]*sz+m[14]
     minX=Math.min(minX,wx);maxX=Math.max(maxX,wx);minZ=Math.min(minZ,wz);maxZ=Math.max(maxZ,wz)
     minY=Math.min(minY,wy)
     const ground=terrain.heightAt(wx,wz);cornerGround=Math.max(cornerGround,ground)
     lift=Math.max(lift,ground+.003-wy)
    }
    // A ridge may be taller inside a part than at any corner. Include the terrain's
    // integer/half-cell lattices plus the centre. Use a conservative vertical bound
    // only for a higher interior peak, retaining the tight corner fit on planar slopes.
    let interiorGround=terrain.heightAt((minX+maxX)*.5,(minZ+maxZ)*.5)
    for(let z=Math.ceil(minZ*2)/2;z<=maxZ;z+=.5)for(let x=Math.ceil(minX*2)/2;x<=maxX;x+=.5)
     interiorGround=Math.max(interiorGround,terrain.heightAt(x,z))
    if(interiorGround>cornerGround+1e-6)lift=Math.max(lift,interiorGround+.003-minY)
    // Test the complete projected part bounds, including interior cells: neither a
    // shadow nor detached geometry may straddle hidden information at the edge.
    for(let z=Math.floor(minZ);z<=Math.floor(maxZ)&&visible;z++)for(let x=Math.floor(minX);x<=Math.floor(maxX);x++){
     if(!shroud.isVisible(x,z)){visible=false;break}
    }
    if((vehicle||structure)&&b===0&&age>0){
     // Settle the falling hull FIRST; child contact must use that corrected base or
     // the later root correction would lift every detached part a second time.
     if(Number.isFinite(lift))e.matrix[13]+=Math.max(0,lift)
    }else if((vehicle||structure)&&b>0&&lift>0&&age>0){
     for(let axis=0;axis<3;axis++){
      const k=axis*4,n=e.matrix[k]**2+e.matrix[k+1]**2+e.matrix[k+2]**2
      if(n>1e-8)e.skin[o+12+axis]+=e.matrix[k+1]*lift/n
     }
    }else bodyLift=Math.max(bodyLift,lift)
   }
   if(!visible)continue
   if(!vehicle&&age>0&&Number.isFinite(bodyLift))e.matrix[13]+=Math.max(0,bodyLift)
   if(count){const p=render.reserveBones(count);if(!p){this.stats.dropped++;continue}for(let k=0;k<count*16;k++)p.matrices[k]=e.skin[k];e.palette[0]=p.base}else e.palette[0]=0
   e.item.opacity=1-ease((age-fadeAt)/(life-fadeAt));e.item.castsShadow=e.item.opacity===1
   render.submit(e.item);this.stats.active++
   if(asset.kind===1)this.stats.humans++;else if(vehicle||structure)this.stats.vehicles++;else this.stats.animals++
  }
 }
 dispose():void{this.clear();this.assets.clear()}
}
