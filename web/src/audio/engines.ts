// Optional motor beds borrow combat slots. A shot always reclaims a motor slot immediately.
import {ActorFlag,HeaderFlag,type Ctx} from '../core'
interface Profile {kind:number;rate:number;gain:number;hover:boolean}
const profiles:Readonly<Record<string,Profile>>={
 heli:{kind:0,rate:1.1,gain:.10,hover:true},hind:{kind:0,rate:.9,gain:.13,hover:true},mh60:{kind:0,rate:1,gain:.11,hover:true},tran:{kind:1,rate:.78,gain:.16,hover:true},
 yak:{kind:2,rate:1.15,gain:.09,hover:false},mig:{kind:3,rate:1.35,gain:.08,hover:false},badr:{kind:3,rate:.75,gain:.11,hover:false},'badr.bomber':{kind:3,rate:.75,gain:.11,hover:false},u2:{kind:3,rate:.9,gain:.08,hover:false},
 pt:{kind:4,rate:1.2,gain:.07,hover:false},dd:{kind:4,rate:.85,gain:.08,hover:false},ca:{kind:4,rate:.65,gain:.09,hover:false},lst:{kind:4,rate:1,gain:.08,hover:false},ss:{kind:4,rate:.7,gain:.045,hover:false},msub:{kind:4,rate:.6,gain:.05,hover:false},
 // Ore hauler: the per-actor bed replaces the shared surface loops for harvesters —
 // hasProfile() excludes them from those beds, and this path is screen-gated per
 // actor (visible() below), so a harvester is only heard when it is on screen.
 harv:{kind:5,rate:.85,gain:.12,hover:false},
}

