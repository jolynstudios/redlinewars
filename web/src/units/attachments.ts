import manifest from '../core/presentation-manifest.json'
import RA_VISUAL_MANIFEST from '../core/ra-visual-manifest.json'
import type { GpuMesh } from './types'
import type { ResolvedRoleMuzzle } from './role-assets'
export interface Socket {readonly part:string;readonly bone:number;readonly position:readonly number[];readonly direction:readonly number[]}
export interface ArmamentSockets {readonly weapon:string;readonly sockets:readonly Socket[];readonly barrels:readonly (readonly number[])[]}
export interface PresentationBinding {readonly sourceSha256:string;readonly armaments:readonly ArmamentSockets[];readonly lights:readonly Socket[];readonly exhausts?:readonly Socket[]}
export const PRESENTATION_BINDINGS:Readonly<Record<string,PresentationBinding>>=manifest.actors
interface Bound {readonly binding:PresentationBinding;readonly offsets:Uint16Array;readonly length:number}
type RulesArmament={readonly Weapon:string;readonly LocalOffset?:readonly (readonly number[])[]}
const RULES_ARMAMENTS=(RA_VISUAL_MANIFEST as unknown as {actors:Record<string,{armaments?:readonly RulesArmament[]}>}).actors
/**
 * One socket per barrel where the model has fewer. The 3TNK's two guns resolved to one
 * 'muzzle brake' on its centreline, so both shots of a burst left from between the barrels. The
 * rules name each barrel's lateral offset (Armament LocalOffset, WDist, +Y to the right), and
 * the forge anchors match model +Z to rules +Y. So a shared socket is split into one per barrel
 * at the authoritative spacing. This is a verified rules offset, not a guess; a model that
 * authors a socket per barrel keeps its own.
 */
