#!/usr/bin/env node
// Real Sky/Audio scheduler and seeded PCM, without GPU or sound hardware.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const web = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'weatheraudiogate-'))
try {
 await build({ stdin: { contents: `export { Audio } from './src/audio/index'; export { Sky } from './src/sky/index'; export { renderRain, renderThunder, rms, dcOffset, spectralCentroid } from './src/audio/synth'; export { budgetFor, QUALITY_NAMES } from './src/core/config';`, resolveDir: web }, bundle:true, format:'esm', platform:'neutral', outfile:join(temp,'gate.mjs'), logLevel:'silent' })
 const { Audio,Sky,renderRain,renderThunder,rms,dcOffset,spectralCentroid,budgetFor,QUALITY_NAMES } = await import(join(temp,'gate.mjs'))
 for(const rate of [44100,48000]) for(const seed of [1,12345,0x51eed]) {
  const start=performance.now(),rain=renderRain(rate,seed), thunder=renderThunder(rate,seed),buildMs=performance.now()-start
  for(const [name,v,fn] of [['rain',rain,renderRain],['thunder',thunder,renderThunder]]) {
   assert.deepEqual(v.samples,fn(rate,seed).samples,`${name}: stable seed`)
   assert.notDeepEqual(v.samples,fn(rate,seed+1).samples,`${name}: seed varies texture`)
   assert.equal(v.samples.length,rate*6)
   assert.ok(v.samples.every(Number.isFinite))
   assert.ok(rms(v.samples)>.015,`${name}: audible energy`)
   assert.ok(Math.abs(dcOffset(v.samples))<.002,`${name}: no DC offset`)
   assert.ok(v.samples.every(v=>Math.abs(v)<=.73),`${name}: headroom`)
  }
  const r=rain.samples;let steps=0
  for(let i=1;i<r.length;i++) steps+=(r[i]-r[i-1])**2
  const seam=Math.abs(r[0]-r.at(-1))/Math.sqrt(steps/(r.length-1))
  assert.ok(seam<4,`rain seam ${seam}: no abnormal boundary step`)
  const windows=Array.from({length:12},(_,i)=>rms(r.subarray(i*rate/2,(i+1)*rate/2)))
  assert.ok(Math.min(...windows)/Math.max(...windows)>.8,'rain sustains through seam')
  assert.equal(Math.abs(thunder.samples[0]),0);assert.equal(Math.abs(thunder.samples.at(-1)),0)
  assert.ok(rms(thunder.samples.subarray(rate*5))<rms(thunder.samples.subarray(0,rate))*.2,'thunder tail decays')
  const rainHz=spectralCentroid(r,rate),thunderHz=spectralCentroid(thunder.samples,rate)
  assert.ok(rainHz>thunderHz*4,'rain and thunder are spectrally distinct')
  console.log(`PCM ${rate} seed ${seed}: build ${buildMs.toFixed(1)}ms, rain RMS ${rms(r).toFixed(3)}, seam ${seam.toFixed(2)}, rain/thunder ${Math.round(rainHz)}/${Math.round(thunderHz)} Hz`)
 }
 class Param {constructor(value){this.value=value;this.targets=[]}setTargetAtTime(value,at,constant){this.targets.push({value,at,constant})}}
 class Context {
  constructor(){this.state='suspended';this.currentTime=0;this.sampleRate=48000;this.destination={};this.sources=[];this.closed=false}
  createGain(){return {gain:new Param(1),connect(n){this.output=n}}}
  createStereoPanner(){return {pan:new Param(0),connect(n){this.output=n}}}
  createBiquadFilter(){return {frequency:new Param(0),connect(n){this.output=n}}}
  createBuffer(_channels,length,rate){const data=new Float32Array(length);return {duration:length/rate,getChannelData:()=>data}}
  createBufferSource(){const s={buffer:null,playbackRate:new Param(1),loop:false,stopped:false,connect(n){this.output=n},disconnect(){},start(when=0){this.when=when;this.started=true},stop(){this.stopped=true}};this.sources.push(s);return s}
  resume(){this.state='running';return Promise.resolve()}
  close(){this.closed=true;this.state='closed';return Promise.resolve()}
 }
 globalThis.AudioContext=Context;globalThis.addEventListener=()=>{};globalThis.removeEventListener=()=>{}
 function setup(preset='storm',seed=12345,budget=48){
  globalThis.location={search:`?weather=${preset}`}
  const sky=new Sky(),audio=new Audio(),render={setEnvironment(v){this.environment=v}},canvas=new EventTarget(),events=new Map()
  const ctx={canvas,config:{q:{audioVoices:budget}},time:{tick:0,alpha:0},snapshot:{flags:0,actors:null,world:{environment:null}},rng:{forkNamed:()=>({nextU32:()=>seed,int:()=>seed})},peek:id=>id==='sky'?sky:null,get:id=>id==='render'?render:null,events:{on(k,fn){events.set(k,fn);return ()=>events.delete(k)},emit(k,v){events.get(k)?.(v)}}}
  audio.init(ctx);sky.init(ctx);const actx=audio.actx
  function frame(time,dt=1/60){ctx.time.tick=Math.floor(time*25);ctx.time.alpha=time*25-ctx.time.tick;actx.currentTime+=dt;sky.onSnapshot(ctx.snapshot,null,ctx);sky.update(dt,ctx);audio.update(dt,ctx);audio.lateUpdate(dt,ctx)}
  function frames(from,to,step=1/60){for(let t=from;t<to;t+=step)frame(t,step);frame(to,step)}
  const wake=()=>canvas.dispatchEvent(new Event('pointerdown')),thunders=()=>actx.sources.filter(s=>s.buffer===audio.thunderBuffer&&s.started)
  frame(0);return {sky,audio,ctx,actx,render,frame,frames,wake,thunders}
 }
 const slow=setup(),fast=setup(),ids=new Map()
 for(let t=0;t<=600;t+=.1){slow.frame(t);const s=slow.sky.lightningStrike;if(s&&!ids.has(s.id))ids.set(s.id,{...s})}
 assert.equal(ids.size,25,'occasional cadence: 25 strikes per ten minutes')
 let previous=null
 for(const strike of ids.values()){
  if(previous)assert.ok(strike.time-previous.time>=14&&strike.time-previous.time<=34)
  assert.ok(strike.thunderTime-strike.time>=.8&&strike.thunderTime-strike.time<=3)
  fast.frame(strike.time+.001);assert.deepEqual(fast.sky.lightningStrike,strike)
  assert.ok(fast.sky.lightning>.6,'actual sky flash shares strike time')
  assert.equal(fast.render.environment.lightning,fast.sky.lightning)
  // Advance only update: no new snapshot is needed to end the flash.
  const later=strike.time+.3;fast.ctx.time.tick=Math.floor(later*25);fast.ctx.time.alpha=later*25-fast.ctx.time.tick
  fast.sky.update(.3,fast.ctx);assert.equal(fast.sky.lightning,0)
  previous=strike
 }
 const different=setup('storm',42);different.frame(20);assert.notEqual(different.sky.lightningStrike.time,ids.get(0).time,'seed changes strike timing');different.audio.dispose()
 slow.audio.dispose();fast.audio.dispose()
 const first=ids.get(0),second=ids.get(1),run=setup()
 run.frames(0,first.time+.1);assert.equal(run.actx.sources.length,0,'autoplay creates no sources before gesture')
 run.wake();run.frame(first.time+.11);run.frames(first.time+.11,first.thunderTime+.3)
 assert.equal(run.thunders().length,0,'unlock never catches up an unheard flash')
 run.frames(first.thunderTime+.3,second.time-.05)
 run.frame(second.time+.3,.35);assert.equal(run.sky.lightning,0);assert.equal(run.thunders().length,0)
 const held=second.time+.3;run.ctx.snapshot.flags=2
 for(let i=0;i<400;i++)run.frame(held)
 assert.equal(run.thunders().length,0,'pause wall time cannot release thunder')
 assert.equal(run.audio.rain.gain.gain.targets.at(-1).value,0)
 run.ctx.snapshot.flags=0;run.frames(held,second.thunderTime-.001)
 assert.equal(run.thunders().length,0,'thunder waits for exact simulation due time')
 run.frame(second.thunderTime+.001);assert.equal(run.thunders().length,1)
 assert.equal(run.thunders()[0].when,run.actx.currentTime)
 for(let i=0;i<200;i++)run.frame(second.thunderTime+.001)
 assert.equal(run.thunders().length,1,'repeated frames never replay thunder')
 run.frame(second.time-.2);assert.equal(run.thunders()[0].stopped,true)
 run.frames(second.time-.2,second.thunderTime+.02);assert.equal(run.thunders().length,2,'rewind replays a newly crossed strike once')
 run.frame(second.time-.1);run.frame(second.time+.01);run.frame(second.time-.01)
 run.frames(second.time-.01,second.thunderTime+.02);assert.equal(run.thunders().length,3,'interpolation corrections never duplicate thunder')
 run.frame(400);assert.equal(run.thunders().length,3,'forward seek never bursts old thunder')
 const rain=run.audio.rain;assert.equal(rain.src.loop,true)
 assert.ok(rain.gain.gain.targets.some(t=>t.value===.28&&t.constant===.3))
 run.audio.setMasterVolume(0);assert.equal(run.audio.master.gain.value,0)
 assert.equal(rain.gain.output,run.audio.master);assert.equal(run.audio.thunderSlot.lp.output,run.audio.master)
 run.audio.dispose();assert.ok(rain.src.stopped&&run.actx.closed,'dispose releases sources and context')
 const count=run.actx.sources.length;run.wake();run.frame(401);assert.equal(run.actx.sources.length,count,'disposed gesture cannot restart audio')
 for(const preset of ['clear','mud','snow','rain','storm','lightning']){
  const x=setup(preset);x.wake();x.frame(0);x.frame(1)
  assert.equal(x.audio.rain.gain.gain.targets.at(-1).value>0,['rain','storm','lightning'].includes(preset),`${preset} rain target`)
  x.ctx.snapshot.world.environment={timeOfDay:1080,weatherKind:3,weatherIntensity:1000,windDirection:0,windSpeed:300};x.frame(2)
  assert.equal(x.sky.rainIntensity,0);assert.equal(x.sky.snowIntensity,1);assert.equal(x.sky.lightningStrike,null)
  assert.equal(x.audio.rain.gain.gain.targets.at(-1).value,0,'authored snow has no rain sound')
  x.ctx.snapshot.world.environment.weatherKind=2;x.ctx.snapshot.world.environment.weatherIntensity=900;x.frame(3)
  assert.equal(x.sky.rainIntensity,.9,'authored rain intensity preserved');assert.equal(x.audio.rain.gain.gain.targets.at(-1).value,.9*.28)
  x.frame(first.time+.001);assert.ok(x.sky.lightningStrike,'authored heavy rain produces coherent lightning')
  x.ctx.snapshot.world.environment.weatherIntensity=720;x.frame(first.time+.01);assert.equal(x.sky.lightningStrike,null,'ordinary authored rain has no lightning')
  x.audio.dispose()
 }
 for(const name of [...QUALITY_NAMES,'tiny','silent']){
  const budget=name==='tiny'?8:name==='silent'?0:budgetFor(name).audioVoices,x=setup('storm',12345,budget)
  x.wake();x.frame(0)
  for(let i=0;i<budget*2;i++)x.audio.play(x.audio.notify,0,0,0,.5,i)
  x.audio.pendingStrength=1;x.audio.playThunder()
  const actual=x.actx.sources.filter(s=>s.started&&!s.stopped).length
  assert.ok(actual<=budget,`${name}: ${actual} sources exceed ${budget}`)
  assert.equal(x.audio.voicesActive,actual,`${name}: diagnostic counts all sources`)
  console.log(`${name}: ${actual}/${budget} sources under combat + weather load`);x.audio.dispose()
 }
 console.log('weatheraudiogate: PASS — deterministic PCM, shared strikes, delayed thunder, pause/replay/autoplay, precipitation, smoothing, disposal and all voice budgets')
}finally{rmSync(temp,{recursive:true,force:true})}
