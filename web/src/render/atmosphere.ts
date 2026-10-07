// Depth-aware suspended mist and bounded soft particles, composited in scene radiance.
import { FRAME_WGSL } from './frame'
import { COLOR_FORMAT } from './targets'
import type { GpuFactory } from './types'
import { ParticleOrder } from './particle-order'

const SHADER_HEAD = FRAME_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var shroud: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
struct Particle { sphere: vec4<f32>, tint: vec4<f32>, detail: vec4<f32> }
@group(0) @binding(4) var<storage, read> particles: array<Particle>;
fn noise(p: vec3<f32>) -> f32 {
 let i = floor(p); let f = fract(p); let u = f*f*(3.0-2.0*f);
 let n = dot(i, vec3<f32>(1.0, 57.0, 113.0));
 let a = fract(sin(vec4<f32>(n,n+1.0,n+57.0,n+58.0))*43758.5453);
 let b = fract(sin(vec4<f32>(n+113.0,n+114.0,n+170.0,n+171.0))*43758.5453);
 return mix(mix(mix(a.x,a.y,u.x),mix(a.z,a.w,u.x),u.y),mix(mix(b.x,b.y,u.x),mix(b.z,b.w,u.x),u.y),u.z);
}
fn sight(p: vec2<f32>) -> f32 {
 let uv = (p-frame.shroud.xy)*frame.shroud.zw;
 if(any(uv<vec2<f32>(0.0)) || any(uv>vec2<f32>(1.0))) { return 0.5; }
 return textureSampleLevel(shroud,linearSampler,uv,0.0).r;
}
fn positionAt(pixel: vec2<f32>, d: f32) -> vec3<f32> {
 let uv = pixel/vec2<f32>(textureDimensions(depth));
 let h = frame.invViewProj*vec4<f32>(uv.x*2.0-1.0,1.0-uv.y*2.0,d,1.0);
 return h.xyz/h.w;
}
@vertex fn vsFog(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
 let corners = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
 return vec4<f32>(corners[vi],0.0,1.0);
}
@fragment fn fsFog(@builtin(position) pixel: vec4<f32>) -> @location(0) vec4<f32> {
 if(frame.debug.x != 0u) { return vec4<f32>(0.0); }
 let d = textureLoad(depth,vec2<i32>(pixel.xy),0);
 let endpoint = positionAt(pixel.xy,max(d,0.00001));
 let origin = frame.cameraPos.xyz;
 let ray = normalize(endpoint-origin);
 let distance = min(length(endpoint-origin),220.0);
 // Intersect a world-space atmospheric slab. Sampling actual points on the camera
 // ray gives each height a distinct silhouette and parallax over terrain.
 if(abs(ray.y)<0.0001) { return vec4<f32>(0.0); }
 let a = (-3.0-origin.y)/ray.y; let b = (18.0-origin.y)/ray.y;
 let start = max(0.0,min(a,b)); let end = min(distance,max(a,b));
 if(end<=start) { return vec4<f32>(0.0); }
 // The slab's roof is y=18, world-aligned. From above, every pixel hits that roof
 // first, so the playable rectangle becomes a grey card — the zoomed-out lid.
 // Volume mist is only a thing you look THROUGH at play height, never a surface
 // you look DOWN onto. Unexplored ground still has the terrain-space veil.
 let above = smoothstep(14.0, 26.0, origin.y);
 let nadir = saturate((-ray.y - 0.62) / 0.28);
 let layer = (1.0 - above) * (1.0 - nadir);
 if(layer<=0.02) { return vec4<f32>(0.0); }
 let stepLength = (end-start)/16.0;
 var transmittance = 1.0; var light = vec3<f32>(0.0);
 let wind = vec3<f32>(frame.weather.x,0.0,frame.weather.y)*frame.surfaceWeather.z*0.18;
 for(var i=0u;i<16u;i++) {
  let p = origin+ray*(start+(f32(i)+0.5)*stepLength);
  let cover = 1.0-smoothstep(0.02,0.49,sight(p.xz));
  let n = noise(p*vec3<f32>(0.22,0.40,0.22)-wind*0.22);
  let wisps = noise(p*0.69+wind*0.31);
  let base = 1.6 + 1.8*noise(vec3<f32>(p.x*0.08,0.0,p.z*0.08));
  let lower = exp(-pow((p.y-base)/1.6,2.0));
  let upper = exp(-pow((p.y-base-3.8)/2.3,2.0));
  // The roof of the AABB must not read as a plane even during the climb fade.
  let roof = saturate((p.y - 10.0) / 8.0);
  let density = cover*(lower*0.38+upper*0.17)*smoothstep(0.32,0.72,n+wisps*0.18)*layer*(1.0-roof*above);
  let opacity = 1.0-exp(-density*stepLength);
  // A dark underside and illuminated upper envelope make suspended banks legible.
  // This approximates in-volume lighting, not a pattern painted onto ground UVs.
  let upperLight = clamp((p.y-base+0.5)/3.0,0.0,1.0);
  let tint = frame.aerialColor.rgb*(0.28+0.70*upperLight+0.25*n)
   +frame.sunColor.rgb*frame.sunColor.a*upperLight*0.018;
  light += tint*transmittance*opacity;
  transmittance *= 1.0-opacity;
 }
 let alpha = min(1.0-transmittance, 0.42*layer);
 return vec4<f32>(light,alpha);
}
`

/** The shipped soft puff: a round sprite with noise in its density, lit by the ambient sky. */
const PARTICLE_ROUND = /* wgsl */ `
struct Varying { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>,
 @location(1) world: vec3<f32>, @location(2) @interpolate(flat) id: u32 }
