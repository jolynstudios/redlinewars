// Source-bound wake profiles for every vessel. Batched foam geometry shares the existing decal allowance.
// The wake scales with the vessel's speed and with the water's depth under its stern; an enemy
// submarine that is cloaked or submerged draws none, and an own one below the surface only bubbles.
import { Mesh } from '../geo/mesh'
import { markFoamCoverage } from '../geo/foam-coverage'
import { ActorFlag, findActorIndex, type Ctx } from '../core'
import presentation from '../core/presentation-manifest.json'
import type { DrawItem, RenderApi, ShroudApi, TerrainApi, UnitsApi } from './types'

interface End { readonly x:number; readonly leftZ:number; readonly rightZ:number }
export interface WakePlan { readonly sourceSha256:string; readonly waterlineY:number; readonly bow:End; readonly stern:End; readonly beam:number; readonly length:number; readonly lifetimeS:number; readonly submarine?:boolean; readonly propulsion?:readonly {readonly x:number;readonly z:number}[] }
const roster=import.meta.glob<{assets:Record<string,{sourceSha256?:string}>}>('../../.forge/blender/manifest.json',{eager:true,import:'default'})
function boundPlans():readonly (readonly [string,WakePlan])[] {
 const assets=Object.values(roster)[0]?.assets;if(!assets)return []
 const plans:(readonly [string,WakePlan])[]=[]
 for(const name of ['pt','dd','ca','lst','ss','msub']){
  const entry=(presentation.actors as Record<string,{sourceSha256:string;wake?:Omit<WakePlan,'sourceSha256'>}>)[name]
  if(!entry?.wake)continue
  if(assets[name]?.sourceSha256!==entry.sourceSha256)throw new Error(`${name}: naval wake source mismatch`)
  plans.push([name,{...entry.wake,sourceSha256:entry.sourceSha256}])
 }
 return plans
}

const SHIPS=16,BANDS=4,MAX_CAP=256,STRIDE=10,HISTORY=16
/**
 * Water depth under the stern (the drawn water surface over the drawn bed; open sea is 1.5 m).
 * Over a shelving bottom a wake breaks up sooner and spreads wider: at no depth it lives
 * SHALLOW_LIFE of its time and is SHALLOW_SPREAD wider, easing to the open-sea wake at DEEP_M.
 */
