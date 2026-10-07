import { setBoneAngle, type Pose } from '../geo/rig'
import type { UnitRig } from './shapes'

/** Simulation-clock idle motion plus distance-driven feet. No wall clock or allocations. */
export function scenicPose(rig: UnitRig, pose: Pose, time: number, travel: number, scale: number, phase: number): void {
 pose.resetToBind()
 const cycle=travel/Math.max(.01,rig.strideM*scale)*Math.PI*2
 for(let leg=0;leg<rig.legBones.length;leg++)setBoneAngle(pose,rig.legBones[leg],Math.sin(cycle+rig.legPhase[leg])*.24)
 const { oscillatorBones, oscillatorSpeeds, oscillatorPhases, oscillatorAmplitudes } = rig
 if (!oscillatorBones || !oscillatorSpeeds || !oscillatorPhases || !oscillatorAmplitudes) return
 for(let joint=0;joint<oscillatorBones.length;joint++){
  const angle=Math.sin(time*oscillatorSpeeds[joint]+oscillatorPhases[joint]+phase)*oscillatorAmplitudes[joint]
  setBoneAngle(pose,oscillatorBones[joint],angle)
 }
}
