import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createCompanionService } from './companion-service.mjs';

function messages(ws) {
 const backlog = [], pending = [];
 ws.on('message', bytes => { const value = JSON.parse(bytes); const waiter = pending.shift(); if (waiter) waiter(value); else backlog.push(value); });
 return () => backlog.length ? Promise.resolve(backlog.shift()) : new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), 1500); pending.push(value => { clearTimeout(timer); resolve(value); }); });
}
test('pairing requires main approval; permissions, pause, resume, expiry and revocation are enforced', async t => {
 let clock = Date.now();
 const service = createCompanionService({enabled:true, originAllowed:o => o === 'https://game.test', now:() => clock});
 const server = http.createServer(); server.on('upgrade',(req,socket,head) => service.upgrade(req,socket,head));
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 const sockets = []; t.after(async () => { service.close(); for (const ws of sockets) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
 const connect = async () => { const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/v2/companion/ws`,{origin:'https://game.test'}); sockets.push(ws); const next = messages(ws); await new Promise((resolve,reject) => { ws.once('open',resolve); ws.once('error',reject); }); return {ws,next,send:m => ws.send(JSON.stringify(m))}; };
 const primary = await connect(); primary.send({type:'create',kind:'skirmish'}); const created = await primary.next(); assert.equal(created.type,'created'); assert.match(created.code,/^[A-Z2-9]{8}$/);
 const phone = await connect(); phone.send({type:'attach',code:created.code,label:'Phone'}); assert.equal((await phone.next()).type,'pending'); assert.equal((await primary.next()).type,'approval');
 phone.send({type:'intent',intent:{action:'support'}}); // pending receives no state or command authorization
 primary.send({type:'approve',accept:true,tier:'information'}); const approved = await phone.next(); assert.equal(approved.type,'approved'); assert.equal((await primary.next()).type,'connected');
 phone.send({type:'intent',intent:{action:'support'}}); assert.equal((await phone.next()).type,'error');
 // Taunts pass at every permission, a few seconds apart, and only known-shaped ids reach the game.
 phone.send({type:'taunt',taunt:'you-suck'}); assert.equal((await phone.next()).type,'taunt-sent'); assert.deepEqual(await primary.next(),{type:'taunt',taunt:'you-suck'});
 phone.send({type:'taunt',taunt:'you-suck'}); assert.equal((await phone.next()).type,'taunt-refused');
 clock += 4000; primary.send({type:'heartbeat'}); await phone.next();
 phone.send({type:'taunt',taunt:'<script>'}); assert.equal((await phone.next()).type,'taunt-refused');
 primary.send({type:'permission',tier:'support'}); assert.equal((await phone.next()).tier,'support');
 phone.send({type:'intent',intent:{action:'move'}}); assert.equal((await phone.next()).type,'error');
 phone.send({type:'intent',intent:{action:'support',id:'s1'}}); assert.equal((await primary.next()).intent.id,'s1');
 primary.send({type:'pause',paused:true}); assert.equal((await phone.next()).paused,true);
 phone.send({type:'intent',intent:{action:'support'}}); assert.equal((await phone.next()).type,'error');
 primary.send({type:'pause',paused:false}); await phone.next(); clock += 3000;
 phone.send({type:'intent',intent:{action:'support'}}); assert.equal((await phone.next()).type,'error');
 primary.send({type:'heartbeat'}); await phone.next();
 phone.ws.close(); await new Promise(resolve => phone.ws.once('close',resolve)); assert.equal((await primary.next()).type,'detached');
 const returned = await connect(); returned.send({type:'resume',id:approved.id,token:approved.token}); assert.equal((await returned.next()).tier,'support');
 primary.send({type:'revoke'}); assert.equal((await returned.next()).type,'ended'); assert.equal((await primary.next()).type,'ended'); assert.equal(service.size,0);
});
test('hosted sessions fail closed without a trusted admission hook',async t => {
 const service = createCompanionService({enabled:true,originAllowed:()=>true}); const server = http.createServer(); server.on('upgrade',(req,s,h)=>service.upgrade(req,s,h)); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`); t.after(async()=>{ws.terminate();service.close();await new Promise(r=>server.close(r));}); const next = messages(ws); await new Promise(r=>ws.once('open',r)); ws.send(JSON.stringify({type:'create',kind:'hosted',allowed:true,ranked:false})); assert.equal((await next()).type,'error'); assert.equal(service.size,0);
});
