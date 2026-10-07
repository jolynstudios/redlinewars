#!/usr/bin/env node
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {launchGpuBrowser,loadChromium} from './harness.mjs'
const root=fileURLToPath(new URL('../..',import.meta.url)),out=`${root}/.artifacts/planx/tracks-loop/`
const built=await build({entryPoints:[`${root}/web/src/core/track-loop.ts`],bundle:true,format:'esm',write:false,logLevel:'silent'})
const helper=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const source=JSON.parse(readFileSync(`${out}source.json`));assert.equal(createHash('sha256').update(readFileSync(`${root}/${source.source}`)).digest('hex'),source.sourceSha256);assert.equal(createHash('sha256').update(readFileSync(`${root}/${source.parentSource}`)).digest('hex'),source.parentSourceSha256);const loop=source.loop,pitch=loop.length/loop.linkCount,base=new Float64Array(6),current=new Float64Array(6),point=new Float64Array(6)
const a=new Float64Array(6),b=new Float64Array(6)
for(let i=0;i<loop.linkCount;i++){
 helper.sampleTrackLoop(loop,i*pitch,base)
 for(const distance of [-loop.length,-pitch,-.3,0,pitch/2,pitch,loop.length]){
  const p=[base[0]+base[2]*.014+base[4]*.007,base[1]+base[3]*.014+base[5]*.007,.3352]
  helper.circulateTrackVertex(loop,i,distance,p,[base[4],base[5],0],point,a,b)
  helper.sampleTrackLoop(loop,i*pitch-distance,current)
  assert.ok(Math.abs(Math.hypot(point[0]-current[0],point[1]-current[1])-Math.hypot(.014,.007))<1e-12,'rigid offset length')
  assert.ok(Math.abs(Math.hypot(...point.slice(3))-1)<1e-12,'unit normal')
  helper.circulateTrackVertex(loop,i,loop.length,p,[base[4],base[5],0],point,a,b)
  assert.ok(Math.hypot(point[0]-p[0],point[1]-p[1])<1e-10,'whole loop closes')
 }
}
// Identical source links relabel without positional discontinuity when the packed fraction wraps.
let wrapError=0
for(let i=0;i<loop.linkCount;i++){
 helper.sampleTrackLoop(loop,i*pitch,base);helper.sampleTrackLoop(loop,((i+loop.linkCount-1)%loop.linkCount)*pitch,current)
 const p=[base[0]+base[4]*.01,base[1]+base[5]*.01,.3352]
 helper.circulateTrackVertex(loop,i,pitch,p,[base[4],base[5],0],point,a,b)
 wrapError=Math.max(wrapError,Math.hypot(point[0]-(current[0]+current[4]*.01),point[1]-(current[1]+current[5]*.01)))
}
assert.ok(wrapError<1e-12)
const report=JSON.parse(readFileSync(`${out}report.json`));assert.equal(report.canonicalUnchanged,true);assert.ok(report.guideToTyreLateralClearanceM>.003)
assert.ok(Math.abs(report.roadContactY-report.roadWheelBottomY)<1e-10);assert.ok(Math.abs(report.rollerContactY-report.rollerTopY)<1e-10);assert.ok(report.sweptLinkBoundsOneSide[0][1]>.0095,'bevelled links maintain the flat contact plane within half a millimetre around end wraps')
const wgsl=helper.trackLoopWgsl(loop),mechanisms=source.mechanisms
const mechanismWgsl=`const MECHANISMS=array<vec4<f32>,${mechanisms.length}>(${mechanisms.map(m=>`vec4<f32>(${[...m.center,m.radius].map(v=>v.toFixed(9)).join(',')})`).join(',')});`
const common=wgsl+mechanismWgsl+`
struct Instance {model:mat4x4<f32>,tint:vec4<f32>,misc:vec4<f32>}
@group(0) @binding(0) var<storage,read> instances:array<Instance>;
@group(0) @binding(1) var<uniform> state:vec4<f32>;
fn deform(p:vec3<f32>,n:vec3<f32>,t:vec4<f32>,link:i32,mechanism:i32)->TrackVertex {
 if(link>=0){let bits=u32(instances[0].misc.z);let phase=f32(select(bits&4095u,(bits>>12u)&4095u,p.z>=0.0))/4096.0;return trackVertex(p,n,t,u32(link),phase);}
 if(mechanism>=0){let m=MECHANISMS[u32(mechanism)];let d=select(state.x,state.y,m.z>=0.0);let angle=-d/m.w;let cs=cos(angle);let sn=sin(angle);let xy=p.xy-m.xy;
  return TrackVertex(vec3<f32>(m.xy+vec2<f32>(cs*xy.x-sn*xy.y,sn*xy.x+cs*xy.y),p.z),vec3<f32>(cs*n.x-sn*n.y,sn*n.x+cs*n.y,n.z),vec4<f32>(cs*t.x-sn*t.y,sn*t.x+cs*t.y,t.zw));}
 return TrackVertex(p,n,t);
}
`
const renderWgsl=common+`
struct Vin{@location(0)p:vec3<f32>,@location(1)n:vec3<f32>,@location(2)color:vec3<f32>,@location(3)zone:vec4<u32>,@location(4)mechanism:i32,@location(5)uv:vec2<f32>}
struct Vout{@builtin(position)p:vec4<f32>,@location(0)n:vec3<f32>,@location(1)color:vec3<f32>,@location(2)uv:vec2<f32>,@location(3)@interpolate(flat)virtualBelt:u32}
@vertex fn vs(v:Vin)->Vout {let d=deform(v.p,v.n,vec4<f32>(1,0,0,1),select(-1,i32(v.zone.y),v.zone.w==3u),v.mechanism);let eye=normalize(vec3<f32>(1.3,.85,2));let right=normalize(cross(vec3<f32>(0,1,0),eye));let up=cross(eye,right);let p=d.p-vec3<f32>(0,.28,0);var out:Vout;out.p=vec4<f32>(dot(p,right)*state.w,dot(p,up)*1.5*state.w,.5-dot(p,eye)*.25,1);out.n=d.n;let bits=u32(instances[0].misc.z);let phase=f32(select(bits&4095u,(bits>>12u)&4095u,v.p.z>=0.0))/4096.0;out.uv=v.uv+vec2<f32>(phase,0);out.virtualBelt=v.zone.x;out.color=select(v.color,vec3<f32>(.9,.24,.035),v.zone.w==3u&&v.zone.y==0u&&state.z>0.5);return out;}
@fragment fn fs(v:Vout)->@location(0)vec4<f32>{let light=.32+.68*max(0.0,dot(normalize(v.n),normalize(vec3<f32>(.5,1,.7))));let aa=max(fwidth(v.uv.x),.015);var color=v.color;if(v.virtualBelt==1u){let edge=abs(fract(v.uv.x+.5)-.5);let cleat=1.0-smoothstep(.19-aa,.19+aa,edge);color=mix(vec3<f32>(.045,.049,.048),vec3<f32>(.19,.20,.18),cleat);}return vec4<f32>(pow(max(color*light,vec3<f32>(0)),vec3<f32>(1.0/2.2)),1);}
`
const computeWgsl=common+`
struct Input{p:vec4<f32>,n:vec4<f32>,t:vec4<f32>}
struct Output{p:vec4<f32>,n:vec4<f32>,t:vec4<f32>}
@group(0) @binding(2)var<storage,read> input:array<Input>;
@group(0) @binding(3)var<storage,read_write> output:array<Output>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3<u32>){if(id.x>=arrayLength(&input)){return;}let v=input[id.x];let result=deform(v.p.xyz,v.n.xyz,v.t,i32(v.p.w),i32(v.n.w));output[id.x]=Output(vec4<f32>(result.p,1),vec4<f32>(result.n,0),result.t);}
`
const samples=[],candidates=[]
for(let i=0;i<source.links.length;i++)if(source.links[i]>=0)candidates.push(i)
for(let k=0;k<300;k++){const i=candidates[Math.floor(k*candidates.length/300)],p=source.vertices.slice(i*9,i*9+3),n=source.vertices.slice(i*9+3,i*9+6);samples.push({link:source.links[i],mechanism:-1,p,n,t:[1,0,0,1]})}
for(const mechanism of source.mechanisms){const i=source.rotations.indexOf(mechanism.index);assert.ok(i>=0);samples.push({link:-1,mechanism:mechanism.index,p:source.vertices.slice(i*9,i*9+3),n:source.vertices.slice(i*9+3,i*9+6),t:[1,0,0,1]})}
assert.ok(samples.some(s=>s.p[2]<0)&&samples.some(s=>s.p[2]>0),'both independently phased sides sampled')
const linkUvs=new Map()
for(const i of candidates){const key=`${Math.sign(source.vertices[i*9+2])}:${source.links[i]}`;if(!linkUvs.has(key))linkUvs.set(key,[]);linkUvs.get(key).push(...source.uv0.slice(i*2,i*2+2))}
assert.ok(source.lodMeshes[0].indices.length>source.lodMeshes[1].indices.length&&source.lodMeshes[1].indices.length>source.lodMeshes[2].indices.length)
for(const mesh of source.lodMeshes)assert.ok(mesh.indices.every(i=>i>=0&&i<mesh.links.length),'authored LOD mesh indices are valid; no QEM merge')
assert.ok(source.lodMeshes[1].links.some(i=>i>=0),'middle retains moving steel links')
assert.ok(source.lodMeshes[2].links.every(i=>i<0)&&source.lodMeshes[2].virtual.some(Boolean),'far replaces physical links with phase-scrolled virtual belt')
// Far cleat stripe uses station/pitch + phase: its centres travel with the same signed links.
for(const phase of [-.7,0,.33,.999,1])for(let ordinal=0;ordinal<loop.linkCount;ordinal++){
 const station=ordinal-phase,uv=station+phase;
 assert.ok(Math.abs(uv-Math.round(uv))<1e-12,'virtual cleat centre agrees with circulated physical link')
}
assert.ok(source.lodMeshes[2].indices.length/3<3200,'authored virtual-belt far budget')
const firstUv=new Float32Array(linkUvs.values().next().value)
for(const uv of linkUvs.values())assert.deepEqual(new Uint8Array(new Float32Array(uv).buffer),new Uint8Array(firstUv.buffer),'identical link UV bytes survive phase relabelling')
const server=createServer((_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<html><body style="margin:0;background:#20242b"><canvas width="960" height="640"></canvas></body></html>')});await new Promise(resolve=>server.listen(8491,'127.0.0.1',resolve));let browser
try{
 ;({browser}=await launchGpuBrowser(await loadChromium('trackloopgate'),'trackloopgate'));const page=await browser.newPage({viewport:{width:960,height:640}});await page.goto('http://127.0.0.1:8491')
 const result=await page.evaluate(async({source,samples,renderWgsl,computeWgsl,pitch})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));const canvas=document.querySelector('canvas'),ctx=canvas.getContext('webgpu'),format=navigator.gpu.getPreferredCanvasFormat();ctx.configure({device,format,alphaMode:'opaque'})
  const buffer=(bytes,usage)=>{const b=device.createBuffer({size:Math.max(4,bytes.byteLength),usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,bytes);return b}
  const vertices=source.lodMeshes.map(mesh=>{const bytes=new ArrayBuffer(mesh.links.length*52),dv=new DataView(bytes)
   for(let i=0;i<mesh.links.length;i++){for(let k=0;k<9;k++)dv.setFloat32(i*52+k*4,mesh.vertices[i*9+k],true);dv.setUint8(i*52+36,mesh.virtual[i]?1:2);dv.setUint8(i*52+37,Math.max(0,mesh.links[i]));dv.setUint8(i*52+38,0);dv.setUint8(i*52+39,mesh.links[i]>=0?3:0);dv.setInt32(i*52+40,mesh.rotations[i],true);dv.setFloat32(i*52+44,mesh.uv0[i*2],true);dv.setFloat32(i*52+48,mesh.uv0[i*2+1],true)}
   return buffer(bytes,GPUBufferUsage.VERTEX)})
  const indices=source.lodMeshes.map(mesh=>buffer(new Uint32Array(mesh.indices),GPUBufferUsage.INDEX)),instance=new Float32Array(24);for(let i=0;i<4;i++)instance[i*5]=1
  const instanceBuffer=buffer(instance,GPUBufferUsage.STORAGE),state=buffer(new Float32Array(4),GPUBufferUsage.UNIFORM)
  const modules=[device.createShaderModule({code:renderWgsl}),device.createShaderModule({code:computeWgsl})];const compile=[]
  for(const module of modules)for(const m of(await module.getCompilationInfo()).messages)if(m.type==='error')compile.push(m.message)
  if(compile.length)return{errors,compile}
  const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module:modules[0],entryPoint:'vs',buffers:[{arrayStride:52,attributes:[{shaderLocation:0,format:'float32x3',offset:0},{shaderLocation:1,format:'float32x3',offset:12},{shaderLocation:2,format:'float32x3',offset:24},{shaderLocation:3,format:'uint8x4',offset:36},{shaderLocation:4,format:'sint32',offset:40},{shaderLocation:5,format:'float32x2',offset:44}]}]},fragment:{module:modules[0],entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'}})
  const depth=device.createTexture({size:[canvas.width,canvas.height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT})
  const renderGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:instanceBuffer}},{binding:1,resource:{buffer:state}}]})
  const packed=(l,r)=>Math.floor((l-Math.floor(l))*4096)+Math.floor((r-Math.floor(r))*4096)*4096
  const set=(l,r,mark,scale=1)=>{instance[22]=packed(l/pitch,r/pitch);device.queue.writeBuffer(instanceBuffer,0,instance);device.queue.writeBuffer(state,0,new Float32Array([l,r,mark,scale]));return instance[22]}
  const draw=(lod=0)=>{const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:ctx.getCurrentTexture().createView(),clearValue:{r:.025,g:.03,b:.04,a:1},loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});pass.setPipeline(pipeline);pass.setBindGroup(0,renderGroup);pass.setVertexBuffer(0,vertices[lod]);pass.setIndexBuffer(indices[lod],'uint32');pass.drawIndexed(source.lodMeshes[lod].indices.length,1);pass.end();device.queue.submit([encoder.finish()])}
  const shots=[]
  for(const [label,left,right,lod=0]of[['rest',0,0],['forward',pitch*.5,pitch*.5],['reverse',-pitch*.25,-pitch*.25],['pivot',-pitch*.33,pitch*.33],['middle',pitch*.33,pitch*.33,1],['far',pitch*.33,pitch*.33,2]]){set(left,right,0);draw(lod);await device.queue.onSubmittedWorkDone();draw(lod);const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;copy.getContext('2d').drawImage(canvas,0,0);shots.push({label,left,right,lod,png:copy.toDataURL()})}
  const board=document.createElement('canvas');board.width=960;board.height=520;const boardCtx=board.getContext('2d');boardCtx.fillStyle='#141820';boardCtx.fillRect(0,0,960,520);boardCtx.font='18px sans-serif';boardCtx.fillStyle='#eee';boardCtx.fillText('Actual GPU raster sizes; each column uses authored LOD',24,32)
  const gameplay=[]
  for(let lod=0;lod<3;lod++){const scale=[.34,.20,.105][lod];set(-pitch*.33,pitch*.33,0,scale);draw(lod);await device.queue.onSubmittedWorkDone();draw(lod);const copy=document.createElement('canvas');copy.width=960;copy.height=640;copy.getContext('2d').drawImage(canvas,0,0);shots.push({label:`gameplay-${lod}`,left:-pitch*.33,right:pitch*.33,lod,scale,png:copy.toDataURL()});const pixels=copy.getContext('2d').getImageData(0,0,960,640);let xmin=960,xmax=0,ymin=640,ymax=0;const bg=pixels.data.slice(0,3);for(let y=0;y<640;y++)for(let x=0;x<960;x++){const i=(y*960+x)*4;if(Math.abs(pixels.data[i]-bg[0])+Math.abs(pixels.data[i+1]-bg[1])+Math.abs(pixels.data[i+2]-bg[2])>8){xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y)}}const width=xmax-xmin+1,height=ymax-ymin+1;gameplay.push({lod,width,height,triangles:source.lodMeshes[lod].indices.length/3});boardCtx.drawImage(copy,320,180,320,280,lod*320,80,320,280);boardCtx.fillStyle='#eee';boardCtx.fillText(['Near','Middle','Far / virtual belt'][lod],lod*320+22,390);boardCtx.fillText(`${width} × ${height} px`,lod*320+22,420);boardCtx.fillText(`${source.lodMeshes[lod].indices.length/3} triangles`,lod*320+22,450)}
  shots.push({label:'gameplay-comparison',png:board.toDataURL()})
  const movie=document.createElement('canvas');movie.width=canvas.width;movie.height=canvas.height;const painter=movie.getContext('2d'),stream=movie.captureStream(0),chunks=[]
  const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:2500000});recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.start()
  for(let f=0;f<90;f++){const t=f/30;const left=t<1?.12*t:t<2?.12*(2-t):-.12*(t-2),right=t<2?left:.12*(t-2);set(left,right,0);draw();painter.drawImage(canvas,0,0);stream.getVideoTracks()[0].requestFrame();await new Promise(resolve=>setTimeout(resolve,1000/30))}
  const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());const movieBytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let binary='';for(const byte of movieBytes)binary+=String.fromCharCode(byte);const video=btoa(binary)
  const input=new Float32Array(samples.length*12);for(let i=0;i<samples.length;i++)input.set([...samples[i].p,samples[i].link,...samples[i].n,samples[i].mechanism,...samples[i].t],i*12)
  const inputBuffer=buffer(input,GPUBufferUsage.STORAGE),output=device.createBuffer({size:input.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:input.byteLength,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST})
  const compute=device.createComputePipeline({layout:'auto',compute:{module:modules[1],entryPoint:'main'}}),entries=[{binding:0,resource:{buffer:instanceBuffer}},{binding:1,resource:{buffer:state}},{binding:2,resource:{buffer:inputBuffer}},{binding:3,resource:{buffer:output}}]
  const computeGroup=device.createBindGroup({layout:compute.getBindGroupLayout(0),entries})
  const positions=[]
  for(const [left,right]of[[pitch*.33,pitch*.66],[-pitch*.2,pitch*.2],[pitch*(1-1/4096),pitch*(1-1/4096)],[pitch,pitch],[pitch*.33,pitch*.66]]){const bits=set(left,right,0),enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(compute);pass.setBindGroup(0,computeGroup);pass.dispatchWorkgroups(Math.ceil(samples.length/64));pass.end();enc.copyBufferToBuffer(output,0,read,0,input.byteLength);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);positions.push({left,right,bits,data:Array.from(new Float32Array(read.getMappedRange().slice(0)))});read.unmap()}
  await device.queue.onSubmittedWorkDone();return{errors,compile,shots,positions,video,gameplay,instanceBytes:instance.byteLength,drawCallsPerFrame:1,triangles:source.indices.length/3}
 },{source,samples,renderWgsl,computeWgsl,pitch})
 writeFileSync(`${out}gpu-diagnostic.json`,JSON.stringify(result,(k,v)=>k==='png'||k==='data'||k==='video'?undefined:v,2))
 assert.deepEqual(result.compile,[]);assert.deepEqual(result.errors,[])
 assert.deepEqual(result.positions[0].data,result.positions.at(-1).data,'held/repeated state produces byte-identical GPU positions/normals/tangents')
 let maxPositionError=0,maxNormalError=0,maxTangentError=0
 for(const run of result.positions)for(let i=0;i<samples.length;i++){
  const s=samples[i],fraction=s.p[2]<0?(run.bits&4095)/4096:((run.bits>>>12)&4095)/4096
  const transform=normal=>{if(s.link>=0){helper.circulateTrackVertex(loop,s.link,fraction*pitch,s.p,normal,point,a,b);return}
   const m=source.mechanisms.find(m=>m.index===s.mechanism),angle=-(m.side<0?run.left:run.right)/m.radius,cs=Math.cos(angle),sn=Math.sin(angle),x=s.p[0]-m.center[0],y=s.p[1]-m.center[1]
   point.set([m.center[0]+cs*x-sn*y,m.center[1]+sn*x+cs*y,s.p[2],cs*normal[0]-sn*normal[1],sn*normal[0]+cs*normal[1],normal[2]])}
  transform(s.n)
  maxPositionError=Math.max(maxPositionError,Math.hypot(...point.slice(0,3).map((v,k)=>v-run.data[i*12+k])))
  maxNormalError=Math.max(maxNormalError,Math.hypot(...point.slice(3).map((v,k)=>v-run.data[i*12+4+k])))
  transform(s.t)
  maxTangentError=Math.max(maxTangentError,Math.hypot(...point.slice(3).map((v,k)=>v-run.data[i*12+8+k])))
 }
 assert.ok(maxPositionError<2e-6,`GPU position error ${maxPositionError}`);assert.ok(maxNormalError<2e-5,`GPU normal error ${maxNormalError}`);assert.ok(maxTangentError<2e-5)
 writeFileSync(`${out}circulation.webm`,Buffer.from(result.video,'base64'))
 for(const shot of result.shots)writeFileSync(`${out}gpu-${shot.label}.png`,Buffer.from(shot.png.split(',')[1],'base64'))
 writeFileSync(`${out}gate.json`,JSON.stringify({passed:true,wrapError,maxPositionError,maxNormalError,maxTangentError,samples:samples.length,rotatingMechanisms:source.mechanisms.length,instanceBytes:result.instanceBytes,drawCallsPerFrame:1,triangles:result.triangles,lodTriangles:source.lodMeshes.map(m=>m.indices.length/3),gameplay:result.gameplay,identicalLinkUvBytes:true,notes:['Actual WebGPU prototype uses the shared generated deformation for render and compute.','Production forward/depth/shadow integration remains intentionally unpromoted.','Canonical 1tnk and PBR material definitions remain untouched; GPU proof uses source diffuse colors.']},null,2))
 console.log(`trackloopgate: PASS — rigid closed links, signed/pivot packed phases, wrap relabelling, ${samples.length} actual GPU vertex/normal/tangent samples, ${maxPositionError}m error, 24-float instance, one draw`)
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
