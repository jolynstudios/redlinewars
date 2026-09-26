// Soft engine trails from source-bound nozzles on the same placed matrix as the aircraft.
import {ActorFlag,findActorIndex,type Ctx} from '../core'
import manifest from '../core/presentation-manifest.json'
import type {ShroudApi,TerrainApi,UnitsApi} from './types'
import type {SoftParticles} from './particles'
interface Nozzle {position:readonly number[]}
const PLANS=Object.entries(manifest.actors).filter(([name])=>['mig','u2','badr','badr.bomber'].includes(name)) as [string,{exhausts?:readonly Nozzle[]}][]
const TRAIL={widthM:.06,lifetimeS:1.4,colorLinearRGB:[.70,.73,.76],opacity:.27,turbulence:.008}
export interface AircraftContrailStats {types:number;flying:number;spawned:number}
export class AircraftContrails {
 readonly stats:AircraftContrailStats={types:PLANS.length,flying:0,spawned:0}
 private last=-1;private previous=0;private time=0;private count=0
 private ctx:Ctx|null=null;private shroud:ShroudApi|null=null;private particles:SoftParticles|null=null
 private nozzles:readonly Nozzle[]=[]
 private readonly emit=(m:Float32Array,o:number,id:number):void=>{
  const a=this.ctx?.snapshot?.actors;if(!a)return
  const i=findActorIndex(a,id)
  if(i<0||a.health[i]===0||(a.flags[i]&(ActorFlag.husk|ActorFlag.cloaked|ActorFlag.submerged))!==0||a.speed[i]===65535||a.speed[i]<6||a.posZ[i]<512)return
  if(!this.shroud!.isVisible(Math.floor(m[o+12]),Math.floor(m[o+14])))return
  this.stats.flying++;if(this.count++>=16)return
  const phase=(id%31)/31*.08
  if(Math.floor((this.previous+phase)/.08)===Math.floor((this.time+phase)/.08))return
  for(const nozzle of this.nozzles){const [x,y,z]=nozzle.position
   if(this.particles!.spawnTrail(m[o+12]+m[o]*x+m[o+4]*y+m[o+8]*z,m[o+13]+m[o+1]*x+m[o+5]*y+m[o+9]*z,m[o+14]+m[o+2]*x+m[o+6]*y+m[o+10]*z,this.time,id,TRAIL,this.shroud!))this.stats.spawned++
  }
 }
 tick(_dt:number,time:number,ctx:Ctx,particles:SoftParticles,shroud:ShroudApi,_terrain:TerrainApi|null):void {
  this.stats.flying=this.stats.spawned=0
  if(this.last<0||time<this.last){this.last=time;return}
  if(time===this.last)return
  this.previous=this.last;this.last=this.time=time;this.count=0;this.ctx=ctx;this.shroud=shroud;this.particles=particles
  const units=ctx.get<UnitsApi>('units')
  for(const [name,plan]of PLANS){this.nozzles=plan.exhausts??[];units.visitVisibleInstances?.(name,this.emit)}
 }
}
