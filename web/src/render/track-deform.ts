import DESCRIPTOR from '../core/track-loops.json'
import { trackLoopWgsl } from '../core/track-loop'
/** One source-generated table and transform shared by every position-producing pass. */
export const TRACK_DEFORM_WGSL=trackLoopWgsl(DESCRIPTOR.loop)+`
fn trackSidePhase(packed:f32,z:f32)->f32 {
 let bits=u32(max(0.0,packed));return f32(select(bits&4095u,(bits>>12u)&4095u,z>=0.0))/4096.0;
}
fn authoredTrack(p:vec3<f32>,n:vec3<f32>,t:vec4<f32>,zone:vec4<u32>,phase:f32)->TrackVertex {
 if(zone.w==3u && zone.z==0u){return trackVertex(p,n,t,zone.y,phase);}
 return TrackVertex(p,n,t);
}
fn authoredTrackPosition(p:vec3<f32>,zone:vec4<u32>,packed:f32)->vec3<f32> {
 return authoredTrack(p,vec3<f32>(0,1,0),vec4<f32>(1,0,0,1),zone,trackSidePhase(packed,p.z)).p;
}
`
/** Wheel travel preserves link correspondence across many shoe-pitch wraps. */
export const TRACK_PREVIOUS_WGSL=`
fn previousTrackPosition(p:vec3<f32>,zone:vec4<u32>,inst:Instance,prev:Instance)->vec3<f32> {
 if(zone.w!=3u || zone.z!=0u){return p;}
 let phase=trackSidePhase(inst.misc.z,p.z);let base=u32(inst.misc.y);let prior=u32(prev.misc.y);
 if(base==0u || prior==0u){return authoredTrack(p,vec3<f32>(0,1,0),vec4<f32>(1,0,0,1),zone,phase).p;}
 let joint=select(${DESCRIPTOR.roadBones[0]}u,${DESCRIPTOR.roadBones[1]}u,p.z>=0.0);
 let a=normalize(bones[base+joint][0].xy);let b=normalize(previousBones[prior+joint][0].xy);
 let angle=atan2(a.x*b.y-a.y*b.x,dot(a,b));
 let scale=length(inst.model[0].xyz);let travel=angle*${DESCRIPTOR.roadRadius.toFixed(9)};
 // The hull-transform bound detects frames too large to disambiguate a road-wheel turn.
 // Such discontinuities keep hull/camera velocity and omit internal tread velocity.
 let hullDelta=distance(inst.model[3].xyz,prev.model[3].xyz)/max(scale,.0001);
 let turn=acos(clamp(dot(normalize(inst.model[0].xz),normalize(prev.model[0].xz)),-1.0,1.0));
 let bounded=hullDelta+turn*${DESCRIPTOR.sideZ.toFixed(9)} < ${(.085*Math.PI*.9).toFixed(9)};
 let oldPhase=phase-select(0.0,travel/TRACK_PITCH,bounded);
 return authoredTrack(p,vec3<f32>(0,1,0),vec4<f32>(1,0,0,1),zone,oldPhase).p;
}
`