@vertex fn vsParticle(@builtin(vertex_index) vi: u32, @builtin(instance_index) id: u32) -> Varying {
 let corners = array<vec2<f32>,6>(vec2<f32>(-1.0,-1.0),vec2<f32>(1.0,-1.0),vec2<f32>(-1.0,1.0),vec2<f32>(-1.0,1.0),vec2<f32>(1.0,-1.0),vec2<f32>(1.0,1.0));
 let p = particles[id]; let uv=corners[vi];
 let right=vec3<f32>(frame.view[0].x,frame.view[1].x,frame.view[2].x);
 let up=vec3<f32>(frame.view[0].y,frame.view[1].y,frame.view[2].y);
 var out: Varying; out.world=p.sphere.xyz+(right*uv.x+up*uv.y)*p.sphere.w;
 out.position=frame.viewProj*vec4<f32>(out.world,1.0);out.uv=uv;out.id=id;return out;
}
@fragment fn fsParticle(v: Varying) -> @location(0) vec4<f32> {
 if(frame.debug.x != 0u || sight(v.world.xz)<0.995) { discard; }
 let d=textureLoad(depth,vec2<i32>(v.position.xy),0);
 if(v.position.z<d) { discard; }
 let p=particles[v.id];
 let radius=length(v.uv);if(radius>1.0){discard;}
 let soft=clamp(length(positionAt(v.position.xy,max(d,0.00001))-frame.cameraPos.xyz)-length(v.world-frame.cameraPos.xyz),0.0,1.0);
 let texture=noise(vec3<f32>(v.uv*3.5+p.detail.y,p.detail.x*0.35));
 let alpha=p.tint.a*pow(1.0-radius*radius,1.8)*mix(0.5,1.0,texture)*soft;
 let ambient=max(frame.skyColor.rgb*0.65+frame.sunColor.rgb*frame.sunColor.a*0.04,vec3<f32>(0.025));
 let color=p.tint.rgb*mix(ambient,vec3<f32>(1.0),p.detail.z);
 return vec4<f32>(color*alpha,alpha);
}
`

/**
 * Ultra and Ultra+ (vfx.md Epic 5, smoke: "irregular flipbook/atlas or measured compatible volume
 * components ... directional light ... no opaque repeated gray-circle solution"). No texture: each
 * puff's outline is three angular harmonics whose phases come from its seed and drift with its
 * age, so no two puffs share a silhouette and each one billows as it lives; and a hemisphere
 * normal is lit from the sun's side, so a column has a lit and a shaded flank. The harmonics are
 * powers of the direction (no trigonometry per fragment) with phases set once per vertex, the
 * quad's corners are dropped before any shading, and the density noise is hashed without sin():
 * coveragegate measures the cost against the round puff's.
 */
const PARTICLE_BILLOW = /* wgsl */ `
// The same value noise as noise(), hashed without sin(): the density texture was most of a
// puff's fragment cost.
fn hash4(n: vec4<f32>) -> vec4<f32> { var h=fract(n*0.1031); h*=h+33.33; h*=h+h; return fract(h); }
fn billowNoise(p: vec3<f32>) -> f32 {
 let i = floor(p); let f = fract(p); let u = f*f*(3.0-2.0*f);
 let n = dot(i, vec3<f32>(1.0, 57.0, 113.0));
 let a = hash4(vec4<f32>(n,n+1.0,n+57.0,n+58.0));
 let b = hash4(vec4<f32>(n+113.0,n+114.0,n+170.0,n+171.0));
 return mix(mix(mix(a.x,a.y,u.x),mix(a.z,a.w,u.x),u.y),mix(mix(b.x,b.y,u.x),mix(b.z,b.w,u.x),u.y),u.z);
}
struct Varying { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>,
 @location(1) world: vec3<f32>, @location(2) @interpolate(flat) id: u32,
 @location(3) @interpolate(flat) lobes: vec4<f32>, @location(4) @interpolate(flat) lobes5: vec2<f32>,
 @location(5) @interpolate(flat) sun: vec3<f32> }
