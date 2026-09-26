// Host-owned flights with immutable, explicitly identified presentation launch offsets.
// Flight position/velocity/removal remain authoritative; no live-source follow after launch.
import { Mesh } from '../geo/mesh'
import * as sdf from '../geo/sdf'
import { withZoneFlag, ZoneFlag } from '../geo/zone'
import { ProjectileKind, type Ctx } from '../core'
import type { DrawItem, RenderApi, ShroudApi, TerrainApi, UnitsApi } from './types'
import type { SoftParticles } from './particles'
import { lookupRaWeaponVisual, type ProjectileStyle, type WeaponVisualStyle } from './weapon-visuals'
const elevation=(terrain:TerrainApi|null,x:number,z:number)=>terrain?.presentationHeightOffsetAt?.(x,z)??terrain?.heightAt(x,z)??0
const MAX_BODIES=96, LAUNCHES=256, GROUPS=6, WPOS_TO_M=1/1024, MAX_CHUTES=32
/**
 * Cannon and artillery rounds in flight, published for fx/index.ts to draw as a short streak on
 * the authoritative position. They have no body: a shell reads as a moving hot dash, not a
 * model. Before this a shell drew nothing in flight, and a line from muzzle to impact was
 * replayed only when the impact event arrived, after the burst it should have preceded.
 */
export const MAX_SHELLS=128
/** Seconds between the restrained trajectory ribbon's puffs behind an artillery round (Ultra). */
const RIBBON_INTERVAL_S=.06
const RIBBON={widthM:.05,lifetimeS:.9,colorLinearRGB:[.62,.6,.57],opacity:.22,turbulence:.08}
/**
 * The superweapon missile (vfx.md §14.1: "launch and arrival, with missile exhaust"). NukePower's
 * missile is no armament, so the forge's armament catalogue has no profile for it. It climbs
 * out of the silo and falls on its target (engine NukeLaunch, published as a flight since it
 * leaves the silo), and it is the largest body in the game, with the longest trail.
 */
const SUPERWEAPON_MISSILES:ReadonlyMap<string,ProjectileStyle>=new Map([['atomic',Object.freeze({body:'heavy-rocket',material:'off-white',lengthM:1.6,radiusM:.1,exhaust:true,
 trail:Object.freeze({widthM:.24,lifetimeS:3.2,colorLinearRGB:Object.freeze([.64,.62,.6]),opacity:.5,turbulence:.04})}) as ProjectileStyle]])
function writeAxisTransform(
	out: Float32Array,
	o: number,
	x: number,
	y: number,
	z: number,
	axisX: number,
	axisY: number,
	axisZ: number,
	scaleX: number,
	scaleY: number,
	scaleZ: number,
): boolean {
	const len = Math.hypot(axisX, axisY, axisZ)
	if (!(len > 1e-6)) return false
	const xx = axisX / len
	const xy = axisY / len
	const xz = axisZ / len
	const refX = 0
	const refY = Math.abs(xy) < 0.9 ? 1 : 0
	const refZ = Math.abs(xy) < 0.9 ? 0 : 1
	const d = xx * refX + xy * refY + xz * refZ
	let yx = refX - xx * d
	let yy = refY - xy * d
	let yz = refZ - xz * d
	const yLen = Math.hypot(yx, yy, yz)
	yx /= yLen; yy /= yLen; yz /= yLen
	const zx = xy * yz - xz * yy
	const zy = xz * yx - xx * yz
	const zz = xx * yy - xy * yx
	out[o] = xx * scaleX; out[o + 1] = xy * scaleX; out[o + 2] = xz * scaleX; out[o + 3] = 0
	out[o + 4] = yx * scaleY; out[o + 5] = yy * scaleY; out[o + 6] = yz * scaleY; out[o + 7] = 0
	out[o + 8] = zx * scaleZ; out[o + 9] = zy * scaleZ; out[o + 10] = zz * scaleZ; out[o + 11] = 0
	out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1
	return true
}

