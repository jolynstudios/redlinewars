/** Stable far-to-near order for nonnegative float32 squared distances, without frame allocations. */
export class ParticleOrder {
 readonly distances: Float32Array
 readonly indices: Uint32Array
 private readonly keys: Uint32Array
 private readonly scratch: Uint32Array
 private readonly buckets = new Uint32Array(256)
 constructor(limit: number) {
  this.distances = new Float32Array(limit)
  this.keys = new Uint32Array(this.distances.buffer)
  this.indices = new Uint32Array(limit)
  this.scratch = new Uint32Array(limit)
 }
 sort(count: number): Uint32Array {
  for(let i=0;i<count;i++)this.indices[i]=i
  if(count<32){
   for(let i=1;i<count;i++){
    const id=this.indices[i];let j=i-1
    while(j>=0&&this.distances[this.indices[j]]<this.distances[id]){this.indices[j+1]=this.indices[j];j--}
    this.indices[j+1]=id
   }
   return this.indices
  }
  // Positive IEEE754 float bits have the same ordering as their numeric values.
  // Stable LSD radix passes preserve submission order at equal rounded distances.
  let source=this.indices,target=this.scratch
  for(let shift=0;shift<32;shift+=8){
   this.buckets.fill(0)
   for(let i=0;i<count;i++)this.buckets[255-((this.keys[source[i]]>>>shift)&255)]++
   let offset=0
   for(let b=0;b<256;b++){const size=this.buckets[b];this.buckets[b]=offset;offset+=size}
   for(let i=0;i<count;i++){
    const id=source[i],bucket=255-((this.keys[id]>>>shift)&255)
    target[this.buckets[bucket]++]=id
   }
   const swap=source;source=target;target=swap
  }
  return this.indices // Four passes end in the original buffer.
 }
}
