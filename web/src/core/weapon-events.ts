import type {SnapshotEvent} from './snapshot'
/** Copies reused snapshot bytes until the model's current pose has been placed this frame. */
export class WeaponEvents {
 private readonly bytes=new Uint8Array(512*64)
 private readonly view=new DataView(this.bytes.buffer)
 private readonly events=Array.from({length:512},(_,i)=>({kind:0,offset:i*64,byteLength:0}))
 private count=0
 dropped=0
 enqueue(event:SnapshotEvent,source:DataView|undefined):boolean {
  if(!source||!Number.isInteger(event.offset)||!Number.isInteger(event.byteLength)||event.offset<0||event.byteLength<0||event.byteLength>64||event.offset+event.byteLength>source.byteLength)return false
  if(this.count===512){this.dropped++;return true}
  const e=this.events[this.count++];e.kind=event.kind;e.byteLength=event.byteLength
  for(let i=0;i<event.byteLength;i++)this.bytes[e.offset+i]=source.getUint8(event.offset+i)
  return true
 }
 drain(consume:(event:SnapshotEvent,view:DataView)=>void):void {for(let i=0;i<this.count;i++)consume(this.events[i],this.view);this.count=0}
 clear():void {this.count=0}
}
