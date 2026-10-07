import { ZONE_BYTE_OFFSET, type Mesh, type GpuMeshBuffers } from '../geo/mesh'

export interface WindowPane {
 /** Pane seed, 16 bits, from the pane's own centre. Rooms derive from it: `windowRoomSeed(seed, cell)`. */
 readonly seed:number
 /**
  * Pane metadata byte, packed by `extractWindowGeometry` and read back identically by the
  * WGSL in this file: bit 7 marks annotated glass, bits 6..2 the floor (0..31, the dark-floor
  * hash input), bit 1 the room-split axis (1 = along z, 0 = along x — the pane's own dominant
  * face-normal axis, NOT the per-vertex normal, which disagrees with its pane on half of the
  * authored glass), bit 0 the family (1 = industrial). CPU and GPU must decode this byte the
  * same way or a window's light and its emissive pane blink against each other.
  */
 readonly flags:number
 readonly center:readonly number[]; readonly min:readonly number[]; readonly max:readonly number[]
 readonly normal:readonly number[]
}
export interface WindowGeometry { readonly panes:readonly WindowPane[] }

function hash(x:number):number {
 x=Math.imul(x^(x>>>16),0x7feb352d); x=Math.imul(x^(x>>>15),0x846ca68b)
 return (x^(x>>>16))>>>0
}
export function buildingWindowSeed(x:number,z:number):number {
 return hash(Math.imul(Math.floor(x*64),73856093)^Math.imul(Math.floor(z*64),19349663))
}
/** Stable rooms and dark floors. Neither camera, time nor graphics quality enter the seed. */
export function windowState(seed:number,flags:number,building:number):number {
 const industrial=(flags&1)!==0, floor=(flags>>>2)&31
 if(!industrial && hash(building^Math.imul(floor+1,83492791))%11<3)return 0
 const r=hash(building^seed)%100
 return r<(industrial?25:48)?0:r<(industrial?40:68)?0.18:r<(industrial?90:93)?0.65:1
}
export function windowRoomSeed(seed:number,cell:number):number {return hash(seed^Math.imul(cell,73856093))&0xffffff}
export const WINDOW_ROOM_WIDTH = 0.32
export function windowRooms(pane:WindowPane):WindowPane[] {
 // The split axis comes from the pane's packed flags so the CPU rooms and the WGSL rooms
 // (windowEmission) are the SAME rooms: one seed source, one axis, one cell numbering.
 const axis=(pane.flags&2)?2:0
 const rooms:WindowPane[]=[]
 for(let cell=Math.floor(pane.min[axis]/WINDOW_ROOM_WIDTH);cell<=Math.floor((pane.max[axis]-1e-6)/WINDOW_ROOM_WIDTH);cell++){
  const lo=Math.max(pane.min[axis],cell*WINDOW_ROOM_WIDTH),hi=Math.min(pane.max[axis],(cell+1)*WINDOW_ROOM_WIDTH)
  if(hi-lo<.005)continue
  const center=[...pane.center];center[axis]=(lo+hi)*.5
  rooms.push({...pane,seed:windowRoomSeed(pane.seed,cell),center})
 }
 return rooms
}
/** Only damaged circuits fail. A seeded, sparse dropout replaces frame-random blinking. */
export function windowCircuitFactor(seed:number,flags:number,building:number,damage:number,seconds:number):number {
 if(damage>=.9)return 0
 const strength=1-Math.max(0,damage)*.25
 const circuit=((flags>>>2)&31)*5+((seed>>>8)&3)
 const h=hash(building^Math.imul(circuit+1,83492791))
 if(damage<=.12||(h&65535)/65535>=damage*.55)return strength
 if(h%5<3)return 0
 const t=((seconds+(h%100)*.1)%9+9)%9
 return strength*(t<.12||(t>.32&&t<.50)?.12:t>=.5&&t<.8?.6:1)
}
export function windowWarmth(seed:number,building:number):number {return ((hash(building^seed)>>>12)&3)/3}

/** Recover actual connected glass panes, welding only the temporary connectivity graph.
 * Source vertices, materials and meshes remain unchanged. Called only during upload.
 */
