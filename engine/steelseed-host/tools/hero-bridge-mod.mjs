// Host-owned original landmark. Upstream legacy bridge templates remain untouched.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
const shared=JSON.parse(readFileSync(new URL('../../../web/src/terrain/hero-bridge.json',import.meta.url),'utf8'))
export const HERO_BRIDGE = {...shared,map:{id:'planx-river-crossing',width:66,height:50,x:28,y:21}}
export const HERO_BRIDGE_RULE =
	`\nSSHEROBRIDGE:\n\tInherits: ^Bridge\n\tInherits@EXPLOSIVE: ^ExplosiveBridge\n\tBridge:\n\t\tTemplate: 4080\n\t\tDamagedTemplate: 4081\n\t\tDestroyedTemplate: 4082\n\tBuilding:\n\t\tFootprint: ________ ________ ________ ________ ________\n\t\tDimensions: 8,5\n\tFreeActor@west:\n\t\tActor: bridgehut.small\n\t\tSpawnOffset: -1,2\n\tFreeActor@east:\n\t\tActor: bridgehut.small\n\t\tSpawnOffset: 8,2\n\tInteractable:\n\t\tBounds: 8192,5120\n`
export const HERO_BRIDGE_TEMPLATES = (() => {
 let tiles='\n';for(const[state,id]of Object.entries(HERO_BRIDGE.templates)){tiles+=`\tTemplate@${id}:\n\t\tId: ${id}\n\t\tImages: clear1.tem\n\t\tSize: 8,5\n\t\tCategories: STEELSEED Landmark\n\t\tTiles:\n`;HERO_BRIDGE.masks[state].flatMap(row=>[...row]).forEach((v,i)=>{tiles+=`\t\t\t${i}: ${v==='B'?'Bridge':'Rock'}\n`})}
 // One-cell host road/water templates avoid changing any legacy template.
 const extra=[['Road',4083],['Water',4084]];let plain='';for(const[type,id]of extra)plain+=`\tTemplate@${id}:\n\t\tId: ${id}\n\t\tImages: clear1.tem\n\t\tSize: 1,1\n\t\tTiles:\n\t\t\t0: ${type}\n`
 return tiles+plain
})()
export function installHeroBridge(outputRoot){
	const civilian=join(outputRoot,'rules/civilian.yaml');writeFileSync(civilian,readFileSync(civilian,'utf8')+HERO_BRIDGE_RULE)
	const world=join(outputRoot,'rules/world.yaml');let w=readFileSync(world,'utf8');const pattern=/(\tLegacyBridgeLayer:\n\t\tBridges: [^\n]+)/;if(!pattern.test(w))throw Error('Hero bridge: missing LegacyBridgeLayer');w=w.replace(pattern,'$1, ssherobridge');writeFileSync(world,w)
 const ts=join(outputRoot,'tilesets/temperat.yaml')
 const p=join(outputRoot,'maps',HERO_BRIDGE.map.id);mkdirSync(p,{recursive:true});const {width,height,x,y}=HERO_BRIDGE.map,n=width*height,bin=Buffer.alloc(5+n*5);bin[0]=1;bin.writeUInt16LE(width,1);bin.writeUInt16LE(height,3)
 // One-cell host road/water templates avoid changing any legacy template.
 const extra=[['Road',4083],['Water',4084]];let plain='';for(const[type,id]of extra)plain+=`\tTemplate@${id}:\n\t\tId: ${id}\n\t\tImages: clear1.tem\n\t\tSize: 1,1\n\t\tTiles:\n\t\t\t0: ${type}\n`;writeFileSync(ts,insertHeroTemplates(readFileSync(ts,'utf8'),HERO_BRIDGE_TEMPLATES))
 for(let cx=0;cx<width;cx++)for(let cy=0;cy<height;cy++){
  let tile=cx>=x&&cx<x+8?4084:255,index=0;
  if((cx===x-1||cx===x+8)&&cy>=y&&cy<y+5)tile=4083;
  if(cx>=x&&cx<x+8&&cy>=y&&cy<y+5){tile=4081;index=(cy-y)*8+cx-x}
  const off=5+(cx*height+cy)*3;bin.writeUInt16LE(tile,off);bin[off+2]=index
 }
 writeFileSync(join(p,'map.bin'),bin)
 writeFileSync(join(p,'map.yaml'),`MapFormat: 12\nRequiresMod: ra\nTitle: River Crossing — STEELSEED\nAuthor: STEELSEED\nTileset: TEMPERAT\nMapSize: ${width},${height}\nBounds: 1,1,64,48\nVisibility: Lobby\nCategories: Conquest\nPlayers:\n\tPlayerReference@Neutral:\n\t\tName: Neutral\n\t\tOwnsWorld: True\n\t\tNonCombatant: True\n\t\tFaction: england\n\tPlayerReference@Creeps:\n\t\tName: Creeps\n\t\tNonCombatant: True\n\t\tFaction: england\n\t\tEnemies: Multi0, Multi1\n\tPlayerReference@Multi0:\n\t\tName: Multi0\n\t\tPlayable: True\n\t\tFaction: england\n\t\tEnemies: Multi1, Creeps\n\tPlayerReference@Multi1:\n\t\tName: Multi1\n\t\tPlayable: True\n\t\tFaction: england\n\t\tEnemies: Multi0, Creeps\nActors:\n\tSpawn0: mpspawn\n\t\tOwner: Neutral\n\t\tLocation: 13,22\n\tSpawn1: mpspawn\n\t\tOwner: Neutral\n\t\tLocation: 51,22\n\tBridgePatrolFoot: e1\n\t\tOwner: Multi0\n\t\tLocation: 25,22\n\tBridgePatrolWheeled: jeep\n\t\tOwner: Multi0\n\t\tLocation: 25,24\n\tBridgeEngineer: e6\n\t\tOwner: Multi0\n\t\tLocation: 24,26\n\tBridgePatrolTracked: 2tnk\n\t\tOwner: Multi0\n\t\tLocation: 24,23\n`)
 return {actor:HERO_BRIDGE.actor,map:HERO_BRIDGE.map.id,templates:HERO_BRIDGE.templates,masks:HERO_BRIDGE.masks}
}

export function insertHeroTemplates(yaml, records){
 const start=/^Templates:[ \t]*$/m.exec(yaml)
 if(!start)throw Error('Hero bridge: missing Templates section')
 const bodyStart=start.index+start[0].length+1,tail=yaml.slice(bodyStart),next=/^\S[^\n]*:/m.exec(tail),end=next?bodyStart+next.index:yaml.length
 const result=yaml.slice(0,end)+records+'\n'+yaml.slice(end)
 // Parse root ownership of template children. Appending after MultiBrushCollections
 // silently creates invalid brush entries and prevents every map from starting.
 let parent='',seen=new Set()
 for(const line of result.split('\n')){
  const root=/^(\S[^:]*):/.exec(line);if(root)parent=root[1]
  const template=/^\tTemplate@(408[0-4]):/.exec(line)
  if(template){if(parent!=='Templates'||seen.has(template[1]))throw Error('Hero bridge template outside Templates or duplicated: '+line);seen.add(template[1])}
 }
 if(seen.size!==5)throw Error('Hero bridge: incomplete dedicated template set')
 return result
}
