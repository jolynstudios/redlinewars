import CONTENT from '../content-manifest.json'
import type { RenderApi, ShroudApi } from './types'

const PRESETS = CONTENT.particles
/** Storage for the largest tier (fx/vfx-budget: the renderer draws at most 4096 a frame). */
const CAPACITY = 4096
const STRIDE = 18
function hash(value: number): number {let n=Math.imul(value ^ (value>>>16),0x45d9f3b);n=Math.imul(n^(n>>>16),0x45d9f3b);return ((n^(n>>>16))>>>0)/4294967296}

/** Fixed emitter pool; analytic motion is independent of presentation frame rate. */
export class SoftParticles {
 private readonly data=new Float32Array(CAPACITY*STRIDE)
 private readonly active=new Uint8Array(CAPACITY)
 private cursor=0
 /** Slots new particles may take: the quality tier's budget (fx/vfx-budget). */
 private limit=2048
 /**
  * Screen coverage (vfx.md Epic 8): the sum over the frame's visible particles of (radius /
  * distance)^2, about how many screen-fulls of overdraw they would cost. It is measured on
  * everything the pool would draw, thinned or not, so the answer moves smoothly. Above
  * `coverageBudget`, the next frame draws only a stable share of the smoke and dust (each
  * particle's own random value decides, so the same ones stay hidden and nothing flickers),
  * which is what bounds the fill. The flash, the fire, the debris and every trail always draw.
  */
 private coverageBudget=Infinity
 private keep=1
 configure(limit:number,coverageBudget=Infinity):void {this.limit=Math.max(1,Math.min(CAPACITY,limit|0));if(this.cursor>=this.limit)this.cursor=0;this.coverageBudget=coverageBudget>0?coverageBudget:Infinity}
 readonly stats={alive:0,submitted:0,dropped:0,births:0,hiddenBirths:0,coverage:0,peakCoverage:0,drawnCoverage:0,thinned:0}
 /**
  * `countScale` multiplies the preset's count (decorative density, fx/vfx-budget). With a
  * direction (unit vector), the burst leaves along it with `spread` sideways jitter instead of
  * on a horizontal ring: gas out of a barrel, a column out of water.
  */
 spawn(name:string,x:number,y:number,z:number,time:number,seed:number,scale:number,shroud:ShroudApi,countScale=1,dirX=0,dirY=0,dirZ=0,spread=1):void {
  if(!shroud.isVisible(Math.floor(x),Math.floor(z))){this.stats.hiddenBirths++;return}
  let type=-1
  for(let i=0;i<PRESETS.length;i++)if(PRESETS[i].id===name){type=i;break}
  if(type<0)return
  const entry=PRESETS[type]
  const p=entry.preset
  const wake=entry.family==='wake'
  const directed=dirX!==0||dirY!==0||dirZ!==0
  // A side vector for the jitter of a directed burst; any vector not parallel to the direction.
  const sideX=Math.abs(dirY)<.9?-dirZ:1,sideY=0,sideZ=Math.abs(dirY)<.9?dirX:0,sideLen=Math.hypot(sideX,sideY,sideZ)||1
  const count=Math.max(1,Math.round(p.count*countScale))
  for(let k=0;k<count;k++) {
   let slot=-1
   for(let scan=0;scan<this.limit;scan++){const i=(this.cursor+scan)%this.limit;if(!this.active[i]||time-this.data[i*STRIDE+3]>this.data[i*STRIDE+4]){slot=i;break}}
   if(slot<0){this.stats.dropped++;break}
   this.cursor=(slot+1)%this.limit;this.active[slot]=1;this.stats.births++
   const o=slot*STRIDE,d=this.data,s=hash(seed+k*73),a=s*Math.PI*2
   d[o]=x;d[o+1]=y;d[o+2]=z;d[o+3]=time;d[o+4]=p.lifetime*(.7+hash(seed+k+13)*.6)
   // A wake is a ribbon left in world space as the body flies away. The default burst
   // throws every puff on a random horizontal ring, which turns a missile trail into a
   // cloud of scattered dots — the reason rockets looked un-trailed.
   if(directed){
    // Along the direction at 55-100% of the preset speed, jittered sideways and up/down.
    const along=p.speed*scale*(.55+hash(seed+k+3)*.45),side=(hash(seed+k+11)-.5)*spread*p.speed*scale,lift=(hash(seed+k+29)-.5)*spread*p.speed*scale
    const upX=sideY*dirZ-sideZ*dirY,upY=sideZ*dirX-sideX*dirZ,upZ=sideX*dirY-sideY*dirX
    d[o+5]=dirX*along+sideX/sideLen*side+upX/sideLen*lift
    d[o+6]=dirY*along+sideY/sideLen*side+upY/sideLen*lift
    d[o+7]=dirZ*along+sideZ/sideLen*side+upZ/sideLen*lift
   }else if(wake){
    const j=p.speed*scale*0.22
    d[o+5]=(hash(seed+k+3)-.5)*j
    d[o+6]=p.speed*(.35+hash(seed+k+29)*.4)*scale
    d[o+7]=(hash(seed+k+11)-.5)*j
   }else{
    d[o+5]=Math.cos(a)*p.speed*scale;d[o+6]=p.speed*(.4+hash(seed+k+29))*scale;d[o+7]=Math.sin(a)*p.speed*scale
   }
   d[o+8]=type;d[o+9]=scale;d[o+10]=s*40;d[o+11]=p.size*(.7+hash(seed+k+97)*.6)
  }
 }
 spawnTrail(x:number,y:number,z:number,time:number,seed:number,profile:{readonly widthM:number;readonly lifetimeS:number;readonly colorLinearRGB:readonly number[];readonly opacity:number;readonly turbulence:number},shroud:ShroudApi):boolean {
  if(!shroud.isVisible(Math.floor(x),Math.floor(z))){this.stats.hiddenBirths++;return false}
  let slot=-1
  for(let scan=0;scan<this.limit;scan++){const i=(this.cursor+scan)%this.limit;if(!this.active[i]||time-this.data[i*STRIDE+3]>this.data[i*STRIDE+4]){slot=i;break}}
  if(slot<0){this.stats.dropped++;return false}
  this.cursor=(slot+1)%this.limit;this.active[slot]=1;this.stats.births++
  const o=slot*STRIDE,d=this.data
  d[o]=x;d[o+1]=y;d[o+2]=z;d[o+3]=time;d[o+4]=profile.lifetimeS;d[o+8]=-1
  d[o+5]=(hash(seed+3)-.5)*profile.turbulence;d[o+6]=profile.turbulence*.6;d[o+7]=(hash(seed+11)-.5)*profile.turbulence
  d[o+10]=hash(seed)*40;d[o+11]=profile.widthM
  d[o+12]=profile.colorLinearRGB[0];d[o+13]=profile.colorLinearRGB[1];d[o+14]=profile.colorLinearRGB[2];d[o+15]=profile.opacity
  return true
 }
 update(time:number,render:RenderApi,shroud:ShroudApi):void {
  this.keep=this.stats.coverage>this.coverageBudget?this.coverageBudget/this.stats.coverage:1
  this.stats.alive=0;this.stats.submitted=0;this.stats.thinned=0
  const eye=render.camera?.position,ex=eye?.[0]??0,ey=eye?.[1]??0,ez=eye?.[2]??0
  let coverage=0,drawnCoverage=0
  for(let i=0;i<CAPACITY;i++) {
   if(!this.active[i])continue
   const o=i*STRIDE,d=this.data,age=time-d[o+3],life=age/d[o+4]
   // Birth times are stored as float32 and events spawn before this update runs in the same
   // frame, so a fresh particle's age is time minus its rounded birth: up to a few 1e-7 below
   // zero whenever float32 rounded up, which was about half of them. `age < 0` read that as a
   // rewound clock and deleted the particle on its first frame, so every weapon's smoke, dust
   // and fire drew roughly half of what it spawned. A real rewind (seek, new match) is seconds.
   if(life>=1||age<-1e-3){this.active[i]=0;continue}
   this.stats.alive++
   if(d[o+8]===-1){
    const x=d[o]+d[o+5]*age,z=d[o+2]+d[o+7]*age,y=d[o+1]+d[o+6]*age
    if(shroud.isVisible(Math.floor(d[o]),Math.floor(d[o+2]))&&shroud.isVisible(Math.floor(x),Math.floor(z))){
     const radius=d[o+11]*(1+life*2),dist=Math.max(1,Math.hypot(x-ex,y-ey,z-ez)),cover=(radius/dist)**2;coverage+=cover;drawnCoverage+=cover
     render.addParticle?.(x,y,z,radius,d[o+12],d[o+13],d[o+14],d[o+15]*(1-life)**1.4,age,d[o+10],0);this.stats.submitted++
    }
    continue
   }
   const entry=PRESETS[d[o+8]],p=entry.preset,ballistic=entry.family==='debris'||entry.family==='splash'
   const wake=entry.family==='wake'
   const drag=ballistic?age:(1-Math.exp(-age))
   const x=d[o]+d[o+5]*drag,z=d[o+2]+d[o+7]*drag
   const y=d[o+1]+d[o+6]*age-(ballistic?2.8*age*age:0)
   if(!shroud.isVisible(Math.floor(d[o]),Math.floor(d[o+2]))||!shroud.isVisible(Math.floor(x),Math.floor(z)))continue
   const growth=ballistic?1:wake?1+life*1.15:1+life*2.3
   const opacity=wake
    ?p.opacity*Math.min(1,age*10+.22)*(1-life)**0.9
    :p.opacity*Math.min(1,age*18+.1)*(1-life)**1.3
   const radius=d[o+11]*d[o+9]*growth,dist=Math.max(1,Math.hypot(x-ex,y-ey,z-ez)),cover=(radius/dist)**2
   coverage+=cover
   // Over the coverage budget: a stable share of the smoke and dust, never the rest.
   if(this.keep<1&&(entry.family==='smoke'||entry.family==='dust')&&d[o+10]/40>=this.keep){this.stats.thinned++;continue}
   drawnCoverage+=cover
   render.addParticle?.(x,y,z,radius,p.color[0],p.color[1],p.color[2],opacity,age,d[o+10],p.emission)
   this.stats.submitted++
  }
  this.stats.coverage=coverage
  this.stats.drawnCoverage=drawnCoverage
  if(coverage>this.stats.peakCoverage)this.stats.peakCoverage=coverage
 }
 dispose():void {this.active.fill(0)}
}
