import { fetchAssetPack } from '../core/asset-pack'
import { computeSkinMatrices,computeWorldTransforms } from '../geo/rig'
import { HeaderFlag,Surface,ShroudState,type Snapshot,type Ctx } from '../core'
import CONTENT from '../content-manifest.json'
import { decodeBlenderAsset,type BlenderAsset } from './blender-mesh'
import type { RenderApi,TerrainApi,ShroudApi,DrawItem } from './types'
import { WallConnections } from './wall-connections'
import { scenicPose } from './scenic-pose'
type Rig=NonNullable<ReturnType<typeof decodeBlenderAsset>['rig']>
interface Pool {count:number;transforms:Float32Array;colors:Uint8Array;damages:Float32Array;palettes:Uint16Array;item:DrawItem;rig:Rig|null;pose:ReturnType<Rig['skeleton']['createPose']>|null;world:Float32Array|null}
interface Manifest {schema:number;bytes:number;storedBytes:number;sha256:string;assets:Record<string,BlenderAsset>}
const manifests=import.meta.glob<Manifest>('../../.forge/living/manifest.json',{eager:true,import:'default'})
const packs=import.meta.glob<string>('../../.forge/living/living.ssasset.gz',{eager:true,query:'?url',import:'default'})
const LIMIT=256
const ANIMALS=['cow','sheep','deer','rabbit','fish']
interface ScenicSpawn {name:string;x:number;z:number;seed:number;water:boolean;homeX:number;homeZ:number;previousX:number;previousZ:number;heading:number;travel:number;previousTravel:number;decor:boolean}
function noise(n:number):number{let x=Math.imul(n^0x574a,0x45d9f3b);x=Math.imul(x^(x>>>16),0x45d9f3b);return ((x^(x>>>16))>>>0)/4294967296}