export const DEEP_M=1.5,SHALLOW_LIFE=.55,SHALLOW_SPREAD=.35
export function wakeDepthScale(depthM:number):{life:number;width:number}{
 const deep=Math.max(0,Math.min(1,(Number.isFinite(depthM)?depthM:DEEP_M)/DEEP_M))
 return {life:SHALLOW_LIFE+(1-SHALLOW_LIFE)*deep,width:1+SHALLOW_SPREAD*(1-deep)}
}
const SIDES=[-1,1] as const
export const navalWakeReservation=(decals:number)=>Math.min(MAX_CAP,Math.max(0,Math.floor(decals/8)))
const fract=(x:number)=>x-Math.floor(x)
function foamMesh():Mesh {
 const m=new Mesh(8,6)
 // Irregular tapered patch; no rectangular opaque ribbon edge or emissive flag.
 for(const [x,z]of [[0,-.34],[.23,-.48],[.71,-.36],[1,-.42],[1,.39],[.64,.47],[.29,.33],[0,.42]])m.addVertex(x,0,z,0,1,0,x,z+.5)
 for(let i=1;i<7;i++)m.addTriangle(0,i+1,i)
 m.computeTangents();markFoamCoverage(m);return m
}
export class NavalWakes {
 private plan:WakePlan|null
 private readonly plans:readonly (readonly [string,WakePlan])[]
 private collectingPlan:WakePlan|null=null
 private readonly selectedPlans:(WakePlan|null)[]=new Array(SHIPS).fill(null)
 private sourceId=0
 private cap=0;private cursor=0;private time=-1
 private readonly records=new Float64Array(MAX_CAP*STRIDE)
 private readonly alive=new Uint8Array(MAX_CAP)
 private readonly ids=new Uint32Array(SHIPS)
 private readonly history=new Float64Array(SHIPS*HISTORY)
 private readonly used=new Uint8Array(SHIPS)
 private readonly selectedIds=new Uint32Array(SHIPS)
 private readonly selected=new Float32Array(SHIPS*16)
 private selectedCount=0
 private readonly matrices=Array.from({length:BANDS},()=>new Float32Array(MAX_CAP*16))
 private readonly counts=new Uint16Array(BANDS)
 private readonly items:DrawItem[]=[]
 private render:RenderApi|null=null;private ctx:Ctx|null=null;private terrain:TerrainApi|null=null;private shroud:ShroudApi|null=null
 readonly stats={active:0,emitted:0,ships:0,segments:0,bow:0,spray:0,dropped:0,resets:0,reservation:0,allocatedBytes:0,shallow:0}
 constructor(plan:WakePlan|null|undefined=undefined){this.plans=plan===undefined?boundPlans():plan?[['dd',plan]]:[];this.plan=this.plans[0]?.[1]??null}
 init(render:RenderApi,decals:number):number {
  if(!this.plan)return 0
  const p=this.plan
  if(p.waterlineY!==0||!Number.isFinite(p.length)||p.length<=0||p.beam<=0||p.lifetimeS<=0||p.lifetimeS>8)throw new Error('Invalid naval wake geometry')
  for(const end of[p.bow,p.stern])if(![end.x,end.leftZ,end.rightZ].every(Number.isFinite)||end.leftZ>=end.rightZ)throw new Error('Invalid naval wake anchors')
  this.cap=navalWakeReservation(decals);this.stats.reservation=this.cap
  const mesh=render.upload(foamMesh(),'fx:naval-foam')
  for(let band=0;band<BANDS;band++)this.items.push({mesh,surfaceSet:'snow',instances:this.matrices[band],instanceCount:0,playerColors:null,castsShadow:false,opacity:[.40,.29,.17,.065][band]})
  this.stats.allocatedBytes=this.records.byteLength+this.alive.byteLength+this.ids.byteLength+this.history.byteLength+this.used.byteLength+this.selectedIds.byteLength+this.selected.byteLength+this.counts.byteLength+this.matrices.reduce((n,m)=>n+m.byteLength,0)
  return this.cap
 }
 clear():void {this.alive.fill(0);this.used.fill(0);this.time=-1;this.cursor=0;this.stats.active=this.stats.emitted=0;this.counts.fill(0)}
 dispose():void {this.clear();this.items.length=0;this.ctx=null;this.terrain=null;this.shroud=null}
 private readonly collect=(m:Float32Array,o:number,id:number):void=>{
  const actors=this.ctx?.snapshot?.actors;if(!actors)return
  const index=findActorIndex(actors,id);if(index<0||(actors.flags[index]&ActorFlag.husk)!==0)return
  if((actors.flags[index]&(ActorFlag.cloaked|ActorFlag.submerged))!==0 && actors.owner[index]!==this.ctx?.snapshot?.world?.renderPlayer)return
  const x=m[o+12],z=m[o+14],water=this.terrain!.waterHeightAt?.(x,z)
  if(water===null||water===undefined||!Number.isFinite(water)||!this.shroud!.isVisible(Math.floor(x),Math.floor(z)))return
  // Lowest visible actor IDs win deterministically when the bounded collector is full.
  let at=0;while(at<this.selectedCount&&this.selectedIds[at]<id)at++
  const shipLimit=Math.min(SHIPS,Math.max(1,Math.floor(this.cap/32)))
  if(at>=shipLimit){this.stats.dropped++;return}
  if(this.selectedCount<shipLimit)this.selectedCount++;else this.stats.dropped++
  for(let i=this.selectedCount-1;i>at;i--){this.selectedIds[i]=this.selectedIds[i-1];this.selectedPlans[i]=this.selectedPlans[i-1];this.selected.copyWithin(i*16,(i-1)*16,i*16)}
  this.selectedIds[at]=id;this.selectedPlans[at]=this.collectingPlan;for(let k=0;k<16;k++)this.selected[at*16+k]=m[o+k]
 }
 tick(time:number,ctx:Ctx,units:UnitsApi,render:RenderApi,terrain:TerrainApi|null,shroud:ShroudApi):void {
  if(!this.plan||!this.cap||!terrain?.waterHeightAt||!units.visitVisibleInstances)return
  if(this.time>=0&&time<this.time){this.clear();this.stats.resets++}
  const advancing=time>this.time;this.time=time
  this.render=render;this.ctx=ctx;this.terrain=terrain;this.shroud=shroud;this.selectedCount=0;this.counts.fill(0)
  this.stats.ships=this.stats.segments=this.stats.bow=this.stats.spray=this.stats.shallow=0
  for(const [name,plan]of this.plans){this.collectingPlan=plan;units.visitVisibleInstances(name,this.collect)}
  for(let i=0;i<SHIPS;i++)if(this.used[i]){let found=false;for(let j=0;j<this.selectedCount;j++)if(this.ids[i]===this.selectedIds[j])found=true;if(!found)this.used[i]=0}
  for(let i=0;i<this.selectedCount;i++)this.ship(i,time,advancing)
  this.stats.active=0
  for(let i=0;i<this.cap;i++)if(this.alive[i]){
   const b=i*STRIDE,r=this.records,age=time-r[b+6]
   let visible=false;for(let j=0;j<this.selectedCount;j++)if(this.selectedIds[j]===r[b+9])visible=true
   if(!visible){this.alive[i]=0;continue}
   if(age>=r[b+8]||age<0){this.alive[i]=0;continue}
   this.stats.active++;const drift=age*.07,ax=r[b]+r[b+4]*drift,az=r[b+1]+r[b+5]*drift,bx=r[b+2]+r[b+4]*drift,bz=r[b+3]+r[b+5]*drift
   const width=r[b+7]*(1+age*.35),band=Math.min(BANDS-1,Math.floor(age/r[b+8]*BANDS)),y=terrain.waterHeightAt((ax+bx)*.5,(az+bz)*.5)
   if(y!==null&&y!==undefined&&this.patch(ax,az,bx,bz,width,y+.008,band))this.stats.segments++
  }
  for(let band=0;band<BANDS;band++){(this.items[band]as{instanceCount:number}).instanceCount=this.counts[band];if(this.counts[band])render.submit(this.items[band])}
 }
 private ship(index:number,time:number,advancing:boolean):void {
  const id=this.selectedIds[index],m=this.selected,o=index*16,p=this.selectedPlans[index]!
  this.plan=p;this.sourceId=id
  let slot=-1;for(let i=0;i<SHIPS;i++)if(this.used[i]&&this.ids[i]===id){slot=i;break}
  if(slot<0){for(let i=0;i<SHIPS;i++)if(!this.used[i]||this.history[i*HISTORY+10]<time-1){slot=i;break}}
  if(slot<0){this.stats.dropped++;return}
  const h=this.history,b=slot*HISTORY,x=m[o+12],z=m[o+14],scale=Math.hypot(m[o],m[o+2]),fx=m[o]/scale,fz=m[o+2]/scale
  const dt=time-h[b+2],dx=x-h[b],dz=z-h[b+1],distance=Math.hypot(dx,dz)
  const reset=!this.used[slot]||dt> .6||dt<0||distance>Math.max(.7,dt*6)
  if(reset){h[b+5]=0;h[b+6]=0;h[b+9]=time;this.stats.resets++}
  else if(advancing&&dt>1e-6){h[b+5]=(dx*(fx+h[b+3])*.5+dz*(fz+h[b+4])*.5)/dt;h[b+6]=Math.atan2(h[b+3]*fz-h[b+4]*fx,h[b+3]*fx+h[b+4]*fz)/dt}
  this.used[slot]=1;this.ids[slot]=id;h[b+10]=time
  const underwater=p.submarine&&m[o+13]<(this.terrain!.waterHeightAt!(x,z)??0)-.20
  const speed=h[b+5],turn=h[b+6],direction=speed>=0?1:-1,lead=direction>0?p.bow:p.stern,tail=direction>0?p.stern:p.bow
  const tx=x+m[o]*tail.x,tz=z+m[o+2]*tail.x,weight=Math.min(1,Math.abs(speed)/.8)
  if(reset||h[b+13]!==direction){h[b+7]=tx;h[b+8]=tz;h[b+9]=time;h[b+11]=m[o+8];h[b+12]=m[o+10];h[b+13]=direction;h[b+14]=m[o];h[b+15]=m[o+2]}
  // Reserve the attached bow/spray first. Scale cadence and record lifetime so
  // even Low records complete their fade before ring reuse under steady load.
  const lanes=p.propulsion&&direction>0?2+p.propulsion.length:3
  const steps=Math.max(1,Math.floor((this.cap/Math.max(1,this.selectedCount)-6)/lanes)-1)
  const sternWater=this.terrain!.waterHeightAt!(tx,tz),depth=wakeDepthScale(sternWater===null||sternWater===undefined?DEEP_M:sternWater-this.terrain!.heightAt(tx,tz))
  this.stats.shallow+=depth.life<.999?1:0
  const lifetime=Math.min(p.lifetimeS,Math.max(.48,steps*.12))*depth.life,cadence=Math.max(.12,lifetime/steps)
  if(!reset&&advancing&&time-h[b+9]>=cadence&&Math.abs(speed)>.025){
   for(let side=-1;side<=1;side++){
    if(side===0&&p.propulsion&&direction>0)continue
    const localZ=side<0?tail.leftZ:side>0?tail.rightZ:0,oldX=h[b+7]+h[b+11]*localZ,oldZ=h[b+8]+h[b+12]*localZ
    const nx=tx+m[o+8]*localZ,nz=tz+m[o+10]*localZ
    this.emit(oldX,oldZ,nx,nz,m[o+8]*side,m[o+10]*side,time,(underwater?.025:side===0?.14:.075)*scale*weight*depth.width,lifetime)
   }
   if(p.propulsion&&direction>0)for(const nozzle of p.propulsion){
    const along=nozzle.x-tail.x
    this.emit(h[b+7]+h[b+14]*along+h[b+11]*nozzle.z,h[b+8]+h[b+15]*along+h[b+12]*nozzle.z,
     tx+m[o]*along+m[o+8]*nozzle.z,tz+m[o+2]*along+m[o+10]*nozzle.z,0,0,time,.10*scale*weight*depth.width,lifetime)
   }
   h[b+9]=time;h[b+7]=tx;h[b+8]=tz;h[b+11]=m[o+8];h[b+12]=m[o+10];h[b+14]=m[o];h[b+15]=m[o+2]
  }
  if(Math.abs(speed)>.025){
   this.stats.ships++
   if(underwater){
    const water=this.terrain!.waterHeightAt!(tx,tz)
    if(water!==null&&this.shroud!.isVisible(Math.floor(tx),Math.floor(tz)))for(let bubble=0;bubble<2;bubble++){
     const phase=fract(time*1.4+bubble*.5+(id%13)*.071)
     this.render?.addParticle?.(tx-fx*phase*.35,water-.10+phase*.07,tz-fz*phase*.35,.012+phase*.014,.42,.65,.70,.22*(1-phase),phase,id+bubble,0)
    }
    return this.saveHistory(h,b,x,z,time,fx,fz)
   }

   for(const side of SIDES){
    const localZ=side<0?lead.leftZ:lead.rightZ,ax=x+m[o]*lead.x+m[o+8]*localZ,az=z+m[o+2]*lead.x+m[o+10]*localZ,y=this.terrain!.waterHeightAt!(ax,az)
    if(y===null)continue
    const outside=Math.max(.6,Math.min(1.6,1+side*turn*.3)),length=(.16+.13*weight)*scale
    // Fan out beyond the widening forebody; the first point remains the exact hull contact.
    const fan=Math.max(.05,p.beam*.5-Math.abs(localZ)+.035)*weight
    const bx=ax-fx*direction*length+m[o+8]*side*fan,bz=az-fz*direction*length+m[o+10]*side*fan
    if(this.patch(ax,az,bx,bz,.06*scale*weight*outside,y+.012,0))this.stats.bow++
    for(let spray=0;spray<2;spray++){
     const phase=fract(time*3.4+spray*.5+(id%17)*.037),lift=Math.sin(phase*Math.PI)*.055*weight
     const sx=ax-fx*direction*phase*.13+m[o+8]*side*phase*.09,sz=az-fz*direction*phase*.13+m[o+10]*side*phase*.09
     if(this.patch(sx,sz,sx-fx*.025,sz-fz*.025,.025*scale*weight,y+.016+lift,1,.035*weight*(1-phase)))this.stats.spray++
    }
   }
  }
  if(reset||Math.abs(speed)<=.025){h[b+7]=tx;h[b+8]=tz;h[b+9]=time}
  if(advancing||reset){h[b]=x;h[b+1]=z;h[b+2]=time;h[b+3]=fx;h[b+4]=fz}
 }
 private saveHistory(h:Float64Array,b:number,x:number,z:number,time:number,fx:number,fz:number):void {h[b]=x;h[b+1]=z;h[b+2]=time;h[b+3]=fx;h[b+4]=fz}
 private emit(ax:number,az:number,bx:number,bz:number,nx:number,nz:number,time:number,width:number,lifetime:number):void {
  const distance=Math.hypot(bx-ax,bz-az);if(distance>this.plan!.length||distance<1e-5)return
  // Small overlap joins successive irregular strips; seeded width avoids a stamped pattern.
  const overlap=.035/distance,dx=bx-ax,dz=bz-az;ax-=dx*overlap;az-=dz*overlap
  let index=this.cursor++%this.cap
  for(let n=0;n<this.cap;n++){const candidate=(index+n)%this.cap,b=candidate*STRIDE;if(!this.alive[candidate]||time-this.records[b+6]>=this.records[b+8]){index=candidate;break}}
  if(this.alive[index]&&time-this.records[index*STRIDE+6]<this.records[index*STRIDE+8])this.stats.dropped++
  const b=index*STRIDE,r=this.records;r[b]=ax;r[b+1]=az;r[b+2]=bx;r[b+3]=bz;r[b+4]=nx;r[b+5]=nz;r[b+6]=time;r[b+7]=width*(.84+fract(time*31.7+ax*13.1+az*7.3)*.32);r[b+8]=lifetime;r[b+9]=this.sourceId;this.alive[index]=1;this.stats.emitted++
 }
 private patch(ax:number,az:number,bx:number,bz:number,width:number,y:number,band:number,lift=0):boolean {
  let total=0;for(let i=0;i<BANDS;i++)total+=this.counts[i]
  if(total>=this.cap){this.stats.dropped++;return false}
  if(!this.shroud!.isVisible(Math.floor(ax),Math.floor(az))||!this.shroud!.isVisible(Math.floor(bx),Math.floor(bz)))return false
  if(this.terrain!.waterHeightAt!(ax,az)===null||this.terrain!.waterHeightAt!(bx,bz)===null)return false
  const dx=bx-ax,dz=bz-az,length=Math.hypot(dx,dz);if(length<1e-6)return false
  const px=-dz/length*width*.5,pz=dx/length*width*.5
  for(let e=0;e<2;e++)for(const side of SIDES){const x=(e?bx:ax)+px*side,z=(e?bz:az)+pz*side;if(!this.shroud!.isVisible(Math.floor(x),Math.floor(z))||this.terrain!.waterHeightAt!(x,z)===null)return false}
  const m=this.matrices[band],o=this.counts[band]++*16
  m[o]=dx;m[o+1]=lift;m[o+2]=dz;m[o+3]=0;m[o+4]=0;m[o+5]=1;m[o+6]=0;m[o+7]=0;m[o+8]=-dz/length*width;m[o+9]=0;m[o+10]=dx/length*width;m[o+11]=0;m[o+12]=ax;m[o+13]=y;m[o+14]=az;m[o+15]=1
  return true
 }
}