// Medium passed. High exceeded +0.5ms GPU-completion p95 with eight beds: leave disabled.
// Ultra admission is checked by tools/enginebudgetgate.mjs against its retained measurements.
export const ENGINE_LIMITS:Readonly<Record<string,number>>={classic:0,low:0,medium:4,high:0,ultra:8}
export interface EngineSlot {gain:GainNode;pan:StereoPannerNode;lp:BiquadFilterNode;freeAt:number;engine?:AudioBufferSourceNode;engineId?:number}
/** Integer-frequency synthesis gives a seamless one-second loop with no decoded media. */
export function engineSamples(kind:number,sampleRate:number):Float32Array<ArrayBuffer> {
 const out=new Float32Array(sampleRate)
 const fundamental=[72,48,96,115,40,55][kind],pulse=[18,12,32,0,8,10][kind]
 for(let i=0;i<out.length;i++){
  const t=i/sampleRate,a=t*Math.PI*2
  const carrier=Math.sin(a*fundamental)*.36+Math.sin(a*fundamental*2)*.17+Math.sin(a*(fundamental*3+1))*.10
  const chop=pulse?(.3+.7*((1+Math.sin(a*pulse))*.5)**3):.6
  const tandem=kind===1?.65+.35*((1+Math.sin(a*13+1.7))*.5)**2:1
  const whine=kind===3?.08*(Math.sin(a*741)+Math.sin(a*983)):.02*Math.sin(a*301)
  out[i]=(carrier*chop*tandem+whine)*.42
 }
 return out
}
export class EngineVoices {
 private buffers:AudioBuffer[]=[]
 // ElevenLabs gait beds injected per kind; synthesis stays as the fallback.
 private readonly overrides=new Map<number,AudioBuffer>()
 private readonly selected=new Uint32Array(8)
 private readonly weights=new Float64Array(8)
 private readonly indices=new Int32Array(8)
 private readonly cache=new Map<number,Profile|null>()
 readonly stats={active:0,decodedBytes:0,preemptions:0}
 init(actx:AudioContext):void {
  if(this.buffers.length)return
  for(let kind=0;kind<6;kind++){
   const injected=this.overrides.get(kind)
   if(injected){this.buffers.push(injected);this.stats.decodedBytes+=injected.length*4;continue}
   const data=engineSamples(kind,actx.sampleRate),buffer=actx.createBuffer(1,data.length,actx.sampleRate)
   buffer.copyToChannel(data,0);this.buffers.push(buffer);this.stats.decodedBytes+=data.byteLength
  }
 }
 /** Swap the synthesized kind bed for a real recording (engine_<kind> ElevenLabs clip). */
 setKindClip(kind:number,buffer:AudioBuffer):void {
  this.overrides.set(kind,buffer)
  if(this.buffers.length>kind)this.buffers[kind]=buffer
 }
 private profile(ctx:Ctx,type:number):Profile|null {
  let p=this.cache.get(type);if(p===undefined){p=profiles[ctx.actorTypeName(type)]??null;this.cache.set(type,p)}
  return p
 }
 hasProfile(ctx:Ctx,type:number):boolean {return this.profile(ctx,type)!==null}
 update(ctx:Ctx,actx:AudioContext,slots:EngineSlot[],eye:Float32Array,right:Float32Array,visible:(x:number,z:number)=>boolean):void {
  const limit=ENGINE_LIMITS[ctx.config.q.name]??0,a=ctx.snapshot?.actors
  this.selected.fill(0);this.weights.fill(0);this.stats.active=0
  const running=limit>0&&a&&((ctx.snapshot?.flags??0)&HeaderFlag.paused)===0
  if(running)for(let i=0;i<a.count;i++){
   if((a.flags[i]&ActorFlag.husk)!==0||a.health[i]===0)continue
   if((a.flags[i]&(ActorFlag.cloaked|ActorFlag.submerged))!==0&&a.owner[i]!==ctx.snapshot?.world?.renderPlayer)continue
   const p=this.profile(ctx,a.typeId[i])
   if(!p)continue
   const speed=a.speed[i]===65535?0:a.speed[i]
   if(!p.hover&&speed<2)continue
   const x=a.posX[i]/1024,z=a.posY[i]/1024;if(!visible(x,z))continue
   const distance=Math.hypot(x-eye[0],a.posZ[i]/1024-eye[1],z-eye[2]);if(distance>80)continue
   const weight=p.gain/Math.max(4,distance*distance)
   let at=0;while(at<limit&&this.weights[at]>=weight)at++;if(at>=limit)continue
   for(let j=limit-1;j>at;j--){this.selected[j]=this.selected[j-1];this.weights[j]=this.weights[j-1];this.indices[j]=this.indices[j-1]}
   this.selected[at]=a.id[i];this.weights[at]=weight;this.indices[at]=i
  }
  for(const slot of slots)if(slot.engine&&!this.selected.includes(slot.engineId??0))this.stop(slot)
  if(!running)return
  for(let j=0;j<limit;j++){
   const id=this.selected[j];if(!id)continue
   const i=this.indices[j],p=this.cache.get(a.typeId[i])!
   let slot=slots.find(s=>s.engineId===id&&s.engine)
   if(!slot){slot=slots.find(s=>!s.engine&&s.freeAt<=actx.currentTime);if(!slot)continue
    const src=actx.createBufferSource();src.buffer=this.buffers[p.kind];src.loop=true;src.connect(slot.gain);src.start(0,((ctx.time.tick+ctx.time.alpha)/25)%(this.buffers[p.kind]?.duration||1))
    slot.engine=src;slot.engineId=id;slot.freeAt=Infinity
   }
   const speed=a.speed[i]===65535?0:a.speed[i]
   slot.gain.gain.value=Math.min(.09,this.weights[j]*16)*(p.hover?1:Math.min(1,speed/70))
   const dx=a.posX[i]/1024-eye[0],dz=a.posY[i]/1024-eye[2]
   slot.pan.pan.value=Math.max(-.85,Math.min(.85,(dx*right[0]+dz*right[2])/Math.max(1,Math.hypot(dx,dz))))
   slot.lp.frequency.value=this.overrides.has(p.kind)?16000:1200;slot.engine!.playbackRate.value=p.rate*(p.hover?1: .85+Math.min(.25,speed/600));this.stats.active++
  }
 }
 stop(slot:EngineSlot):void {slot.engine?.stop();slot.engine?.disconnect();slot.engine=undefined;slot.engineId=undefined;slot.freeAt=0;slot.gain.gain.value=0}
 reset(slots:EngineSlot[]):void {for(const s of slots)if(s.engine)this.stop(s);this.cache.clear();this.stats.active=0}
 clear(slots:EngineSlot[]):void {for(const s of slots)if(s.engine)this.stop(s);this.buffers=[];this.cache.clear();this.stats.active=this.stats.decodedBytes=0}
}