export class LivingScenery {
 private readonly pools=new Map<string,Pool>()
 private readonly wallNames=new Map<string,readonly string[]>()
 readonly connections=new WallConnections()
 private readonly spawns: ScenicSpawn[]=[]
 private lastTick=-1
 readonly stats={assets:0,walls:0,wildlife:0,ruins:0,avoided:0,error:''}
 async init(render:RenderApi):Promise<void>{
  const manifest=Object.values(manifests)[0],url=Object.values(packs)[0]
  if(!manifest&&!url)return
  if(!manifest||!url||manifest.schema!==1)throw new Error('Incomplete living asset pack')
  const bytes=await fetchAssetPack(url,manifest)
  for(const [name,asset] of Object.entries(manifest.assets)){
   const decoded=decodeBlenderAsset(bytes,asset),mesh=render.upload(decoded.mesh,`living.${name}`)
   const transforms=new Float32Array(LIMIT*16),colors=new Uint8Array(LIMIT),damages=new Float32Array(LIMIT),palettes=new Uint16Array(LIMIT)
   const rig=decoded.rig
   const pool:Pool={count:0,transforms,colors,damages,palettes,rig,pose:rig?.skeleton.createPose()??null,world:rig?.skeleton.createMatrixBuffer()??null,
    item:{mesh,surfaceSet:'blender',instances:transforms,playerColors:colors,damages,paletteBases:palettes,boneCount:rig?.skeleton.boneCount??0,castsShadow:true,get instanceCount(){return pool.count}}}
   this.pools.set(name,pool)
  }
  for(const name of ['sbag','brik']){
   const names=CONTENT.wallConnections.filter(v=>v.assetId===name).sort((a,b)=>a.mask-b.mask).map(v=>v.variant)
   if(names.length!==16||names.some(n=>!this.pools.has(n)))throw new Error(`Missing wall mesh variants: ${name}`)
   this.wallNames.set(name,names)
  }
  this.stats.assets=this.pools.size
 }
 onSnapshot(snap:Snapshot,names:ReadonlyMap<number,string|null>,shroud:ShroudApi):void {
  this.connections.sync(snap,names,shroud)
  if(!(snap.flags&HeaderFlag.terrainStaticPresent)||!snap.terrainStatic)return
  this.spawns.length=0
  this.lastTick=-1
  const grid=snap.terrainStatic,ox=snap.world?.boundsLeft??0,oz=snap.world?.boundsTop??0
  // Sparse scenic populations on suitable ground; they never become simulation obstacles.
  for(let z=4;z<grid.h-4;z+=7)for(let x=4;x<grid.w-4;x+=7){
   const i=z*grid.w+x,seed=i+grid.w*73,water=grid.surface[i]===Surface.water
   if(grid.resource[i]||(!water&&grid.surface[i]!==Surface.grass&&grid.surface[i]!==Surface.soil))continue
   if(noise(seed)>.28)continue
   const decor=!water&&noise(seed)>.20
   const name=decor?['ruin','unfinished','graveyard'][Math.floor(noise(seed+19)*3)]:water?'fish':ANIMALS[Math.floor(noise(seed+17)*4)]
   const wx=x+ox+.5,wz=z+oz+.5
   this.spawns.push({name,x:wx,z:wz,homeX:wx,homeZ:wz,previousX:wx,previousZ:wz,seed,water,heading:noise(seed+3)*Math.PI*2,travel:0,previousTravel:0,decor})
   if(this.spawns.length>=80)return
  }
 }
 begin():void {for(const p of this.pools.values())p.count=0;this.stats.walls=0;this.stats.wildlife=0;this.stats.ruins=0;this.stats.avoided=0}
 wall(name:string|undefined|null,id:number,x:number,y:number,z:number,owner:number,damage:number):boolean {
  if(!name)return false
  const variants=this.wallNames.get(name);if(!variants)return false
  const p=this.pools.get(variants[this.connections.masks.get(id)??0])!
  if(p.count>=LIMIT)return false
  this.place(p,x,y,z,0,1,owner,damage);this.stats.walls++;return true
 }
 update(ctx:Ctx,render:RenderApi,terrain:TerrainApi,shroud:ShroudApi):void {
  const time=(ctx.time.tick+ctx.time.alpha)/25,actors=ctx.snapshot?.actors
  if(ctx.time.tick!==this.lastTick){
   const dt=this.lastTick<0?0:Math.min(.2,Math.max(0,(ctx.time.tick-this.lastTick)/25))
   this.lastTick=ctx.time.tick
   for(let i=0;i<this.spawns.length;i++){
    const spawn=this.spawns[i]
    spawn.previousX=spawn.x;spawn.previousZ=spawn.z;spawn.previousTravel=spawn.travel
    if(spawn.decor||!dt)continue
    // Local, fixed-simulation-time scenic motion. Rest phases plant the feet.
    if(!spawn.water&&Math.floor(time/7+noise(spawn.seed)*4)%3===0)continue
    spawn.heading+=Math.sin(time*.3+spawn.seed)*dt*.4
    if(Math.hypot(spawn.x-spawn.homeX,spawn.z-spawn.homeZ)>1.7)
     spawn.heading=Math.atan2(spawn.homeZ-spawn.z,spawn.homeX-spawn.x)
    const step=dt*(spawn.water?.11:.075),x=spawn.x+Math.cos(spawn.heading)*step,z=spawn.z+Math.sin(spawn.heading)*step
    let blocked=spawn.water!==(terrain.waterHeightAt(x,z)!==null)||Math.abs(terrain.heightAt(x,z)-terrain.heightAt(spawn.x,spawn.z))>step*.8
    if(actors)for(let j=0;j<actors.count&&!blocked;j++){
     const ax=actors.posX[j]/1024,az=actors.posY[j]/1024
     if(shroud.isVisible(Math.floor(ax),Math.floor(az))&&Math.hypot(ax-x,az-z)<.9)blocked=true
    }
    for(let j=0;j<this.spawns.length&&!blocked;j++){
     if(i===j)continue
     const other=this.spawns[j]
     if(Math.hypot(other.x-x,other.z-z)<(other.decor?1.25:.25))blocked=true
    }
    if(blocked){spawn.heading+=1.1;this.stats.avoided++}
    else{spawn.x=x;spawn.z=z;spawn.travel+=step}
   }
  }
  for(let i=0;i<this.spawns.length;i++){
   const spawn=this.spawns[i],p=this.pools.get(spawn.name);if(!p||p.count>=LIMIT)continue
   const x=spawn.previousX+(spawn.x-spawn.previousX)*ctx.time.alpha,z=spawn.previousZ+(spawn.z-spawn.previousZ)*ctx.time.alpha
   if(spawn.decor?shroud.stateAt(Math.floor(x),Math.floor(z))===ShroudState.unexplored:!shroud.isVisible(Math.floor(x),Math.floor(z)))continue
   const water=terrain.waterHeightAt(x,z)
   if(spawn.water!==(water!==null))continue
   const y=water!==null?water-.18:terrain.heightAt(x,z)
   const index=p.count
   const scale=spawn.decor?1:spawn.water?.4:.3
   this.place(p,x,y,z,-spawn.heading,scale,0,0)
   if(p.rig&&p.pose&&p.world){
    const reserved=render.reserveBones(p.rig.skeleton.boneCount)
    if(reserved){
     const travel=spawn.previousTravel+(spawn.travel-spawn.previousTravel)*ctx.time.alpha
     scenicPose(p.rig,p.pose,time,travel,scale,noise(spawn.seed)*Math.PI*2)
     computeWorldTransforms(p.pose,p.world);computeSkinMatrices(p.rig.skeleton,p.world,reserved.matrices);p.palettes[index]=reserved.base
    }
   }
   if(spawn.decor)this.stats.ruins++;else this.stats.wildlife++
  }
  for(const p of this.pools.values())if(p.count)render.submit(p.item)
 }
 private place(p:Pool,x:number,y:number,z:number,yaw:number,scale:number,owner:number,damage:number):void {
  const i=p.count++,o=i*16,m=p.transforms,c=Math.cos(yaw)*scale,s=Math.sin(yaw)*scale
  m[o]=c;m[o+1]=0;m[o+2]=-s;m[o+3]=0;m[o+4]=0;m[o+5]=scale;m[o+6]=0;m[o+7]=0
  m[o+8]=s;m[o+9]=0;m[o+10]=c;m[o+11]=0;m[o+12]=x;m[o+13]=y;m[o+14]=z;m[o+15]=1
  p.colors[i]=owner;p.damages[i]=damage;p.palettes[i]=0
 }
 dispose():void{this.pools.clear();this.spawns.length=0;this.connections.dispose()}
}
