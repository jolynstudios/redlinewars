/** Isolated authored-link proof. No production consumer until source and all-pass review. */
export interface TrackLoop {
 readonly length: number
 readonly linkCount: number
 /** Uniform arc-length samples: x, y, tangentX, tangentY; closes implicitly. */
 readonly samples: readonly number[]
}
export const TRACK_LINK_TAG = 3 // actor zone.w; bit128 remains exclusively room metadata

/** Write position, unit tangent and outward normal into caller-owned six-float storage. */
export function sampleTrackLoop(loop: TrackLoop, distance: number, out: Float64Array): void {
 const count=loop.samples.length/4, at=((distance/loop.length%1)+1)%1*count
 const a=Math.floor(at)%count,b=(a+1)%count,f=at-Math.floor(at),p=loop.samples
 out[0]=p[a*4]+(p[b*4]-p[a*4])*f;out[1]=p[a*4+1]+(p[b*4+1]-p[a*4+1])*f
 const tx=p[a*4+2]+(p[b*4+2]-p[a*4+2])*f,ty=p[a*4+3]+(p[b*4+3]-p[a*4+3])*f,n=Math.hypot(tx,ty)
 out[2]=tx/n;out[3]=ty/n;out[4]=out[3];out[5]=-out[2]
}

/** A vertex stays rigid within its link; distance is signed metres in source space. */
export function circulateTrackVertex(loop:TrackLoop,ordinal:number,distance:number,position:readonly number[],normal:readonly number[],out:Float64Array,base:Float64Array,current:Float64Array):void {
 const station=ordinal*loop.length/loop.linkCount
 sampleTrackLoop(loop,station,base);sampleTrackLoop(loop,station-distance,current)
 const x=position[0]-base[0],y=position[1]-base[1],u=x*base[2]+y*base[3],v=x*base[4]+y*base[5]
 out[0]=current[0]+u*current[2]+v*current[4];out[1]=current[1]+u*current[3]+v*current[5];out[2]=position[2]
 const nu=normal[0]*base[2]+normal[1]*base[3],nv=normal[0]*base[4]+normal[1]*base[5]
 out[3]=nu*current[2]+nv*current[4];out[4]=nu*current[3]+nv*current[5];out[5]=normal[2]
}

/** Prototype WGSL uses one immutable path table, shared by every actor/link and pass.
 * Production may concatenate tables into a shared read-only buffer; instance stride stays24.
 */
export function trackLoopWgsl(loop:TrackLoop):string {
 const count=loop.samples.length/4,n=(v:number)=>`${v.toFixed(9)}`
 const rows=Array.from({length:count},(_,i)=>`vec4<f32>(${loop.samples.slice(i*4,i*4+4).map(n).join(',')})`).join(',\n')
 return `const TRACK_SAMPLES=array<vec4<f32>,${count}>(\n${rows});
const TRACK_LENGTH:f32=${n(loop.length)};
const TRACK_PITCH:f32=${n(loop.length/loop.linkCount)};
struct TrackFrame { p:vec2<f32>, t:vec2<f32>, n:vec2<f32> }
fn trackFrame(distance:f32)->TrackFrame {
 let at=fract(distance/TRACK_LENGTH)*${count}.0; let a=u32(floor(at))%${count}u; let b=(a+1u)%${count}u;
 let row=mix(TRACK_SAMPLES[a],TRACK_SAMPLES[b],fract(at));let t=normalize(row.zw);
 return TrackFrame(row.xy,t,vec2<f32>(t.y,-t.x));
}
struct TrackVertex { p:vec3<f32>, n:vec3<f32>, t:vec4<f32> }
fn trackVertex(position:vec3<f32>,normal:vec3<f32>,tangent:vec4<f32>,ordinal:u32,phase:f32)->TrackVertex {
 let base=trackFrame(f32(ordinal)*TRACK_PITCH);let now=trackFrame((f32(ordinal)-phase)*TRACK_PITCH);
 let offset=position.xy-base.p;let p=now.p+now.t*dot(offset,base.t)+now.n*dot(offset,base.n);
 let norm=now.t*dot(normal.xy,base.t)+now.n*dot(normal.xy,base.n);
 let tan=now.t*dot(tangent.xy,base.t)+now.n*dot(tangent.xy,base.n);
 return TrackVertex(vec3<f32>(p,position.z),vec3<f32>(norm,normal.z),vec4<f32>(tan,tangent.zw));
}`
}