export function extractWindowGeometry(mesh:Mesh,family:1|2):WindowGeometry {
 const parent=new Int32Array(mesh.vertexCount).fill(-1),samePosition=new Map<string,number>()
 const root=(a:number):number=>{while(parent[a]!==a){parent[a]=parent[parent[a]];a=parent[a]}return a}
 const join=(a:number,b:number)=>{a=root(a);b=root(b);if(a!==b)parent[Math.max(a,b)]=Math.min(a,b)}
 for(let v=0;v<mesh.vertexCount;v++){
  if((mesh.materialZone[v]&127)!==4)continue
  parent[v]=v;const p=v*3,key=[0,1,2].map(i=>Math.round(mesh.positions[p+i]*100000)).join(',')
  const old=samePosition.get(key);if(old===undefined)samePosition.set(key,v);else join(v,old)
 }
 for(let t=0;t<mesh.triangleCount*3;t+=3){const a=mesh.indices[t],b=mesh.indices[t+1],c=mesh.indices[t+2];if(parent[a]>=0&&parent[b]>=0&&parent[c]>=0){join(a,b);join(a,c)}}
 const groups=new Map<number,{min:number[],max:number[],normal:number[],faceArea:number}>()
 for(let v=0;v<mesh.vertexCount;v++)if(parent[v]>=0){
  const id=root(v);let g=groups.get(id);if(!g){g={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity],normal:[0,0,0],faceArea:0};groups.set(id,g)}
  for(let a=0;a<3;a++){g.min[a]=Math.min(g.min[a],mesh.positions[v*3+a]);g.max[a]=Math.max(g.max[a],mesh.positions[v*3+a])}
 }
 // Largest facade-facing triangle supplies a physical outward light direction.
 for(let t=0;t<mesh.triangleCount*3;t+=3){const a=mesh.indices[t],b=mesh.indices[t+1],c=mesh.indices[t+2];if(parent[a]<0||parent[b]<0||parent[c]<0)continue
  const p=mesh.positions,ab=[0,1,2].map(i=>p[b*3+i]-p[a*3+i]),ac=[0,1,2].map(i=>p[c*3+i]-p[a*3+i])
  const n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]],area=Math.hypot(...n)
  const g=groups.get(root(a))!;if(area>g.faceArea){g.normal=n.map(v=>v/area);g.faceArea=area}
 }
 const panes:WindowPane[]=[]
 for(const g of groups.values()){
  if(g.faceArea<0.00002||Math.abs(g.normal[1])>0.6)continue // roof glass is not a room window
  const center=g.min.map((v,i)=>(v+g.max[i])*.5)
  const seed=(hash(Math.imul(Math.round(center[0]*1024),73856093)^Math.imul(Math.round(center[1]*1024),83492791)^Math.imul(Math.round(center[2]*1024),19349663))&65535)||1
  // The pane's dominant face-normal axis decides which local coordinate the rooms split
  // along, and it is packed INTO the flags so the shader splits along the same one.
  const floor=Math.max(0,Math.min(31,Math.floor(center[1]/.16)))
  const axis=Math.abs(g.normal[0])>Math.abs(g.normal[2])?2:0
  panes.push({seed,flags:128|(floor<<2)|(axis===2?2:0)|(family===2?1:0),center,min:g.min,max:g.max,normal:g.normal})
 }
 return {panes}
}
/** Reserved actor zone: .yz = pane seed, .w = the pane flags byte of `WindowPane`. */
export function packWindowGeometry(mesh:Mesh,packed:GpuMeshBuffers,geometry:WindowGeometry):void {
 if(!geometry.panes.length)return
 const bytes=new Uint8Array(packed.vertexData)
 for(let v=0;v<mesh.vertexCount;v++){
  if((mesh.materialZone[v]&127)!==4)continue
  let best:WindowPane|undefined,bestDistance=Infinity
  for(const pane of geometry.panes){let d=0;for(let a=0;a<3;a++){const p=mesh.positions[v*3+a],delta=Math.max(pane.min[a]-p,0,p-pane.max[a]);d+=delta*delta}
   if(d<bestDistance){bestDistance=d;best=pane}}
  if(!best||bestDistance>.02*.02)continue
  const o=v*packed.stride+ZONE_BYTE_OFFSET;bytes[o+1]=best.seed&255;bytes[o+2]=best.seed>>>8;bytes[o+3]=best.flags
 }
}
export const WINDOW_OCCUPANCY_WGSL=/* wgsl */ `
fn windowHash(value:u32)->u32 {
 var h=value; h=(h^(h>>16u))*0x7feb352du;h=(h^(h>>15u))*0x846ca68bu;return h^(h>>16u);
}
fn windowBuildingSeed(origin:vec3<f32>)->u32 {
 return windowHash((bitcast<u32>(i32(floor(origin.x*64.0)))*73856093u)^(bitcast<u32>(i32(floor(origin.z*64.0)))*19349663u));
}
fn windowCircuitFactor(seed:u32,flags:u32,building:u32,damage:f32,seconds:f32)->f32 {
 if(damage>=.9){return 0.0;}
 let strength=1.0-max(0.0,damage)*.25;
 let circuit=((flags>>2u)&31u)*5u+((seed>>8u)&3u);
 let h=windowHash(building^((circuit+1u)*83492791u));
 if(damage<=.12||f32(h&65535u)/65535.0>=damage*.55){return strength;}
 if(h%5u<3u){return 0.0;}
 let t=((seconds+f32(h%100u)*.1)%9.0+9.0)%9.0;
 if(t<.12||(t>.32&&t<.5)){return strength*.12;}
 if(t>=.5&&t<.8){return strength*.6;}
 return strength;
}
fn windowRoomSeedAt(paneSeed:u32,cell:i32)->u32 {
 return windowHash(paneSeed^(bitcast<u32>(cell)*73856093u))&0xffffffu;
}
/** A room's level and warmth: the two room-dependent terms that must BLEND across a cell
 * boundary. The dark-floor early-out depends only on floor+building, identical for adjacent
 * cells, so it stays a whole-pane branch in "windowEmission". */
fn windowRoomLook(seed:u32,building:u32,industrial:bool)->vec2<f32> {
 let h=windowHash(building^seed);let r=h%100u;var level=1.0;
 if(r<select(48u,25u,industrial)){level=0.0;}else if(r<select(68u,40u,industrial)){level=.18;}else if(r<select(93u,90u,industrial)){level=.65;}
 return vec2<f32>(level,f32((h>>12u)&3u)/3.0);
}
fn windowEmission(info:vec4<u32>,local:vec3<f32>,damage:f32,seconds:f32)->vec3<f32>{
 // Room-split axis from the pane's packed flags bit, in lockstep with "windowRooms" on the
 // CPU: the per-vertex normal disagrees with its pane's face normal on half of the authored
 // glass, and any disagreement splits the local light and the emissive pane into different
 // room grids — their circuits then die and blink at different damage values and phases.
 let coordinate=select(local.x,local.z,(info.y&2u)!=0u);
 let footprint=max(fwidth(coordinate)/.32,.005);
 if(info.x==0u){return vec3<f32>(0.0);}
 let industrial=(info.y&1u)!=0u;let floorIndex=(info.y>>2u)&31u;let building=info.z;
 if(!industrial&&windowHash(building^((floorIndex+1u)*83492791u))%11u<3u){return vec3<f32>(0.0);}
 let cell=i32(floor(coordinate/.32));
 let seed=windowRoomSeedAt(info.x,cell);
 let look=windowRoomLook(seed,building,industrial);
 var level=look.x;var warmth=look.y;
 // Narrow mullion/shadow divisions give continuous glass bands distinct interior rooms.
 // Derivatives keep their contrast bounded at far RTS zoom. The room SEED now gets the
 // same treatment as the mullion darkening: a pixel whose footprint straddles a cell
 // boundary shows the blend of both rooms instead of alternating their levels under TAA.
 let at=fract(coordinate/.32);
 if(at<footprint){
  let prev=windowRoomLook(windowRoomSeedAt(info.x,cell-1),building,industrial);
  let w=smoothstep(0.0,footprint,at);level=mix(prev.x,level,w);warmth=mix(prev.y,warmth,w);
 }
 if(at>1.0-footprint){
  let next=windowRoomLook(windowRoomSeedAt(info.x,cell+1),building,industrial);
  let w=smoothstep(1.0-footprint,1.0,at);level=mix(level,next.x,w);warmth=mix(warmth,next.y,w);
 }
 let division=smoothstep(0.0,footprint+.018,min(at,1.0-at));
 return vec3<f32>(1.0,.68+warmth*.08,.38+warmth*.10)*level*mix(.2,1.0,division)*windowCircuitFactor(seed,info.y,building,damage,seconds);
}
`
