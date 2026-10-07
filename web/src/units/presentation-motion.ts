// Bounded, presentation-only secondary motion. One placed matrix feeds every attachment.
export interface MotionProfile {
 readonly kind: 'rotor' | 'plane' | 'ship' | 'sub'
 readonly heave: number; readonly frequency: number; readonly sway: number
 readonly pitch: number; readonly roll: number; readonly response: number
 readonly depth?: number
}
export const MOTION_PROFILES: Readonly<Record<string, MotionProfile>> = {
 heli: {kind:'rotor',heave:.045,frequency:1.6,sway:.026,pitch:.032,roll:.045,response:2.5},
 hind: {kind:'rotor',heave:.038,frequency:1.3,sway:.021,pitch:.030,roll:.040,response:1.8},
 mh60: {kind:'rotor',heave:.042,frequency:1.5,sway:.025,pitch:.034,roll:.045,response:2.2},
 tran: {kind:'rotor',heave:.030,frequency:.85,sway:.018,pitch:.022,roll:.028,response:1.0},
 yak: {kind:'plane',heave:.030,frequency:1.8,sway:0,pitch:.020,roll:.15,response:2.8},
 mig: {kind:'plane',heave:.018,frequency:1.4,sway:0,pitch:.017,roll:.23,response:3.6},
 u2: {kind:'plane',heave:.024,frequency:.8,sway:0,pitch:.012,roll:.10,response:1.3},
 badr: {kind:'plane',heave:.026,frequency:.7,sway:0,pitch:.014,roll:.11,response:1.1},
 'badr.bomber': {kind:'plane',heave:.026,frequency:.7,sway:0,pitch:.014,roll:.11,response:1.1},
 pt: {kind:'ship',heave:.037,frequency:1.8,sway:0,pitch:.030,roll:.046,response:2.0},
 lst: {kind:'ship',heave:.026,frequency:1.25,sway:0,pitch:.022,roll:.032,response:1.6},
 dd: {kind:'ship',heave:.021,frequency:1.05,sway:0,pitch:.016,roll:.026,response:1.3},
 ca: {kind:'ship',heave:.015,frequency:.75,sway:0,pitch:.011,roll:.018,response:.9},
 ss: {kind:'sub',heave:.019,frequency:1.0,sway:0,pitch:.014,roll:.022,response:1.1,depth:.82},
 msub: {kind:'sub',heave:.016,frequency:.8,sway:0,pitch:.012,roll:.019,response:.9,depth:.82},
}
const CAP=4096, STRIDE=12
const clamp=(v:number,a:number,b:number)=>Math.min(b,Math.max(a,v))
const smooth=(v:number)=>v*v*(3-2*v)
/** Postmultiply local pitch/roll, preserving uniform scale and the yaw convention. */
export function tiltPresentation(m:Float32Array,o:number,pitch:number,roll:number):void {
 const cp=Math.cos(pitch),sp=Math.sin(pitch),cr=Math.cos(roll),sr=Math.sin(roll)
 for(let axis=0;axis<3;axis++) {
  const f=m[o+axis],u=m[o+4+axis],l=m[o+8+axis]
  m[o+axis]=f*cp+u*sp
  m[o+4+axis]=-f*sp*cr+u*cp*cr+l*sr
  m[o+8+axis]=f*sp*sr-u*cp*sr+l*cr
 }
}
export class PresentationMotion {
 private readonly ids=new Uint32Array(CAP)
 private readonly used=new Uint8Array(CAP)
 private readonly state=new Float64Array(CAP*STRIDE)
 clear():void {this.used.fill(0)}
 apply(m:Float32Array,o:number,id:number,p:MotionProfile,time:number,x:number,z:number,yaw:number,
  altitude:number,active:boolean,windX:number,windZ:number,wind:number,min:Float32Array,max:Float32Array,
  heightAt:(x:number,z:number)=>number,moving=false):void {
  if(!active)return
  let slot=id%CAP
  for(let probe=0;probe<32;probe++,slot=(slot+1)%CAP)
   if(!this.used[slot]||this.ids[slot]===id||time-this.state[slot*STRIDE+2]>.5)break
  const b=slot*STRIDE,s=this.state,dt=time-s[b+2]
  const fresh=!this.used[slot]||this.ids[slot]!==id||dt<0||dt>.5||Math.hypot(x-s[b],z-s[b+1])>3
  if(fresh){s.fill(0,b,b+STRIDE);s[b]=x;s[b+1]=z;s[b+2]=time;s[b+3]=yaw;s[b+9]=moving?time:time-1;s[b+10]=p.kind==='sub'&&!moving?-(p.depth??.8):0}
  this.used[slot]=1;this.ids[slot]=id
  if(!fresh&&dt>0){
   const speed=Math.hypot(x-s[b],z-s[b+1])/dt
   const turn=Math.atan2(Math.sin(yaw-s[b+3]),Math.cos(yaw-s[b+3]))/dt
   const blend=1-Math.exp(-dt*p.response)
   const acceleration=clamp((speed-s[b+4])/dt,-3,3)
   s[b+5]+=(clamp(turn,-2,2)-s[b+5])*blend
   s[b+6]+=(acceleration-s[b+6])*blend
   s[b+7]+=(speed-s[b+7])*blend
   if(speed>.05)s[b+9]=time
   const target=time-s[b+9]<.85?0:-(p.depth??0)
   s[b+10]+=(target-s[b+10])*(1-Math.exp(-dt*.7))
   s[b+4]=speed;s[b]=x;s[b+1]=z;s[b+2]=time;s[b+3]=yaw
  }
  const flying=p.kind==='rotor'||p.kind==='plane'
  const envelope=flying?smooth(clamp(altitude/.65,0,1)):1
  const phase=(id%997)*.61803398875
  // Two shared wave directions; larger vessels filter short waves through their profile.
  const wave=time*p.frequency+x*(.35+windX*.12)+z*(.27+windZ*.12)
  const a=flying?time*p.frequency+phase:wave
  const strength=flying?1:.55+clamp(wind,0,1)*.8
  const sub=p.kind==='sub'?clamp(1+s[b+10]/(p.depth??.8)*.72,.28,1):1
  const pitch=(Math.sin(a)*p.pitch*.35-s[b+6]*p.pitch-(p.kind==='rotor'?s[b+7]*p.pitch*.3:0))*envelope*strength*sub
  const roll=(Math.sin(a*.73+phase)*p.roll*.3+s[b+5]*p.roll)*envelope*strength*sub
  const sway=Math.sin(a*.47+phase)*p.sway*envelope
  m[o+12]+=m[o+8]*sway;m[o+14]+=m[o+10]*sway
  m[o+13]+=Math.sin(a)*p.heave*envelope*strength*sub+(p.kind==='sub'?s[b+10]:0)
  tiltPresentation(m,o,pitch,roll)
  if(flying&&envelope>0){
   // Test the tilted bottom corners plus centre, so a bank never spends terrain clearance.
   let lift=0
   for(let k=0;k<5;k++){
    const lx=k===4?0:(k&1?max[0]:min[0]),lz=k===4?0:(k&2?max[2]:min[2]),ly=min[1]
    const wx=m[o+12]+m[o]*lx+m[o+4]*ly+m[o+8]*lz
    const wy=m[o+13]+m[o+1]*lx+m[o+5]*ly+m[o+9]*lz
    const wz=m[o+14]+m[o+2]*lx+m[o+6]*ly+m[o+10]*lz
    lift=Math.max(lift,heightAt(wx,wz)+.02*envelope-wy)
   }
   m[o+13]+=lift
  }
 }
}

/** Visible static buildings only. Roof envelopes protect the visual bank, not the flight path. */
export class AirspaceClearance {
 private count=0
 private readonly boxes=new Float32Array(512*5)
 reset():void {this.count=0}
 add(x:number,z:number,hx:number,hz:number,top:number):void {
  if(this.count>=512)return
  const b=this.count++*5;this.boxes[b]=x;this.boxes[b+1]=z;this.boxes[b+2]=hx;this.boxes[b+3]=hz;this.boxes[b+4]=top
 }
 height(x:number,z:number,ground:number):number {
  let h=ground
  for(let i=0;i<this.count;i++){const b=i*5,d=this.boxes
   // Smooth 0.7m shoulder prevents a discontinuous roof step during small hover drift.
   const distance=Math.max(Math.abs(x-d[b])-d[b+2],Math.abs(z-d[b+1])-d[b+3])
   if(distance<.7){const t=Math.max(0,Math.min(1,1-distance/.7));h=Math.max(h,ground+(d[b+4]-ground)*t*t*(3-2*t))}
  }
  return h
 }
}