@vertex fn vsParticle(@builtin(vertex_index) vi: u32, @builtin(instance_index) id: u32) -> Varying {
 let corners = array<vec2<f32>,6>(vec2<f32>(-1.0,-1.0),vec2<f32>(1.0,-1.0),vec2<f32>(-1.0,1.0),vec2<f32>(-1.0,1.0),vec2<f32>(1.0,-1.0),vec2<f32>(1.0,1.0));
 let p = particles[id]; let uv=corners[vi];
 let right=vec3<f32>(frame.view[0].x,frame.view[1].x,frame.view[2].x);
 let up=vec3<f32>(frame.view[0].y,frame.view[1].y,frame.view[2].y);
 let back=vec3<f32>(frame.view[0].z,frame.view[1].z,frame.view[2].z);
 var out: Varying; out.world=p.sphere.xyz+(right*uv.x+up*uv.y)*p.sphere.w;
 out.position=frame.viewProj*vec4<f32>(out.world,1.0);out.uv=uv;out.id=id;
 let phase=6.2831853*fract(p.detail.y*vec3<f32>(1.618,2.414,3.303))+p.detail.x*vec3<f32>(0.35,-0.5,0.8);
 out.lobes=vec4<f32>(cos(phase.x),sin(phase.x),cos(phase.y),sin(phase.y));
 out.lobes5=vec2<f32>(cos(phase.z),sin(phase.z));
 let sun=frame.sunDirection.xyz;
 out.sun=vec3<f32>(dot(sun,right),dot(sun,up),dot(sun,back));
 return out;
}
@fragment fn fsParticle(v: Varying) -> @location(0) vec4<f32> {
 let r0=length(v.uv);if(r0>1.0){discard;}
 if(frame.debug.x != 0u || sight(v.world.xz)<0.995) { discard; }
 let d=textureLoad(depth,vec2<i32>(v.position.xy),0);
 if(v.position.z<d) { discard; }
 let p=particles[v.id];
 let z1=v.uv/max(r0,0.0001);
 let z2=vec2<f32>(z1.x*z1.x-z1.y*z1.y,2.0*z1.x*z1.y);
 let z3=vec2<f32>(z2.x*z1.x-z2.y*z1.y,z2.x*z1.y+z2.y*z1.x);
 let z5=vec2<f32>(z3.x*z2.x-z3.y*z2.y,z3.x*z2.y+z3.y*z2.x);
 let reach=0.86+0.14*(0.5*dot(z2,v.lobes.xy)+0.3*dot(z3,v.lobes.zw)+0.2*dot(z5,v.lobes5));
 let radius=r0/reach;if(radius>1.0){discard;}
 let soft=clamp(length(positionAt(v.position.xy,max(d,0.00001))-frame.cameraPos.xyz)-length(v.world-frame.cameraPos.xyz),0.0,1.0);
 let texture=billowNoise(vec3<f32>(v.uv*3.5+p.detail.y,p.detail.x*0.35));
 let alpha=p.tint.a*pow(1.0-radius*radius,1.8)*mix(0.5,1.0,texture)*soft;
 // Sun on a flattened hemisphere, so the lit-to-shaded gradient spans the puff's body and not
 // only its faded rim; the shaded side gets the sun through the puff's depth; the denser
 // billows catch more light and the thin crevices less; each puff its own tone.
 let n=normalize(vec3<f32>(v.uv/reach,0.55*sqrt(max(0.0,1.0-radius*radius))+0.05));
 let nl=dot(n,v.sun);
 let sunlit=(0.35+0.65*saturate(nl*0.5+0.5))*exp(-2.2*max(0.0,-nl))*mix(0.55,1.2,texture);
 let tone=0.86+0.28*fract(p.detail.y*0.6180339);
 let light=frame.skyColor.rgb*0.45*mix(0.75,1.05,texture)+frame.sunColor.rgb*frame.sunColor.a*0.10*sunlit;
 let ambient=max(light*tone,vec3<f32>(0.025));
 let color=p.tint.rgb*mix(ambient,vec3<f32>(1.0),p.detail.z);
 return vec4<f32>(color*alpha,alpha);
}
`

export class Atmosphere {
 private readonly layout: GPUBindGroupLayout
 private readonly fog: GPURenderPipeline
 private readonly particle: GPURenderPipeline
 private readonly buffer: GPUBuffer
 /** The particle storage buffer's size, for the VFX resource account. */
 get bufferBytes(): number { return this.buffer.size }
 private readonly sampler: GPUSampler
 private group: GPUBindGroup | null = null
 private readonly data: Float32Array
 private readonly ordering: ParticleOrder
 private readonly sorted: Float32Array
 private count = 0
 private readonly attachment: GPURenderPassColorAttachment = { view: null!, loadOp: 'load', storeOp: 'store' }
 private readonly descriptor: GPURenderPassDescriptor = { label: 'render.atmosphere', colorAttachments: [this.attachment] }
 readonly stats = { particles: 0, dropped: 0, fogDraws: 0 }
 /** `billow`: the Ultra/Ultra+ puff (irregular, sun-lit) instead of the shipped round one. */
 constructor(private readonly factory: GpuFactory, private readonly limit: number, private readonly fogEnabled: boolean, billow = false) {
  const device=factory.device
  this.data=new Float32Array(limit*12);this.sorted=new Float32Array(limit*12)
  this.ordering=new ParticleOrder(limit)
  this.buffer=device.createBuffer({label:'render.particles',size:limit*48,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST})
  this.sampler=device.createSampler({minFilter:'linear',magFilter:'linear'})
  this.layout=device.createBindGroupLayout({entries:[
   {binding:0,visibility:3,buffer:{type:'uniform'}},{binding:1,visibility:2,texture:{sampleType:'depth'}},
   {binding:2,visibility:2,texture:{sampleType:'float'}},{binding:3,visibility:2,sampler:{type:'filtering'}},
   {binding:4,visibility:3,buffer:{type:'read-only-storage'}},
  ]})
  const module=device.createShaderModule({label:'render.atmosphere',code:SHADER_HEAD+(billow?PARTICLE_BILLOW:PARTICLE_ROUND)})
  const layout=device.createPipelineLayout({bindGroupLayouts:[this.layout]})
  const targets: GPUColorTargetState[]=[{format:COLOR_FORMAT,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'zero',dstFactor:'one'}}}]
  this.fog=factory.renderPipeline({layout,vertex:{module,entryPoint:'vsFog'},fragment:{module,entryPoint:'fsFog',targets}})
  this.particle=factory.renderPipeline({layout,vertex:{module,entryPoint:'vsParticle'},fragment:{module,entryPoint:'fsParticle',targets}})
 }
 rebind(frame: GPUBuffer, depth: GPUTextureView, shroud: GPUTextureView): void {
  this.group=this.factory.device.createBindGroup({layout:this.layout,entries:[
   {binding:0,resource:{buffer:frame}},{binding:1,resource:depth},{binding:2,resource:shroud},
   {binding:3,resource:this.sampler},{binding:4,resource:{buffer:this.buffer}},
  ]})
 }
 add(x:number,y:number,z:number,radius:number,r:number,g:number,b:number,alpha:number,age:number,seed:number,emission:number): void {
  if(this.count>=this.limit){this.stats.dropped++;return}
  const o=this.count++*12,d=this.data
  d[o]=x;d[o+1]=y;d[o+2]=z;d[o+3]=radius;d[o+4]=r;d[o+5]=g;d[o+6]=b;d[o+7]=alpha
  d[o+8]=age;d[o+9]=seed;d[o+10]=emission;d[o+11]=0
 }
 encode(encoder: GPUCommandEncoder, target: GPUTextureView, camera: Float32Array): number {
  if(!this.group)return 0
  // Camera Y above the mist slab: skip the pass so a zoomed-out map cannot pick up a
  // leftover lid from a shader path that still ran.
  const aerial = camera[1] > 26
  this.stats.particles=this.count;this.stats.fogDraws=this.fogEnabled&&!aerial?1:0
  if(this.count===0 && this.stats.fogDraws===0)return 0
  for(let i=0;i<this.count;i++) {const o=i*12;this.ordering.distances[i]=(this.data[o]-camera[0])**2+(this.data[o+1]-camera[1])**2+(this.data[o+2]-camera[2])**2}
  const order=this.ordering.sort(this.count)
  for(let i=0;i<this.count;i++)for(let j=0;j<12;j++)this.sorted[i*12+j]=this.data[order[i]*12+j]
  if(this.count)this.factory.device.queue.writeBuffer(this.buffer,0,this.sorted.buffer,0,this.count*48)
  this.attachment.view=target
  const pass=encoder.beginRenderPass(this.descriptor);pass.setBindGroup(0,this.group)
  if(this.fogEnabled&&!aerial){pass.setPipeline(this.fog);pass.draw(3)}
  if(this.count){pass.setPipeline(this.particle);pass.draw(6,this.count)}
  pass.end();return (this.fogEnabled&&!aerial?1:0)+(this.count?1:0)
 }
 reset(): void {this.count=0;this.stats.dropped=0}
 dispose(): void {this.buffer.destroy();this.group=null}
}