export function withRulesBarrels(slot:string,binding:PresentationBinding):PresentationBinding {
 const rules=RULES_ARMAMENTS[slot]?.armaments;if(!rules)return binding
 let changed=false
 const armaments=binding.armaments.map(a=>{
  const offsets=rules.find(r=>r.Weapon.toLowerCase()===a.weapon.toLowerCase())?.LocalOffset
  if(!offsets||offsets.length<2||a.barrels.length!==offsets.length)return a
  if(new Set(a.barrels.map(c=>c.join(','))).size>=a.barrels.length)return a
  const base=a.sockets[a.barrels[0][0]];if(!base)return a
  changed=true
  return {...a,sockets:offsets.map(o=>({...base,part:`${base.part} (rules barrel ${o[1]>0?'right':'left'})`,position:[base.position[0],base.position[1],base.position[2]+o[1]/1024]})),barrels:offsets.map((_,b)=>[b])}
 })
 return changed?{...binding,armaments}:binding
}
interface Placed {bound:Bound;values:Float32Array;frame:number}
const LIMIT=2048
/** Applies exactly the skin palette submitted with the model, then its placed matrix. */
export function transformSocket(m:Float32Array,o:number,skin:Float32Array|null,s:Socket,out:Float32Array,at:number):void {
 let x=s.position[0],y=s.position[1],z=s.position[2],dx=s.direction[0],dy=s.direction[1],dz=s.direction[2]
 const b=s.bone*16
 if(skin&&b+16<=skin.length){
  const px=skin[b]*x+skin[b+4]*y+skin[b+8]*z+skin[b+12]
  const py=skin[b+1]*x+skin[b+5]*y+skin[b+9]*z+skin[b+13]
  const pz=skin[b+2]*x+skin[b+6]*y+skin[b+10]*z+skin[b+14]
  const vx=skin[b]*dx+skin[b+4]*dy+skin[b+8]*dz
  const vy=skin[b+1]*dx+skin[b+5]*dy+skin[b+9]*dz
  const vz=skin[b+2]*dx+skin[b+6]*dy+skin[b+10]*dz
  x=px;y=py;z=pz;dx=vx;dy=vy;dz=vz
 }
 out[at]=m[o]*x+m[o+4]*y+m[o+8]*z+m[o+12]
 out[at+1]=m[o+1]*x+m[o+5]*y+m[o+9]*z+m[o+13]
 out[at+2]=m[o+2]*x+m[o+6]*y+m[o+10]*z+m[o+14]
 const vx=m[o]*dx+m[o+4]*dy+m[o+8]*dz,vy=m[o+1]*dx+m[o+5]*dy+m[o+9]*dz,vz=m[o+2]*dx+m[o+6]*dy+m[o+10]*dz
 const len=Math.hypot(vx,vy,vz)||1
 out[at+3]=vx/len;out[at+4]=vy/len;out[at+5]=vz/len
}
export class Attachments {
 private readonly meshes=new Map<GpuMesh,Bound>()
 private readonly actors=new Map<number,Placed>()
 private frame=0
 bind(mesh:GpuMesh,slot:string,sourceSha:string|undefined,role:ResolvedRoleMuzzle|null=null,weapons:readonly string[]=[]):void {
  let binding:PresentationBinding|undefined=PRESENTATION_BINDINGS[slot]
  if(role){
   const socket:Socket={part:'role weapon',bone:role.bone,position:role.pos,direction:role.direction}
   binding={sourceSha256:sourceSha??'',lights:[],armaments:weapons.map((weapon,index)=>({weapon,sockets:[socket],barrels:(binding?.armaments[index]?.barrels??[[0]]).map(()=>[0])}))}
  }else if(binding){
   if(sourceSha===undefined)binding=undefined // procedural fallback mesh: it does not carry the authored skeleton these sockets are bound to, so skip instead of throwing or misplacing muzzles
   else if(sourceSha!==binding.sourceSha256)throw new Error(`${slot}: stale presentation socket source (runtime=${sourceSha} manifest=${binding.sourceSha256})`)
  }
  if(!binding)return
  if(!role)binding=withRulesBarrels(slot,binding)
  const offsets=new Uint16Array(binding.armaments.length);let length=0
  for(let a=0;a<offsets.length;a++){offsets[a]=length;length+=binding.armaments[a].sockets.length*6}
  this.meshes.set(mesh,{binding,offsets,length})
 }
 begin():void {this.frame++}
 end():void {for(const [id,p] of this.actors)if(p.frame!==this.frame)this.actors.delete(id)}
 place(id:number,mesh:GpuMesh,m:Float32Array,o:number,skin:Float32Array|null):void {
  const bound=this.meshes.get(mesh);if(!bound)return
  let p=this.actors.get(id)
  if(!p||p.values.length<bound.length){if(this.actors.size>=LIMIT)return;p={bound,values:new Float32Array(bound.length),frame:this.frame};this.actors.set(id,p)}
  p.bound=bound;p.frame=this.frame
  for(let a=0;a<bound.offsets.length;a++){
   const sockets=bound.binding.armaments[a].sockets
   for(let j=0;j<sockets.length;j++)transformSocket(m,o,skin,sockets[j],p.values,bound.offsets[a]+j*6)
  }
 }
 weapon(id:number,arm:number):string{return this.actors.get(id)?.bound.binding.armaments[arm]?.weapon??''}
 resolve(id:number,arm:number,barrel:number,out:Float32Array,shot=1):boolean {
  const p=this.actors.get(id),a=p?.bound.binding.armaments[arm];if(!p||!a)return false
  const choices=a.barrels[barrel];if(!choices?.length)return false
  const socket=choices[Math.floor(Math.max(0,shot-1)/a.barrels.length)%choices.length]
  const at=p.bound.offsets[arm]+socket*6
  for(let i=0;i<6;i++)out[i]=p.values[at+i]
  return true
 }
 clear():void {this.actors.clear();this.meshes.clear()}
}
