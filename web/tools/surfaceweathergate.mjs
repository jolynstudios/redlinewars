#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const web=resolve(fileURLToPath(new URL('..',import.meta.url))),temp=mkdtempSync(join(tmpdir(),'steelseed-surface-weather-'));
try{
 await build({stdin:{contents:"export {SurfaceWeather} from './src/sky/surface-weather'; export {SkyModel} from './src/sky/model';",resolveDir:web},bundle:true,format:'esm',platform:'node',outfile:join(temp,'gate.mjs'),logLevel:'silent'});
 const {SurfaceWeather,SkyModel}=await import(pathToFileURL(join(temp,'gate.mjs')).href);
 const run=(hz)=>{const s=new SurfaceWeather();s.advance(0,1,0);for(let i=1;i<=60*hz;i++)s.advance(i/hz,1,0);return s};
 const slow=run(1),fast=run(120);
 assert(slow.snowCoverage>.9,'sustained snowfall must cover ground');
 assert(Math.abs(slow.snowCoverage-fast.snowCoverage)<1e-10,'snow depends on elapsed simulation time, not frame rate');
 const before=fast.snowCoverage;fast.advance(60,1,0);fast.advance(59.96,1,0);fast.advance(60,1,0);
 assert.equal(fast.snowCoverage,before,'pause/interpolation corrections must not add snow twice');
 fast.advance(61,0,0);assert(fast.snowCoverage>.85,'snow must remain after precipitation stops');
 assert(fast.surfaceWetness>0,'melting snow leaves moisture');
 fast.advance(0,0,0);assert.equal(fast.snowCoverage,0,'rewind must clear stale weather history');
 const rain=new SurfaceWeather();rain.advance(0,0,1);rain.advance(1,0,0);
 assert(rain.surfaceWetness>.9,'wet ground must not instantly dry when rain stops');
 rain.advance(2,NaN,NaN);assert(Number.isFinite(rain.surfaceWetness));
 const sky=new SkyModel();sky.evaluate(720,3,1000,0,400);sky.advance(0);
 assert.equal(sky.rainIntensity,0);assert.equal(sky.snowIntensity,1);assert.equal(sky.environment.snowCoverage,.55);
 sky.evaluate(720,0,0,0,400);sky.advance(1);assert.equal(sky.snowIntensity,0);assert(sky.environment.snowCoverage>.5);
 sky.assertFinite();
 console.log('surfaceweathergate: PASS — time-based accumulation, precipitation/state separation, retained wetness, melting, pause and seek.');
}finally{rmSync(temp,{recursive:true,force:true})}
