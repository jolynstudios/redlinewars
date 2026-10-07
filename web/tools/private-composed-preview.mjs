// Isolated generated AppBundle copy: never overwrites the shared running game.
import {cpSync,existsSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {WEB_ROOT,stopChild} from './harness.mjs'
import {spawnProcessGroup} from './process-group.mjs'
export async function startPrivateComposed(port=8467,dist=join(WEB_ROOT,'dist')){
 const temp=mkdtempSync(join(tmpdir(),'steelseed-private-composed-')),root=join(temp,'AppBundle')
 const source=resolve(WEB_ROOT,'../engine/bin-browser/AppBundle')
 let server
 try{
  cpSync(source,root,{recursive:true,filter:p=>p!==join(source,'steelseed')})
  cpSync(dist,join(root,'steelseed'),{recursive:true})
  // Vite emits code/assets only; compose adds these runtime contracts beside
  // index.html. A private preview overlays fresh dist onto the last composed
  // bundle, so carry the contracts across as well or the otherwise-valid page
  // logs a test-only 404 for net-config.json and cannot identify its build.
  for(const name of ['net-config.json','build.json','composition.json']){
   const contract=join(source,'steelseed',name)
   if(existsSync(contract))cpSync(contract,join(root,'steelseed',name))
  }
  const index=join(root,'steelseed/index.html'),html=readFileSync(index,'utf8'),script=/<script type="module"[^>]*src="\.\/assets\/[^\"]+"[^>]*><\/script>/
  if(!script.test(html))throw Error('private compose: missing presentation entry')
  writeFileSync(index,html.replace(script,'<script type="module" src="../main.js"></script>\n$&'))
  server=spawnProcessGroup(process.execPath,[resolve(WEB_ROOT,'../engine/OpenRA.Browser/tests/server.mjs'),'--root',root,'--port',String(port)],{stdio:['ignore','pipe','pipe']})
  const baseUrl=`http://127.0.0.1:${port}/steelseed/index.html?mode=game&platform=null`
  await new Promise((resolveReady,reject)=>{
   const timer=setTimeout(()=>reject(Error('private composed server startup timeout')),20000)
   server.once('error',error=>{clearTimeout(timer);reject(error)})
   server.once('exit',code=>{clearTimeout(timer);reject(Error(`private composed server exited ${code}`))})
   server.stdout.once('data',()=>{clearTimeout(timer);resolveReady()})
  })
  const response=await fetch(baseUrl)
  if(!response.ok)throw Error(`private composed index HTTP ${response.status}`)
  return {baseUrl,async close(){await stopChild(server);rmSync(temp,{recursive:true,force:true})}}
 }catch(error){if(server)await stopChild(server);rmSync(temp,{recursive:true,force:true});throw error}
}