interface Flight {id:number;seen:number;x:number;y:number;z:number;trailTime:number;sx:number;sy:number;sz:number;dx:number;dy:number;dz:number;bound:boolean}
/** One shell this frame: head position, unit direction, metres per tick, authored style. */
export interface ShellFlights {count:number;readonly x:Float32Array;readonly y:Float32Array;readonly z:Float32Array;readonly dx:Float32Array;readonly dy:Float32Array;readonly dz:Float32Array;readonly speed:Float32Array;readonly travelled:Float32Array;readonly style:(WeaponVisualStyle|null)[]}
export interface ProjectileStats {published:number;flights:number;beams:number;bodiesDrawn:number;beamsSkipped:number;trailPuffs:number;dropped:number;hidden:number;lights:number;startedBodies:number;shells:number;ribbonPuffs:number}
export class Projectiles {
 readonly stats:ProjectileStats={published:0,flights:0,beams:0,bodiesDrawn:0,beamsSkipped:0,trailPuffs:0,dropped:0,hidden:0,lights:0,startedBodies:0,shells:0,ribbonPuffs:0}
 /** Parabombs in flight this frame, each drawn under its chute by fx/parachutes (vfx.md Epic 7). */
 readonly chutes={count:0,x:new Float32Array(MAX_CHUTES),y:new Float32Array(MAX_CHUTES),z:new Float32Array(MAX_CHUTES)}
 readonly shells:ShellFlights={count:0,x:new Float32Array(MAX_SHELLS),y:new Float32Array(MAX_SHELLS),z:new Float32Array(MAX_SHELLS),dx:new Float32Array(MAX_SHELLS),dy:new Float32Array(MAX_SHELLS),dz:new Float32Array(MAX_SHELLS),speed:new Float32Array(MAX_SHELLS),travelled:new Float32Array(MAX_SHELLS),style:new Array(MAX_SHELLS).fill(null)}
 private readonly matrices=Array.from({length:GROUPS},()=>new Float32Array(MAX_BODIES*16))
 private readonly items:DrawItem[]=[]
 private readonly counts=new Uint16Array(GROUPS)
 private readonly launches=new Float64Array(LAUNCHES*12)
 private launchCursor=0
 private readonly flights=new Map<number,Flight>()
 private time=-1
 private frame=0
 private readonly profiles=new Map<number,ProjectileStyle|null>()
 /** Weapon types that fall under a parachute: RA's ParaBomb (OpenSequence open, 50 WPos a tick). */
 private readonly chuted=new Map<number,boolean>()
 /** Cannon/artillery style per weapon type id, or null for anything that is not a shell. */
 private readonly shellStyles=new Map<number,WeaponVisualStyle|null>()
 recordLaunch(actor:number,arm:number,barrel:number,shot:number,sx:number,sy:number,sz:number,x:number,y:number,z:number,time:number):void {
  if(!shot)return
  const b=(this.launchCursor++%LAUNCHES)*12,d=this.launches
  d[b]=actor;d[b+1]=arm;d[b+2]=barrel;d[b+3]=shot;d[b+4]=x-sx;d[b+5]=y-sy;d[b+6]=z-sz;d[b+7]=time;d[b+8]=sx;d[b+9]=sy;d[b+10]=sz;d[b+11]=0
 }
 /**
  * True once this shot was drawn from an authoritative flight. Its impact then owes no
  * replayed muzzle-to-impact line: the shell was on screen the whole way. A round that is
  * born and lands between two snapshots never flies here, and keeps that line as its only trace.
  */
 wasFlown(actor:number,arm:number,shot:number):boolean {
  if(!shot)return false
  const d=this.launches
  for(let j=0;j<LAUNCHES;j++){const b=j*12;if(d[b+3]===shot&&d[b]===actor&&d[b+1]===arm)return d[b+11]===1}
  return false
 }
 init(render:RenderApi):void {
  for(let group=0;group<GROUPS;group++){
   const body=new Mesh(),zone=group===0?10:group===1||group===3?2:0
   const shape=group===5?sdf.capsule(-.75,0,0,-.25,0,0,.25):sdf.union(sdf.capsule(-.90,0,0,-.17,0,0,.085),sdf.capsule(-.17,0,0,0,0,0,.03))
   sdf.surfaceNets(shape,sdf.setAabb(sdf.aabb(),-1.02,-.26,-.26,.12,.26,.26),26,body,{creaseAngle:34,seal:true})
   for(let v=0;v<body.vertexCount;v++)body.setZone(v,zone)
   if(group!==5){
    const fins=new Mesh()
    sdf.surfaceNets(sdf.union(sdf.box(.19,.32,.024),sdf.box(.19,.024,.32)),sdf.setAabb(sdf.aabb(),-.22,-.34,-.34,.22,.34,.34),18,fins,{creaseAngle:34,seal:true})
    for(let v=0;v<fins.vertexCount;v++){fins.positions[v*3]-=.78;fins.setZone(v,2)}body.merge(fins)
    const nose=new Mesh()
    sdf.surfaceNets(sdf.capsule(-.13,0,0,-.01,0,0,.046),sdf.setAabb(sdf.aabb(),-.20,-.09,-.09,.06,.09,.09),14,nose,{seal:true})
    for(let v=0;v<nose.vertexCount;v++)nose.setZone(v,11);body.merge(nose)
   }
   if(group<3){
    const exhaust=new Mesh()
    sdf.surfaceNets(sdf.capsule(-.94,0,0,-1.28,0,0,.045),sdf.setAabb(sdf.aabb(),-1.38,-.1,-.1,-.86,.1,.1),14,exhaust,{seal:true})
    for(let v=0;v<exhaust.vertexCount;v++)exhaust.setZone(v,withZoneFlag(10,ZoneFlag.emissive));body.merge(exhaust)
   }
   this.items.push({mesh:render.upload(body,`fx:projectile:${group}`),surfaceSet:'blender',instances:this.matrices[group],instanceCount:0,playerColors:null,castsShadow:false})
  }
 }
 clear():void {this.flights.clear();this.profiles.clear();this.shellStyles.clear();this.chuted.clear();this.launches.fill(0);this.time=-1;this.shells.count=0;this.chutes.count=0}
 dispose():void {this.items.length=0;this.clear()}
 /** `lights` is where exhaust lights go: fx passes its per-frame VFX light gate. */
 update(_dt:number,time:number,alpha:number,ctx:Ctx,render:RenderApi,shroud:ShroudApi,terrain:TerrainApi|null,_units:UnitsApi|null,particles:SoftParticles,ribbons=false,lights:Pick<RenderApi,'addLight'>=render):void {
  const s=this.stats;s.published=s.flights=s.beams=s.bodiesDrawn=s.beamsSkipped=s.trailPuffs=s.dropped=s.hidden=s.lights=s.shells=0
  const shells=this.shells;shells.count=0
  const chutes=this.chutes;chutes.count=0
  if(time<this.time){this.flights.clear();this.launches.fill(0)}
  const advancing=time>this.time;this.time=time;this.counts.fill(0);const frame=++this.frame
  const view=ctx.snapshot?.projectiles
  if(!view||!view.count){this.flights.clear();return}
  s.published=view.count;let trailing=0,remainingPuffs=32
  for(let i=0;i<view.count;i++){
   if(view.kind[i]===ProjectileKind.beam){s.beams++;s.beamsSkipped++;continue}
   let p=this.profiles.get(view.typeId[i])
   if(p===undefined){const name=ctx.actorTypeName(view.typeId[i]);p=lookupRaWeaponVisual(name).projectile??SUPERWEAPON_MISSILES.get(name.toLowerCase())??null;if(name){this.profiles.set(view.typeId[i],p);this.chuted.set(view.typeId[i],name.toLowerCase()==='parabomb')}}
   let shell:WeaponVisualStyle|null=null
   if(!p){
    let st=this.shellStyles.get(view.typeId[i])
    if(st===undefined){const name=ctx.actorTypeName(view.typeId[i]),v=lookupRaWeaponVisual(name);st=(v.family==='cannon'||v.family==='artillery')&&v.tracer.style==='streak'?v:null;if(name)this.shellStyles.set(view.typeId[i],st)}
    if(!st)continue
    shell=st
   }
   const px=view.posX[i]*WPOS_TO_M,py=view.posZ[i]*WPOS_TO_M,pz=view.posY[i]*WPOS_TO_M
   if(!shroud.isVisible(Math.floor(px),Math.floor(pz))){this.flights.delete(view.id[i]);s.hidden++;continue}
   if(s.bodiesDrawn>=MAX_BODIES){s.dropped++;continue}
   let flight=this.flights.get(view.id[i])
   if(!flight){
    let launch=-1
    if(view.launchShot&&view.launchArmament&&view.launchBarrel){
     for(let j=0;j<LAUNCHES;j++){const b=j*12,d=this.launches
      if(d[b]===view.sourceActorId[i]&&d[b+1]===view.launchArmament[i]&&d[b+2]===view.launchBarrel[i]&&d[b+3]===view.launchShot[i]&&time-d[b+7]<4&&d[b+3]>0){launch=j;break}
     }
    }
    flight={id:view.id[i],seen:frame,x:px,y:py,z:pz,trailTime:time,sx:px,sy:py,sz:pz,dx:0,dy:0,dz:0,bound:launch>=0};if(launch>=0){const b=launch*12,d=this.launches;d[b+11]=1;flight.sx=d[b+8];flight.sy=d[b+9];flight.sz=d[b+10];flight.dx=d[b+4];flight.dy=d[b+5]-elevation(terrain,d[b+8],d[b+10]);flight.dz=d[b+6];flight.x=flight.sx+flight.dx;flight.y=d[b+9]+d[b+5];flight.z=flight.sz+flight.dz}
    this.flights.set(view.id[i],flight);s.startedBodies++
   }
   flight.seen=frame
   const vx=view.velX[i]*WPOS_TO_M,vy=view.velZ[i]*WPOS_TO_M,vz=view.velY[i]*WPOS_TO_M
   let x=px+vx*alpha,y=py+vy*alpha,z=pz+vz*alpha
   const ground=elevation(terrain,x,z);y+=ground
   // Launch offset is immutable and exhausted by distance travelled from that shot.
   // No actor lookup, muzzle recomputation, or tracking of the departing launcher.
   if(flight.bound){
    const distance=Math.hypot(x-flight.sx,y-ground-flight.sy,z-flight.sz),t=Math.max(0,1-distance/1.5)
    const fade=t*t*(3-2*t)*(view.remainingTicks[i]<=1?0:1)
    x+=flight.dx*fade;y+=flight.dy*fade;z+=flight.dz*fade
   }
   if(shell){
    // A shell: publish the head for the streak, and on Ultra lay the artillery ribbon.
    const speed=Math.hypot(vx,vy,vz)
    if(!shroud.isVisible(Math.floor(x),Math.floor(z))){s.hidden++;continue}
    if(shells.count<MAX_SHELLS&&speed>1e-5){
     const k=shells.count++
     shells.x[k]=x;shells.y[k]=y;shells.z[k]=z;shells.dx[k]=vx/speed;shells.dy[k]=vy/speed;shells.dz[k]=vz/speed
     shells.speed[k]=speed;shells.travelled[k]=flight.bound?Math.hypot(x-flight.sx-flight.dx,y-ground-flight.sy,z-flight.sz-flight.dz):Infinity;shells.style[k]=shell
     s.shells++
    }
    if(ribbons&&advancing&&shell.family==='artillery'&&time-flight.trailTime>=RIBBON_INTERVAL_S){
     if(particles.spawnTrail(x,y,z,time,(view.id[i]^Math.floor(time*25))|0,RIBBON,shroud))s.ribbonPuffs++
     flight.trailTime=time
    }
    continue
   }
   if(!p)continue
   const underwater=p.body==='torpedo'||p.body==='depth-charge'
   const water=underwater?terrain?.waterHeightAt?.(x,z):null
   if(water!==null&&water!==undefined)y=Math.min(y,water-.07)
   if(!shroud.isVisible(Math.floor(x),Math.floor(z))){s.hidden++;continue}
   s.flights++
   const group=p.body==='grenade'?5:p.exhaust?(p.material==='off-white'?0:p.material==='light-grey'?1:2):p.body==='torpedo'?3:4
   const ax=vx||0,ay=Math.hypot(vx,vy,vz)<1e-5?(underwater?-1:1):vy,az=vz
   const count=this.counts[group]
   if(writeAxisTransform(this.matrices[group],count*16,x,y,z,ax,ay,az,p.lengthM,p.radiusM/(group===5?.25:.1),p.radiusM/(group===5?.25:.1))){
    this.counts[group]++;s.bodiesDrawn++
    if(this.chuted.get(view.typeId[i])&&chutes.count<MAX_CHUTES){const k=chutes.count++;chutes.x[k]=x;chutes.y[k]=y;chutes.z[k]=z}
    if(p.exhaust){lights.addLight(x,y,z,1,.35,.08,.22+p.lengthM*.3,1.2+p.lengthM);s.lights++}
   }
   if(advancing&&p.body!=='grenade'&&p.body!=='bomb'&&p.body!=='depth-charge'&&trailing++<16&&time-flight.trailTime>=.039){
    const dist=Math.hypot(x-flight.x,y-flight.y,z-flight.z)
    if(dist<3){
     const n=Math.min(8,remainingPuffs,Math.max(1,Math.ceil(dist/(p.trail.widthM*1.5))))
     for(let k=1;k<=n;k++){
      const t=k/n,tx=flight.x+(x-flight.x)*t,ty=flight.y+(y-flight.y)*t,tz=flight.z+(z-flight.z)*t
      if(particles.spawnTrail(tx,ty,tz,time,(view.id[i]^Math.floor(time*25)^k)|0,p.trail,shroud))s.trailPuffs++
     }
     remainingPuffs-=n
    }
    flight.x=x;flight.y=y;flight.z=z;flight.trailTime=time
   }
  }
  for(const [id,flight] of this.flights)if(flight.seen!==frame)this.flights.delete(id)
  for(let group=0;group<GROUPS;group++)if(this.counts[group]){(this.items[group] as {instanceCount:number}).instanceCount=this.counts[group];render.submit(this.items[group])}
 }
}
