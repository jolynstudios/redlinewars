// STEELSEED — geo/rig
// The bone/skin-weight rig format consumed by `anim`, plus per-zone UV projection.
//
// Two things live in one file because they are the same concern from two directions: a
// material zone on a rigged actor follows the RIG (turret plate, hull plate, track, barrel),
// not the mesh's bounding box. Projecting per zone is what keeps texel density constant, and
// texel density is what decides whether the detail layer resolves at 0.5 m (§6.7).
//
// Layout is flat and struct-of-arrays throughout. A skeleton is never a node graph walked
// per frame — bones are stored in parent-before-child order so pose evaluation is one
// forward pass over typed arrays with no recursion, no closures and no allocation (rule 6).
//
// Nothing here is random and nothing here reads a clock: a rig is a pure function of the
// descriptors handed to it, so `baseline.mjs` sees byte-identical output every run (rule 5).
// This module owns no GPU handles, so rule 7 has no surface here — the buffers it fills are
// owned and disposed by whoever uploaded them.
//
// Model space convention, from §12.4 and nowhere else: right-handed, **+Y UP**, +X forward,
// +Z lateral. Metres. Turret yaw is about Y, gun pitch about Z, wheel spin about Z.
//
// This header used to say "+Z up, +X forward, +Y left, matching the rest of the project", and
// every default below encoded that. It was wrong: §12.4 pins the renderer as Y-up and says
// "any node doing its own axis swap is a bug", and every archetype generator builds Y-up —
// `boundsForTree` floors at y = 0 for a reason. Nothing had caught it because this module has
// no consumers yet, so the first thing to wire a rig would have found every turret pitching
// over on its side instead of traversing, and every suspension travelling sideways.
//
// The fix is the named axes below rather than a rule to remember. An author writing
// AXIS_UP cannot pick the wrong one; an author writing AXIS_Z has to know the convention.

import type { Mesh } from './mesh'
import { clamp, smoothstep, mat4, m4, v3, type Vec3 } from '../core/math'

// ---------------------------------------------------------------------------
// Bone taxonomy
// ---------------------------------------------------------------------------

export const AXIS_X = 0
export const AXIS_Y = 1
export const AXIS_Z = 2

/**
 * The same three integers, named by what they MEAN in §12.4's model space. Every default in
 * this file uses these, because "wheel spin is about Z" is a claim a reader has to check
 * against the convention and "wheel spin is about the lateral axis" is one they cannot
 * misread. Prefer these in descriptors too.
 */
export const AXIS_FORWARD = AXIS_X
export const AXIS_UP = AXIS_Y
export const AXIS_LATERAL = AXIS_Z

/**
 * Bone kinds are a dense enum because the skeleton indexes bones BY kind (see
 * `countOfKind`/`boneOfKind`), which is how `anim` finds "every wheel" without a string
 * scan per frame.
 */
export const BoneKind = {
	root: 0,
	chassis: 1,
	turret: 2,
	mantlet: 3,
	barrel: 4,
	wheel: 5,
	bogie: 6,
	track: 7,
	door: 8,
	hatch: 9,
	limb: 10,
	foot: 11,
	rotor: 12,
	dish: 13,
	arm: 14,
	machinery: 15,
	antenna: 16,
	banner: 17,
	exhaust: 18,
	hardpoint: 19,
	muzzle: 20,
} as const
export type BoneKind = (typeof BoneKind)[keyof typeof BoneKind]

export const BONE_KIND_COUNT = 21

export const BoneFlags = {
	none: 0,
	/** Never captures vertices. Attach-only nodes (muzzles, hardpoints) must not steal skin. */
	noCapture: 1 << 0,
	/** End of an IK chain — infantry foot planting targets these. */
	ikTip: 1 << 1,
	/** The left-hand member of a mirrored pair; `anim` offsets its gait phase by half a cycle. */
	mirrored: 1 << 2,
} as const

/** Joint indices are u8 for the GPU buffer, so a rig cannot exceed this. */
export const MAX_BONES = 256

/**
 * Default articulation axis by kind. A descriptor may override it; most never need to.
 *
 * Yaw about UP is the common case — a turret traverses, a dish sweeps, a rotor spins, a door
 * swings on a vertical hinge. The overrides are the things that PITCH: a gun elevates, a
 * wheel rolls, a leg swings fore-and-aft. All of those rotate about the LATERAL axis.
 */
const KIND_AXIS = new Uint8Array(BONE_KIND_COUNT)
KIND_AXIS.fill(AXIS_UP)
KIND_AXIS[BoneKind.mantlet] = AXIS_LATERAL
KIND_AXIS[BoneKind.barrel] = AXIS_LATERAL
KIND_AXIS[BoneKind.wheel] = AXIS_LATERAL
KIND_AXIS[BoneKind.bogie] = AXIS_LATERAL
KIND_AXIS[BoneKind.limb] = AXIS_LATERAL
KIND_AXIS[BoneKind.foot] = AXIS_LATERAL
KIND_AXIS[BoneKind.arm] = AXIS_LATERAL

/**
 * Default travel axis by kind. Suspension and doors travel along UP; a gun recoils back along
 * its own bore, which is local FORWARD.
 */
const KIND_TRAVEL_AXIS = new Uint8Array(BONE_KIND_COUNT)
KIND_TRAVEL_AXIS.fill(AXIS_UP)
KIND_TRAVEL_AXIS[BoneKind.barrel] = AXIS_FORWARD
KIND_TRAVEL_AXIS[BoneKind.mantlet] = AXIS_FORWARD

/** Kinds that are pure attach points. Geometry never binds to them. */
const KIND_NO_CAPTURE = new Uint8Array(BONE_KIND_COUNT)
KIND_NO_CAPTURE[BoneKind.hardpoint] = 1
KIND_NO_CAPTURE[BoneKind.muzzle] = 1

/** A bone whose descriptor omits its kind is body geometry. */
const DEFAULT_KIND: number = BoneKind.chassis

/** Whatever integer array the mesh carries its per-vertex material zone in. */
export type ZoneArray = Uint8Array | Uint16Array | Uint32Array | Int32Array

// ---------------------------------------------------------------------------
// Naming grammar
// ---------------------------------------------------------------------------
//
// `anim` cannot import this module — rule 3 makes `core` the only importable subsystem — so
// it reaches the rig through `ctx.get('geo')` and addresses bones BY NAME with hard-coded
// strings. That makes these names a cross-node contract, not an implementation detail. The
// grammar is:
//
//   root                                  model root
//   chassis                               the rigid body everything hangs from
//   turret.<i>                            yaw ring
//   turret.<i>.mantlet.<j>                gun cradle, carries elevation
//   turret.<i>.barrel.<j>                 carries recoil travel
//   turret.<i>.barrel.<j>.muzzle          attach-only; fx spawns the flash here
//   wheel.<l|r>.<i>                       spin about Y, suspension travel along Z
//   bogie.<l|r>.<i>                       suspension only
//   door.<name>                           cargo ramps, hatch covers, silo lids
//   hp.<name>                             hardpoint: cargo, banner, exhaust, antenna mounts
//   limb.<l|r>.<segment>, foot.<l|r>      infantry
//
// Build these with the helpers below rather than by hand — a typo in a name is a bone that
// silently never animates, which is exactly the failure this grammar exists to prevent.

export type Side = 'l' | 'r'

export const ROOT_BONE = 'root'
export const CHASSIS_BONE = 'chassis'

export function turretBone(turret: number): string {
	return `turret.${turret}`
}
export function mantletBone(turret: number, gun: number): string {
	return `turret.${turret}.mantlet.${gun}`
}
export function barrelBone(turret: number, gun: number): string {
	return `turret.${turret}.barrel.${gun}`
}
export function muzzleBone(turret: number, gun: number): string {
	return `turret.${turret}.barrel.${gun}.muzzle`
}
export function wheelBone(side: Side, index: number): string {
	return `wheel.${side}.${index}`
}
export function bogieBone(side: Side, index: number): string {
	return `bogie.${side}.${index}`
}
export function doorBone(name: string): string {
	return `door.${name}`
}
export function hardpointBone(name: string): string {
	return `hp.${name}`
}
export function limbBone(side: Side, segment: string): string {
	return `limb.${side}.${segment}`
}
export function footBone(side: Side): string {
	return `foot.${side}`
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export interface BoneDesc {
	name: string
	/** Parent bone, by name or index. Omit for a root. The parent must already exist. */
	parent?: string | number
	kind?: number
	/** Bind-pose local translation in parent space, metres. */
	pos?: ArrayLike<number>
	/** Bind-pose local rotation, quaternion xyzw. */
	rot?: ArrayLike<number>
	/** Bind-pose local scale. Non-uniform scale on a skinned bone shears normals — avoid it. */
	scale?: ArrayLike<number>
	/**
	 * Far end of the capture segment, in BONE-local space. Default (0,0,0) makes a point
	 * bone. Give every bone that owns elongated geometry a real tail — capture by distance
	 * to the segment is the whole reason a barrel tip stays with the barrel instead of being
	 * swallowed by the turret ring, whose joint happens to be closer to the origin.
	 */
	tail?: ArrayLike<number>
	/** Hard capture envelope, metres from the segment. Beyond it the bone cannot claim a vertex. */
	radius?: number
	/**
	 * Soft-skin band width, metres. 0 (the default) binds rigidly to one bone, which is what
	 * hard-surface machinery wants — a turret plate must not smear into the hull. Infantry
	 * limbs want a band roughly the limb's own thickness.
	 */
	blend?: number
	/** Subtracted from this bone's distance during capture. Lets a part win contested vertices. */
	bias?: number
	axis?: number
	travelAxis?: number
	/** Articulation limits, radians. Defaults are unbounded, which is what a wheel wants. */
	limitMin?: number
	limitMax?: number
	/** Travel limits along `travelAxis`, metres. */
	travelMin?: number
	travelMax?: number
	/** Overrides the kind default. Attach-only nodes set this false. */
	capture?: boolean
	flags?: number
}

/**
 * A flat skeleton. `parent[i] < i` always, which is enforced at construction and is the
 * single property that turns pose evaluation into one forward pass.
 */
export class Skeleton {
	readonly boneCount: number
	readonly names: readonly string[]
	readonly parent: Int16Array
	readonly kind: Uint8Array
	readonly flags: Uint8Array
	readonly axis: Uint8Array
	readonly travelAxis: Uint8Array

	/** Bind-pose local TRS, the initial value of every pose. */
	readonly bindT: Float32Array
	readonly bindR: Float32Array
	readonly bindS: Float32Array

	/** Bind-pose model-space matrices, column-major, 16 floats per bone. */
	readonly bindWorld: Float32Array
	/** Inverse of `bindWorld`. Uploaded once; the GPU needs it for every skinned draw. */
	readonly inverseBind: Float32Array

	/** Capture segment in bind model space. `head == tail` means a point bone. */
	readonly head: Float32Array
	readonly tail: Float32Array

	readonly radius: Float32Array
	readonly blend: Float32Array
	readonly bias: Float32Array
	readonly limitMin: Float32Array
	readonly limitMax: Float32Array
	readonly travelMin: Float32Array
	readonly travelMax: Float32Array

	/** Bone indices grouped by kind, ascending within a group. */
	readonly byKind: Int32Array
	/** Group starts, length BONE_KIND_COUNT + 1. */
	readonly kindOffset: Int32Array

	private readonly index: Map<string, number>

	constructor(descs: readonly BoneDesc[]) {
		const n = descs.length
		if (n === 0) throw new Error('rig: a skeleton needs at least one bone')
		if (n > MAX_BONES) throw new Error(`rig: ${n} bones exceeds MAX_BONES (${MAX_BONES})`)

		this.boneCount = n
		this.index = new Map()
		const names: string[] = new Array(n)
		this.names = names
		this.parent = new Int16Array(n)
		this.kind = new Uint8Array(n)
		this.flags = new Uint8Array(n)
		this.axis = new Uint8Array(n)
		this.travelAxis = new Uint8Array(n)
		this.bindT = new Float32Array(n * 3)
		this.bindR = new Float32Array(n * 4)
		this.bindS = new Float32Array(n * 3)
		this.bindWorld = new Float32Array(n * 16)
		this.inverseBind = new Float32Array(n * 16)
		this.head = new Float32Array(n * 3)
		this.tail = new Float32Array(n * 3)
		this.radius = new Float32Array(n)
		this.blend = new Float32Array(n)
		this.bias = new Float32Array(n)
		this.limitMin = new Float32Array(n)
		this.limitMax = new Float32Array(n)
		this.travelMin = new Float32Array(n)
		this.travelMax = new Float32Array(n)

		for (let i = 0; i < n; i++) {
			const d = descs[i]
			if (!d.name) throw new Error(`rig: bone ${i} has no name`)
			if (this.index.has(d.name))
				throw new Error(`rig: duplicate bone name '${d.name}' — a shadowed name animates the wrong part`)
			this.index.set(d.name, i)
			names[i] = d.name

			let p = -1
			if (typeof d.parent === 'string') {
				const found = this.index.get(d.parent)
				if (found === undefined) throw new Error(`rig: bone '${d.name}' parents to unknown '${d.parent}'`)
				p = found
			} else if (typeof d.parent === 'number') {
				p = d.parent
			}
			// Parent-before-child is the contract the single-pass evaluator rests on.
			if (p >= i) throw new Error(`rig: bone '${d.name}' parents to a later bone (${p} >= ${i})`)
			if (p < -1 || p >= n) throw new Error(`rig: bone '${d.name}' has out-of-range parent ${p}`)
			this.parent[i] = p

			const kind = d.kind === undefined ? DEFAULT_KIND : d.kind
			if (kind < 0 || kind >= BONE_KIND_COUNT)
				throw new Error(`rig: bone '${d.name}' has kind ${kind}, outside 0..${BONE_KIND_COUNT - 1}`)
			this.kind[i] = kind
			this.axis[i] = d.axis === undefined ? KIND_AXIS[kind] : d.axis
			this.travelAxis[i] = d.travelAxis === undefined ? KIND_TRAVEL_AXIS[kind] : d.travelAxis

			let flags = d.flags === undefined ? BoneFlags.none : d.flags
			const captures = d.capture === undefined ? KIND_NO_CAPTURE[kind] === 0 : d.capture
			if (!captures) flags |= BoneFlags.noCapture
			this.flags[i] = flags

			const t3 = i * 3
			const r4 = i * 4
			this.bindT[t3] = d.pos ? d.pos[0] : 0
			this.bindT[t3 + 1] = d.pos ? d.pos[1] : 0
			this.bindT[t3 + 2] = d.pos ? d.pos[2] : 0
			this.bindR[r4] = d.rot ? d.rot[0] : 0
			this.bindR[r4 + 1] = d.rot ? d.rot[1] : 0
			this.bindR[r4 + 2] = d.rot ? d.rot[2] : 0
			this.bindR[r4 + 3] = d.rot ? d.rot[3] : 1
			this.bindS[t3] = d.scale ? d.scale[0] : 1
			this.bindS[t3 + 1] = d.scale ? d.scale[1] : 1
			this.bindS[t3 + 2] = d.scale ? d.scale[2] : 1

			this.radius[i] = d.radius === undefined ? Infinity : d.radius
			this.blend[i] = d.blend === undefined ? 0 : d.blend
			this.bias[i] = d.bias === undefined ? 0 : d.bias
			this.limitMin[i] = d.limitMin === undefined ? -Infinity : d.limitMin
			this.limitMax[i] = d.limitMax === undefined ? Infinity : d.limitMax
			this.travelMin[i] = d.travelMin === undefined ? -Infinity : d.travelMin
			this.travelMax[i] = d.travelMax === undefined ? Infinity : d.travelMax
		}

		// Bind matrices: the same forward pass the runtime uses, so bind and pose can never
		// disagree about composition order.
		for (let i = 0; i < n; i++) {
			const o = i * 16
			const t3 = i * 3
			const r4 = i * 4
			composeInto(
				LOCAL, 0,
				this.bindT[t3], this.bindT[t3 + 1], this.bindT[t3 + 2],
				this.bindR[r4], this.bindR[r4 + 1], this.bindR[r4 + 2], this.bindR[r4 + 3],
				this.bindS[t3], this.bindS[t3 + 1], this.bindS[t3 + 2],
			)
			const p = this.parent[i]
			if (p < 0) for (let k = 0; k < 16; k++) this.bindWorld[o + k] = LOCAL[k]
			else mulInto(this.bindWorld, o, this.bindWorld, p * 16, LOCAL, 0)
		}

		for (let i = 0; i < n; i++) {
			const o = i * 16
			const t3 = i * 3
			this.head[t3] = this.bindWorld[o + 12]
			this.head[t3 + 1] = this.bindWorld[o + 13]
			this.head[t3 + 2] = this.bindWorld[o + 14]
			const d = descs[i]
			const lx = d.tail ? d.tail[0] : 0
			const ly = d.tail ? d.tail[1] : 0
			const lz = d.tail ? d.tail[2] : 0
			this.tail[t3] = this.bindWorld[o] * lx + this.bindWorld[o + 4] * ly + this.bindWorld[o + 8] * lz + this.bindWorld[o + 12]
			this.tail[t3 + 1] = this.bindWorld[o + 1] * lx + this.bindWorld[o + 5] * ly + this.bindWorld[o + 9] * lz + this.bindWorld[o + 13]
			this.tail[t3 + 2] = this.bindWorld[o + 2] * lx + this.bindWorld[o + 6] * ly + this.bindWorld[o + 10] * lz + this.bindWorld[o + 14]

			for (let k = 0; k < 16; k++) SCRATCH_A[k] = this.bindWorld[o + k]
			// A degenerate bind (zero scale) would otherwise write NaN into every vertex it
			// touches, and a NaN vertex takes the whole draw call with it.
			const inv = m4.invert(SCRATCH_B, SCRATCH_A) === null ? m4.identity(SCRATCH_B) : SCRATCH_B
			for (let k = 0; k < 16; k++) this.inverseBind[o + k] = inv[k]
		}

		this.kindOffset = new Int32Array(BONE_KIND_COUNT + 1)
		this.byKind = new Int32Array(n)
		for (let i = 0; i < n; i++) this.kindOffset[this.kind[i] + 1]++
		for (let k = 0; k < BONE_KIND_COUNT; k++) this.kindOffset[k + 1] += this.kindOffset[k]
		const cursor = new Int32Array(BONE_KIND_COUNT)
		for (let i = 0; i < n; i++) {
			const k = this.kind[i]
			this.byKind[this.kindOffset[k] + cursor[k]] = i
			cursor[k]++
		}
	}

	/** Bone index, or -1. Resolve names once at init — a per-frame `Map.get` on a built string allocates. */
	find(name: string): number {
		const i = this.index.get(name)
		return i === undefined ? -1 : i
	}

	has(name: string): boolean {
		return this.index.has(name)
	}

	/** Bone index, or throws. Use this where a missing bone means the rig is wrong, not optional. */
	require(name: string): number {
		const i = this.index.get(name)
		if (i === undefined) throw new Error(`rig: no bone named '${name}'`)
		return i
	}

	countOfKind(kind: number): number {
		return this.kindOffset[kind + 1] - this.kindOffset[kind]
	}

	/** The i-th bone of a kind in ascending bone order, or -1. */
	boneOfKind(kind: number, i: number): number {
		const base = this.kindOffset[kind]
		return i < 0 || i >= this.kindOffset[kind + 1] - base ? -1 : this.byKind[base + i]
	}

	createPose(): Pose {
		return new Pose(this)
	}

	/** Model-space matrix buffer sized for this skeleton. Allocate once, reuse every frame. */
	createMatrixBuffer(): Float32Array {
		return new Float32Array(this.boneCount * 16)
	}
}

/** Incremental skeleton assembly. `add` returns the bone index so a generator can bind geometry as it emits it. */
export class SkeletonBuilder {
	readonly descs: BoneDesc[] = []

	add(d: BoneDesc): number {
		this.descs.push(d)
		return this.descs.length - 1
	}

	/** All validation happens here, in the Skeleton constructor. */
	build(): Skeleton {
		return new Skeleton(this.descs)
	}
}

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

/**
 * Absolute local TRS per bone, not a delta from bind. Absolute is what a turret wants: the
 * sim gives an absolute facing, and `anim` writes it straight in without first reconstructing
 * a delta. `resetToBind()` restores rest.
 */
export class Pose {
	readonly skeleton: Skeleton
	readonly t: Float32Array
	readonly r: Float32Array
	readonly s: Float32Array

	constructor(skeleton: Skeleton) {
		this.skeleton = skeleton
		this.t = new Float32Array(skeleton.boneCount * 3)
		this.r = new Float32Array(skeleton.boneCount * 4)
		this.s = new Float32Array(skeleton.boneCount * 3)
		this.resetToBind()
	}

	resetToBind(): void {
		this.t.set(this.skeleton.bindT)
		this.r.set(this.skeleton.bindR)
		this.s.set(this.skeleton.bindS)
	}

	copyFrom(src: Pose): void {
		this.t.set(src.t)
		this.r.set(src.r)
		this.s.set(src.s)
	}
}

/**
 * Blend two poses. Rotations take the shortest arc, which §3 makes mandatory — a gait blend
 * that spins a thigh the long way is the same class of bug as a unit rotating 1023→0 backwards.
 */
export function poseBlend(out: Pose, a: Pose, b: Pose, k: number): void {
	const n = out.skeleton.boneCount
	for (let i = 0; i < n; i++) {
		const t3 = i * 3
		out.t[t3] = a.t[t3] + (b.t[t3] - a.t[t3]) * k
		out.t[t3 + 1] = a.t[t3 + 1] + (b.t[t3 + 1] - a.t[t3 + 1]) * k
		out.t[t3 + 2] = a.t[t3 + 2] + (b.t[t3 + 2] - a.t[t3 + 2]) * k
		out.s[t3] = a.s[t3] + (b.s[t3] - a.s[t3]) * k
		out.s[t3 + 1] = a.s[t3 + 1] + (b.s[t3 + 1] - a.s[t3 + 1]) * k
		out.s[t3 + 2] = a.s[t3 + 2] + (b.s[t3 + 2] - a.s[t3 + 2]) * k
		slerpFlat(out.r, i * 4, a.r, i * 4, b.r, i * 4, k)
	}
}

/**
 * Drive an articulated bone. The angle is a delta from bind about the bone's declared axis,
 * so 0 always means rest even on a rig whose barrel is modelled with a few degrees of droop.
 * Clamped to the bone's limits.
 *
 * Wrap a continuously accumulating spin (wheels, rotors) into [-pi, pi] before calling — a
 * monotonically growing angle loses float precision inside a long match.
 */
export function setBoneAngle(pose: Pose, bone: number, radians: number): void {
	const sk = pose.skeleton
	const h = clamp(radians, sk.limitMin[bone], sk.limitMax[bone]) * 0.5
	const s = Math.sin(h)
	const c = Math.cos(h)
	// An articulation axis is always a bone-local basis axis, so the delta quaternion costs
	// two trig calls and no vector work.
	const ax = sk.axis[bone]
	const dx = ax === AXIS_X ? s : 0
	const dy = ax === AXIS_Y ? s : 0
	const dz = ax === AXIS_Z ? s : 0
	const o = bone * 4
	const bx = sk.bindR[o], by = sk.bindR[o + 1], bz = sk.bindR[o + 2], bw = sk.bindR[o + 3]
	pose.r[o] = bx * c + bw * dx + by * dz - bz * dy
	pose.r[o + 1] = by * c + bw * dy + bz * dx - bx * dz
	pose.r[o + 2] = bz * c + bw * dz + bx * dy - by * dx
	pose.r[o + 3] = bw * c - bx * dx - by * dy - bz * dz
}

/**
 * Slide a bone along its travel axis — suspension, recoil, a door on rails. Displacement is
 * from bind and is clamped to the bone's travel limits.
 *
 * The direction comes from the BIND rotation, deliberately, not the current one. A wheel spins
 * about Y and travels along Z; deriving travel from the live rotation would swing its
 * suspension around with the spin. A gun that must recoil along an ELEVATED bore gets a
 * `mantlet` bone carrying the elevation and a `barrel` child carrying the travel: the
 * elevation is then an ancestor transform and the local travel follows it for free.
 */
export function setBoneOffset(pose: Pose, bone: number, distance: number): void {
	const sk = pose.skeleton
	const d = clamp(distance, sk.travelMin[bone], sk.travelMax[bone])
	const o = bone * 4
	quatColumn(sk.bindR, o, sk.travelAxis[bone], AXIS_DIR)
	const t3 = bone * 3
	pose.t[t3] = sk.bindT[t3] + AXIS_DIR[0] * d
	pose.t[t3 + 1] = sk.bindT[t3 + 1] + AXIS_DIR[1] * d
	pose.t[t3 + 2] = sk.bindT[t3 + 2] + AXIS_DIR[2] * d
}

/**
 * Push a bone back along its CURRENT forward axis, from bind: a turret's kick when its gun fires.
 *
 * Unlike `setBoneOffset` this follows the live rotation (the turret has traversed since bind)
 * and ignores travel limits, so it is only for short presentation kicks, never rigged travel.
 * Models whose barrel is its own bone recoil that bone with `setBoneOffset` instead.
 */
export function setBoneKick(pose: Pose, bone: number, distance: number): void {
	const sk = pose.skeleton
	quatColumn(pose.r, bone * 4, AXIS_FORWARD, AXIS_DIR)
	const t3 = bone * 3
	pose.t[t3] = sk.bindT[t3] - AXIS_DIR[0] * distance
	pose.t[t3 + 1] = sk.bindT[t3 + 1] - AXIS_DIR[1] * distance
	pose.t[t3 + 2] = sk.bindT[t3 + 2] - AXIS_DIR[2] * distance
}

// ---------------------------------------------------------------------------
// Pose evaluation
// ---------------------------------------------------------------------------

/**
 * Model-space matrix per bone. One forward pass, no recursion, no allocation: `parent[i] < i`
 * guarantees a parent is already resolved when its child is reached.
 */
export function computeWorldTransforms(pose: Pose, out: Float32Array): Float32Array {
	const sk = pose.skeleton
	const n = sk.boneCount
	if (out.length < n * 16) throw new Error(`rig: matrix buffer holds ${out.length} floats, need ${n * 16}`)
	const t = pose.t
	const r = pose.r
	const s = pose.s
	for (let i = 0; i < n; i++) {
		const o = i * 16
		const t3 = i * 3
		const r4 = i * 4
		composeInto(LOCAL, 0, t[t3], t[t3 + 1], t[t3 + 2], r[r4], r[r4 + 1], r[r4 + 2], r[r4 + 3], s[t3], s[t3 + 1], s[t3 + 2])
		const p = sk.parent[i]
		if (p < 0) for (let k = 0; k < 16; k++) out[o + k] = LOCAL[k]
		else mulInto(out, o, out, p * 16, LOCAL, 0)
	}
	return out
}

/**
 * `world * inverseBind` per bone — the matrix palette the vertex shader multiplies by.
 * `out` may alias `world`.
 */
export function computeSkinMatrices(skeleton: Skeleton, world: Float32Array, out: Float32Array): Float32Array {
	const n = skeleton.boneCount
	if (out.length < n * 16) throw new Error(`rig: skin buffer holds ${out.length} floats, need ${n * 16}`)
	for (let i = 0; i < n; i++) {
		const o = i * 16
		mulInto(out, o, world, o, skeleton.inverseBind, o)
	}
	return out
}

/** A point given in bone-local space, resolved through a computed matrix buffer. Muzzles, exhausts, cargo slots. */
export function boneWorldPoint(world: Float32Array, bone: number, lx: number, ly: number, lz: number, out: Vec3): Vec3 {
	const o = bone * 16
	out[0] = world[o] * lx + world[o + 4] * ly + world[o + 8] * lz + world[o + 12]
	out[1] = world[o + 1] * lx + world[o + 5] * ly + world[o + 9] * lz + world[o + 13]
	out[2] = world[o + 2] * lx + world[o + 6] * ly + world[o + 10] * lz + world[o + 14]
	return out
}

/** A unit basis direction of a bone. Normalised, so a scaled bind still yields a usable aim vector. */
export function boneWorldAxis(world: Float32Array, bone: number, axis: number, out: Vec3): Vec3 {
	const o = bone * 16 + axis * 4
	v3.set(out, world[o], world[o + 1], world[o + 2])
	return v3.normalize(out, out)
}

// ---------------------------------------------------------------------------
// Skinning
// ---------------------------------------------------------------------------

export interface Skin {
	readonly vertexCount: number
	/** 4 bone indices per vertex, descending by weight. */
	readonly joints: Uint8Array
	/** 4 weights per vertex, summing to 1. */
	readonly weights: Float32Array
}

export function createSkin(vertexCount: number): Skin {
	return {
		vertexCount,
		joints: new Uint8Array(vertexCount * 4),
		weights: new Float32Array(vertexCount * 4),
	}
}

export interface BindOptions {
	first: number
	/** -1 runs to the end of the skin. */
	count: number
	/** 1..4. Dropping to 2 for a distant LOD is cheap because influences are weight-sorted. */
	maxInfluences: number
}

export function bindOptions(): BindOptions {
	return { first: 0, count: -1, maxInfluences: 4 }
}

/**
 * Capture vertices by distance to the bone SEGMENT, not to the joint.
 *
 * This is the whole heuristic and the reason it works on machines: a turret ring's joint sits
 * near the hull centre, so a joint-distance metric hands it the barrel tip the moment the
 * barrel is longer than the turret is wide. Measured against segments, the barrel's own
 * head..tail line is metres closer to every point on the barrel and wins outright.
 *
 * Falls back to the nearest capturing bone when no envelope contains the vertex. A vertex with
 * no influence collapses to the model origin, which is the classic exploding-mesh failure.
 */
export function bindSkin(skeleton: Skeleton, skin: Skin, positions: Float32Array, opts?: BindOptions): void {
	const first = opts ? opts.first : 0
	const count = opts && opts.count >= 0 ? opts.count : skin.vertexCount - first
	const maxInf = opts ? clamp(opts.maxInfluences | 0, 1, 4) : 4
	const n = skeleton.boneCount
	const flags = skeleton.flags
	const head = skeleton.head
	const tail = skeleton.tail
	const radius = skeleton.radius
	const bias = skeleton.bias

	for (let v = first; v < first + count; v++) {
		const p3 = v * 3
		const px = positions[p3]
		const py = positions[p3 + 1]
		const pz = positions[p3 + 2]

		CAND_D[0] = CAND_D[1] = CAND_D[2] = CAND_D[3] = Infinity
		CAND_J[0] = CAND_J[1] = CAND_J[2] = CAND_J[3] = -1
		let fallbackJ = -1
		let fallbackD = Infinity

		for (let b = 0; b < n; b++) {
			if ((flags[b] & BoneFlags.noCapture) !== 0) continue
			const h3 = b * 3
			let d = distToSegment(px, py, pz, head[h3], head[h3 + 1], head[h3 + 2], tail[h3], tail[h3 + 1], tail[h3 + 2]) - bias[b]
			if (d < 0) d = 0
			// Strict < keeps the lowest bone index on a tie, so binding is deterministic.
			if (d < fallbackD) {
				fallbackD = d
				fallbackJ = b
			}
			if (d > radius[b] || d >= CAND_D[3]) continue
			let k = 3
			while (k > 0 && CAND_D[k - 1] > d) {
				CAND_D[k] = CAND_D[k - 1]
				CAND_J[k] = CAND_J[k - 1]
				k--
			}
			CAND_D[k] = d
			CAND_J[k] = b
		}

		const o4 = v * 4
		let primary = CAND_J[0]
		if (primary < 0) {
			// Outside every envelope. The nearest capturing bone takes it whole.
			primary = fallbackJ < 0 ? 0 : fallbackJ
			skin.joints[o4] = primary
			skin.joints[o4 + 1] = skin.joints[o4 + 2] = skin.joints[o4 + 3] = 0
			skin.weights[o4] = 1
			skin.weights[o4 + 1] = skin.weights[o4 + 2] = skin.weights[o4 + 3] = 0
			continue
		}

		const band = skeleton.blend[primary]
		let used = 1
		let sum = 1
		WEIGHT[0] = 1
		WEIGHT[1] = WEIGHT[2] = WEIGHT[3] = 0
		if (band > 0) {
			for (let k = 1; k < maxInf; k++) {
				const j = CAND_J[k]
				if (j < 0) break
				const excess = CAND_D[k] - CAND_D[0]
				if (excess >= band) break
				// smoothstep, not a linear ramp: a C1 falloff leaves no visible crease line
				// where one bone's influence hands over to the next.
				const w = smoothstep(0, 1, 1 - excess / band)
				if (w <= 0) break
				WEIGHT[k] = w
				sum += w
				used++
			}
		}

		const inv = 1 / sum
		for (let k = 0; k < 4; k++) {
			// The candidates are already distance-sorted and the kernel is monotonic in
			// distance, so the weights come out descending with no extra sort.
			skin.joints[o4 + k] = k < used ? CAND_J[k] : 0
			skin.weights[o4 + k] = k < used ? WEIGHT[k] * inv : 0
		}
	}
}

/**
 * Bind a contiguous vertex range rigidly to one bone. Preferred wherever the generator already
 * knows the owner — it is exact, it is free, and hard-surface parts should never blend anyway.
 */
export function bindSkinRigid(skin: Skin, first: number, count: number, bone: number): void {
	for (let v = first; v < first + count; v++) {
		const o = v * 4
		skin.joints[o] = bone
		skin.joints[o + 1] = skin.joints[o + 2] = skin.joints[o + 3] = 0
		skin.weights[o] = 1
		skin.weights[o + 1] = skin.weights[o + 2] = skin.weights[o + 3] = 0
	}
}

/**
 * Quantise to the unorm8 pair the vertex buffer actually carries. The residue goes onto the
 * largest weight so each vertex's four bytes sum to exactly 255 — weights that sum to less
 * than 1 pull the surface toward the model origin, which reads as an unexplained shrink.
 */
export function packSkinWeights(skin: Skin, outJoints: Uint8Array, outWeights: Uint8Array): void {
	for (let v = 0; v < skin.vertexCount; v++) {
		const o = v * 4
		let sum = 0
		let bestK = 0
		let bestW = -1
		for (let k = 0; k < 4; k++) {
			const q = Math.round(skin.weights[o + k] * 255)
			outWeights[o + k] = q
			outJoints[o + k] = skin.joints[o + k]
			sum += q
			if (skin.weights[o + k] > bestW) {
				bestW = skin.weights[o + k]
				bestK = k
			}
		}
		outWeights[o + bestK] = clamp(outWeights[o + bestK] + (255 - sum), 0, 255)
	}
}

// ---------------------------------------------------------------------------
// UV projection
// ---------------------------------------------------------------------------

/**
 * One projection setup, reused across calls. `scale` is the density knob and it is expressed
 * in UV units per METRE, never normalised to the mesh bounds: normalising is precisely what
 * makes a small hatch cover carry the same number of texels as a whole hull side, and a
 * detail layer that has to cover both cannot resolve at 0.5 m. Hold `scale` equal across every
 * zone of a material and density is constant by construction.
 */
export interface UvZone {
	first: number
	/** -1 runs to the end of the mesh. */
	count: number
	/** Material zone written per vertex. */
	zone: number
	scale: number
	offsetU: number
	offsetV: number
	/** UV-space rotation, radians. Breaks visible repetition between neighbouring panels. */
	rotation: number
}

export function uvZone(): UvZone {
	return { first: 0, count: -1, zone: 0, scale: 0.5, offsetU: 0, offsetV: 0, rotation: 0 }
}

/**
 * A `Mesh` keeps every attribute buffer allocated and never null, so the guard that matters is
 * not "is the buffer there" but "does the zone's range lie inside the LIVE vertices".
 *
 * Two ways a caller gets that wrong. `positions.length / 3` is the capacity the mesh last grew
 * to — growth is by doubling, so it is up to 2x `vertexCount` — and an explicit `z.count` is
 * simply whatever the caller believed. Either overshoot reads uninitialised vertices, which in
 * `cylindricalProjectBuffers` drags the auto-radius toward zero and therefore changes the tile
 * count for the whole zone. A TypedArray swallows both the stale reads and the out-of-range
 * writes, so the failure surfaces as a smeared projection frames later, never as an error.
 */
function checkZoneRange(z: UvZone, vertexCount: number): void {
	const count = z.count >= 0 ? z.count : vertexCount - z.first
	if (z.first < 0 || count < 0 || z.first + count > vertexCount)
		throw new Error(`rig: uv zone [${z.first}, ${z.first + count}) is outside the mesh's ${vertexCount} vertices`)
}

/**
 * Axis-dominant box projection. On all four side faces V is world up, so grime streaks, panel
 * lines and weld runs stay vertical and continuous across a corner instead of rotating 90°.
 *
 * The axis is chosen per vertex from the vertex normal, so a vertex shared between faces of
 * different dominant axes will smear. Hard-surface meshes already split vertices along their
 * panel edges, which makes this exact; anything organic wants triplanar in the shader instead.
 */
export function boxProject(mesh: Mesh, z: UvZone): void {
	// vertexCount, not positions.length / 3 — see checkZoneRange.
	const n = mesh.vertexCount
	checkZoneRange(z, n)
	boxProjectBuffers(mesh.positions, mesh.normals, mesh.uv0, mesh.materialZone, n, z)
}

export function boxProjectBuffers(
	positions: Float32Array,
	normals: Float32Array,
	uvs: Float32Array,
	zones: ZoneArray | null | undefined,
	vertexCount: number,
	z: UvZone,
): void {
	const first = z.first
	const count = z.count >= 0 ? z.count : vertexCount - first
	const s = z.scale
	const rc = Math.cos(z.rotation)
	const rs = Math.sin(z.rotation)
	for (let v = first; v < first + count; v++) {
		const i3 = v * 3
		const px = positions[i3]
		const py = positions[i3 + 1]
		const pz = positions[i3 + 2]
		const nx = normals[i3]
		const ny = normals[i3 + 1]
		const nz = normals[i3 + 2]
		const ax = nx < 0 ? -nx : nx
		const ay = ny < 0 ? -ny : ny
		const az = nz < 0 ? -nz : nz
		let u: number
		let w: number
		if (ax >= ay && ax >= az) {
			// +X: U=+Y V=+Z   -X: U=-Y V=+Z   (U x V = N, so tangent handedness stays consistent)
			u = nx >= 0 ? py : -py
			w = pz
		} else if (ay >= az) {
			// +Y: U=-X V=+Z   -Y: U=+X V=+Z
			u = ny >= 0 ? -px : px
			w = pz
		} else {
			// +Z: U=+X V=+Y   -Z: U=+X V=-Y
			u = px
			w = nz >= 0 ? py : -py
		}
		u *= s
		w *= s
		const i2 = v * 2
		uvs[i2] = u * rc - w * rs + z.offsetU
		uvs[i2 + 1] = u * rs + w * rc + z.offsetV
	}
	if (zones) for (let v = first; v < first + count; v++) zones[v] = z.zone
}

/**
 * Flat projection onto the plane spanned by two axes through an origin. The axes are
 * normalised here, because density is only meaningful if the basis is unit length.
 */
export function planarProject(mesh: Mesh, z: UvZone, origin: Vec3, axisU: Vec3, axisV: Vec3): void {
	const n = mesh.vertexCount
	checkZoneRange(z, n)
	planarProjectBuffers(mesh.positions, mesh.uv0, mesh.materialZone, n, z, origin, axisU, axisV)
}

export function planarProjectBuffers(
	positions: Float32Array,
	uvs: Float32Array,
	zones: ZoneArray | null | undefined,
	vertexCount: number,
	z: UvZone,
	origin: Vec3,
	axisU: Vec3,
	axisV: Vec3,
): void {
	const first = z.first
	const count = z.count >= 0 ? z.count : vertexCount - first
	v3.normalize(BASIS_U, axisU)
	v3.normalize(BASIS_V, axisV)
	const ux = BASIS_U[0], uy = BASIS_U[1], uz = BASIS_U[2]
	const vx = BASIS_V[0], vy = BASIS_V[1], vz = BASIS_V[2]
	const ox = origin[0], oy = origin[1], oz = origin[2]
	const s = z.scale
	const rc = Math.cos(z.rotation)
	const rs = Math.sin(z.rotation)
	for (let v = first; v < first + count; v++) {
		const i3 = v * 3
		const dx = positions[i3] - ox
		const dy = positions[i3 + 1] - oy
		const dz = positions[i3 + 2] - oz
		const u = (dx * ux + dy * uy + dz * uz) * s
		const w = (dx * vx + dy * vy + dz * vz) * s
		const i2 = v * 2
		uvs[i2] = u * rc - w * rs + z.offsetU
		uvs[i2 + 1] = u * rs + w * rc + z.offsetV
	}
	if (zones) for (let v = first; v < first + count; v++) zones[v] = z.zone
}

/**
 * Cylindrical projection for barrels, stacks, silos, pipes and drums.
 *
 * U is ARC LENGTH, not normalised angle: a normalised angle gives a fat silo and a thin pipe
 * the same U range and therefore wildly different densities. The arc-length span is then
 * rounded to a whole number of tiles so the wrap seam lands on a tile boundary and disappears;
 * the density error that rounding introduces is at most half a tile across the circumference,
 * which is invisible on anything larger than a hatch cover and is the cheaper of the two evils.
 *
 * `refDir` fixes U = 0, which puts the wrap seam on the opposite side, at -refDir. It is a
 * parameter rather than something derived internally because the seam is where the mesh builder
 * must have duplicated its ring vertices, and a seam whose position the caller cannot predict is
 * a seam the caller cannot split.
 *
 * Returns the U period in UV units. Feed it and the same zone to `repairWrapSeam` — duplicating
 * the ring vertices is necessary but NOT sufficient, and the reason is in that function's note.
 */
export function cylindricalProject(mesh: Mesh, z: UvZone, origin: Vec3, axis: Vec3, refDir: Vec3, radiusHint: number): number {
	const n = mesh.vertexCount
	checkZoneRange(z, n)
	return cylindricalProjectBuffers(mesh.positions, mesh.uv0, mesh.materialZone, n, z, origin, axis, refDir, radiusHint)
}

export function cylindricalProjectBuffers(
	positions: Float32Array,
	uvs: Float32Array,
	zones: ZoneArray | null | undefined,
	vertexCount: number,
	z: UvZone,
	origin: Vec3,
	axis: Vec3,
	refDir: Vec3,
	radiusHint: number,
): number {
	const first = z.first
	const count = z.count >= 0 ? z.count : vertexCount - first
	if (count <= 0) return 0
	v3.normalize(BASIS_W, axis)
	// Gram-Schmidt refDir against the axis. A refDir parallel to the axis carries no angular
	// information, so fall back to an arbitrary-but-deterministic perpendicular.
	const dotRef = refDir[0] * BASIS_W[0] + refDir[1] * BASIS_W[1] + refDir[2] * BASIS_W[2]
	v3.set(BASIS_U, refDir[0] - BASIS_W[0] * dotRef, refDir[1] - BASIS_W[1] * dotRef, refDir[2] - BASIS_W[2] * dotRef)
	if (v3.lenSq(BASIS_U) < 1e-12) perpendicularBasis(BASIS_W, BASIS_U, BASIS_V)
	else {
		v3.normalize(BASIS_U, BASIS_U)
		v3.cross(BASIS_V, BASIS_W, BASIS_U)
	}
	const wx = BASIS_W[0], wy = BASIS_W[1], wz = BASIS_W[2]
	const ux = BASIS_U[0], uy = BASIS_U[1], uz = BASIS_U[2]
	const vx = BASIS_V[0], vy = BASIS_V[1], vz = BASIS_V[2]
	const ox = origin[0], oy = origin[1], oz = origin[2]

	let radius = radiusHint
	if (!(radius > 0)) {
		let acc = 0
		for (let v = first; v < first + count; v++) {
			const i3 = v * 3
			const dx = positions[i3] - ox
			const dy = positions[i3 + 1] - oy
			const dz = positions[i3 + 2] - oz
			acc += Math.hypot(dx * ux + dy * uy + dz * uz, dx * vx + dy * vy + dz * vz)
		}
		radius = acc / count
	}
	const s = z.scale
	const tiles = Math.max(1, Math.round(2 * Math.PI * radius * s))
	const uPerRadian = tiles / (2 * Math.PI)
	const rc = Math.cos(z.rotation)
	const rs = Math.sin(z.rotation)

	for (let v = first; v < first + count; v++) {
		const i3 = v * 3
		const dx = positions[i3] - ox
		const dy = positions[i3 + 1] - oy
		const dz = positions[i3 + 2] - oz
		const a = dx * ux + dy * uy + dz * uz
		const b = dx * vx + dy * vy + dz * vz
		const h = dx * wx + dy * wy + dz * wz
		const u = Math.atan2(b, a) * uPerRadian
		const w = h * s
		const i2 = v * 2
		uvs[i2] = u * rc - w * rs + z.offsetU
		uvs[i2 + 1] = u * rs + w * rc + z.offsetV
	}
	if (zones) for (let v = first; v < first + count; v++) zones[v] = z.zone
	return tiles
}

/**
 * Repair the wrap seam of a projection that goes all the way round, given the topology.
 *
 * A vertex lying exactly on the seam is genuinely ambiguous — atan2 answers +pi or -pi
 * depending on the sign of a zero — and both copies of a duplicated seam vertex land on the
 * same side, so the wrap silently never happens and one triangle stretches across the entire
 * U range. That triangle is 4x the texel density of its neighbours and is visible as a smeared
 * band. No amount of care inside the projector fixes it: which side a corner belongs to is a
 * property of the triangle, not of the vertex.
 *
 * So: any triangle spanning more than half the period is pulled back together by moving ONE of
 * its two corner groups a whole period. Pass the same `UvZone` the projection used and the
 * period it returned.
 *
 * Which group moves is the whole difficulty, and it is not "the high one". Both repairs yield
 * the same triangle one period apart, so the triangle alone cannot choose; the mesh must. The
 * duplicated seam column may land on either end of the U range depending on the sign of the
 * zero `atan2` sees at the seam — i.e. on an arbitrarily small rotation of the mesh — and the
 * correct move is `-period` off the high copy in one case and `+period` onto the low copy in
 * the other. Deciding by sign is a coin flip that relocates the smear instead of removing it.
 *
 * The mesh decides it structurally. A vertex is PINNED the moment any triangle this pass cannot
 * rewrite touches it — a non-spanning triangle, or one straddling the zone boundary — because
 * shifting such a vertex by a period tears that triangle open, which is the very failure being
 * repaired. Only a genuine seam duplicate escapes pinning: it exists precisely because every
 * triangle using it lies on one side of the seam and therefore spans. A shared ring column and
 * a cap-fan hub are both pinned by their own untouched neighbours, so neither can be teleported
 * a period away by a triangle that merely happened to classify it as "high".
 *
 * A spanning triangle is then repaired through whichever group is entirely unpinned, preferring
 * the high group so U stays inside the range the projector produced.
 *
 * Scoped to the zone's vertex range, and deliberately so — a triangle outside it belongs to a
 * projection with no wrap at all, and a flat box face legitimately spans its whole U range.
 * Repairing those would tear a perfectly good projection apart.
 *
 * A seam whose vertices were never duplicated leaves no unpinned group at all, and a vertex two
 * triangles want on opposite sides was never duplicated either. Both are defects in the mesh,
 * not something to paper over — both throw, naming the geometry that needs splitting. Silently
 * moving a pinned corner instead is how the smear used to survive the repair.
 *
 * Returns the number of vertices moved. Allocates two marker arrays; this is generation-time
 * work, never per frame.
 */
export function repairWrapSeam(
	uvs: Float32Array,
	indices: Uint32Array | Uint16Array,
	indexCount: number,
	z: UvZone,
	period: number,
): number {
	if (!(period > 0)) return 0
	const first = z.first
	const last = (z.count >= 0 ? first + z.count : uvs.length >> 1) - 1
	const dx = Math.cos(z.rotation)
	const dy = Math.sin(z.rotation)
	const half = period * 0.5
	const vertexCount = uvs.length >> 1

	// Pass 1 — pin every vertex held in place by a triangle this pass will not rewrite.
	const pinned = new Uint8Array(vertexCount)
	for (let i = 0; i + 2 < indexCount; i += 3) {
		const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2]
		if (i0 >= first && i0 <= last && i1 >= first && i1 <= last && i2 >= first && i2 <= last) {
			const s0 = uvs[i0 * 2] * dx + uvs[i0 * 2 + 1] * dy
			const s1 = uvs[i1 * 2] * dx + uvs[i1 * 2 + 1] * dy
			const s2 = uvs[i2 * 2] * dx + uvs[i2 * 2 + 1] * dy
			const lo = s0 < s1 ? (s0 < s2 ? s0 : s2) : s1 < s2 ? s1 : s2
			const hi = s0 > s1 ? (s0 > s2 ? s0 : s2) : s1 > s2 ? s1 : s2
			if (hi - lo > half) continue
		}
		pinned[i0] = 1
		pinned[i1] = 1
		pinned[i2] = 1
	}

	// Pass 2 — claim a per-vertex shift, in whole periods, from the spanning triangles.
	const claim = new Int8Array(vertexCount)
	for (let i = 0; i + 2 < indexCount; i += 3) {
		const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2]
		if (i0 < first || i0 > last || i1 < first || i1 > last || i2 < first || i2 > last) continue
		const s0 = uvs[i0 * 2] * dx + uvs[i0 * 2 + 1] * dy
		const s1 = uvs[i1 * 2] * dx + uvs[i1 * 2 + 1] * dy
		const s2 = uvs[i2 * 2] * dx + uvs[i2 * 2 + 1] * dy
		const lo = s0 < s1 ? (s0 < s2 ? s0 : s2) : s1 < s2 ? s1 : s2
		const hi = s0 > s1 ? (s0 > s2 ? s0 : s2) : s1 > s2 ? s1 : s2
		if (hi - lo <= half) continue
		// hi > lo, so neither group is ever empty.
		const mid = (lo + hi) * 0.5
		const h0 = s0 > mid, h1 = s1 > mid, h2 = s2 > mid
		const freeHigh = (h0 ? pinned[i0] === 0 : true) && (h1 ? pinned[i1] === 0 : true) && (h2 ? pinned[i2] === 0 : true)
		const freeLow = (h0 ? true : pinned[i0] === 0) && (h1 ? true : pinned[i1] === 0) && (h2 ? true : pinned[i2] === 0)
		if (!freeHigh && !freeLow)
			throw new Error(
				`rig: triangle (${i0}, ${i1}, ${i2}) spans the wrap seam but every corner is shared with ` +
				`non-wrapping geometry — duplicate the seam column in the mesh builder`,
			)
		const move = freeHigh ? CLAIM_DOWN : CLAIM_UP
		const c0 = h0 === freeHigh ? move : CLAIM_KEEP
		const c1 = h1 === freeHigh ? move : CLAIM_KEEP
		const c2 = h2 === freeHigh ? move : CLAIM_KEEP
		claim[i0] = claimShift(claim[i0], c0, i0)
		claim[i1] = claimShift(claim[i1], c1, i1)
		claim[i2] = claimShift(claim[i2], c2, i2)
	}

	let moved = 0
	for (let v = 0; v < vertexCount; v++) {
		const c = claim[v]
		if (c !== CLAIM_DOWN && c !== CLAIM_UP) continue
		const step = c === CLAIM_DOWN ? -period : period
		uvs[v * 2] += step * dx
		uvs[v * 2 + 1] += step * dy
		moved++
	}
	return moved
}

/** Claim states. 0 is unclaimed; the rest are what some spanning triangle needs of a vertex. */
const CLAIM_KEEP = 1
const CLAIM_DOWN = 2
const CLAIM_UP = 3

function claimShift(current: number, want: number, vertex: number): number {
	if (current !== 0 && current !== want)
		throw new Error(`rig: vertex ${vertex} sits on both sides of a wrap seam — split it in the mesh builder`)
	return want
}

/**
 * Blend weights for shader-side triplanar sampling — the seam-free option, for rock, terrain
 * and anything the box projection would smear. `sharpness` around 4 keeps the transition tight
 * enough that a 45° face does not read as three overlapping textures.
 */
export function triplanarWeights(nx: number, ny: number, nz: number, sharpness: number, out: Vec3): Vec3 {
	const wx = Math.pow(nx < 0 ? -nx : nx, sharpness)
	const wy = Math.pow(ny < 0 ? -ny : ny, sharpness)
	const wz = Math.pow(nz < 0 ? -nz : nz, sharpness)
	const sum = wx + wy + wz
	// A degenerate normal projects from above rather than producing NaN weights.
	if (!(sum > 1e-9)) return v3.set(out, 0, 0, 1)
	const inv = 1 / sum
	return v3.set(out, wx * inv, wy * inv, wz * inv)
}

/**
 * Measured texel density over a triangle list, in UV units per metre: [min, max, mean, max/min].
 *
 * Density consistency is the one property of a projection that prose cannot assert — this is
 * how a gate proves it. A ratio near 1 means the detail layer resolves the same everywhere; a
 * ratio of 4 means some panel is getting a quarter of the texels its neighbour gets, and that
 * panel is the one that will look soft in a screenshot.
 *
 * The two failure results are distinct sentinels, and neither is 0. A gate is written as an
 * upper bound — `out[3] <= limit` — so anything that folds a failure onto a small number turns
 * the gate off, and 0 is the best-looking value the ratio has. Both sentinels are therefore
 * chosen so that comparison is false:
 *
 *   - **all four NaN** — nothing was measurable: no triangles, or every triangle degenerate in
 *     world space. There is no density here to be uniform, and a gate must not read the absence
 *     of a measurement as a passing one.
 *   - **`out[3] === Infinity`** — at least one triangle has real surface area and zero UV area.
 *     Its density is genuinely 0, the ratio genuinely unbounded, and it is the worst outcome a
 *     projection has: a collapsed triangle samples a single texel across a whole panel. `out[0]`
 *     is 0 in this case, which is how a caller tells it from a merely uneven projection.
 *
 * Triangles degenerate in WORLD space are skipped rather than counted — they cover no surface,
 * so they have no density to be wrong about.
 */
export function measureTexelDensity(
	positions: Float32Array,
	uvs: Float32Array,
	indices: Uint32Array | Uint16Array,
	indexCount: number,
	out: Float32Array,
): Float32Array {
	let min = Infinity
	let max = 0
	let acc = 0
	let n = 0
	for (let i = 0; i + 2 < indexCount; i += 3) {
		const a = indices[i] * 3
		const b = indices[i + 1] * 3
		const c = indices[i + 2] * 3
		const e1x = positions[b] - positions[a]
		const e1y = positions[b + 1] - positions[a + 1]
		const e1z = positions[b + 2] - positions[a + 2]
		const e2x = positions[c] - positions[a]
		const e2y = positions[c + 1] - positions[a + 1]
		const e2z = positions[c + 2] - positions[a + 2]
		const cx = e1y * e2z - e1z * e2y
		const cy = e1z * e2x - e1x * e2z
		const cz = e1x * e2y - e1y * e2x
		const areaWorld = 0.5 * Math.hypot(cx, cy, cz)
		if (areaWorld < 1e-12) continue
		const ua = indices[i] * 2
		const ub = indices[i + 1] * 2
		const uc = indices[i + 2] * 2
		const d1u = uvs[ub] - uvs[ua]
		const d1v = uvs[ub + 1] - uvs[ua + 1]
		const d2u = uvs[uc] - uvs[ua]
		const d2v = uvs[uc + 1] - uvs[ua + 1]
		const areaUv = 0.5 * Math.abs(d1u * d2v - d1v * d2u)
		const density = Math.sqrt(areaUv / areaWorld)
		if (density < min) min = density
		if (density > max) max = density
		acc += density
		n++
	}
	if (n === 0) {
		out[0] = out[1] = out[2] = out[3] = NaN
		return out
	}
	out[0] = min
	out[1] = max
	out[2] = acc / n
	// A collapsed UV triangle over real surface area is an unbounded ratio, not a perfect one.
	out[3] = min > 0 ? max / min : Infinity
	return out
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// Module-scope scratch. Every consumer below is synchronous and single-threaded — generation
// runs one skeleton at a time inside a worker (§6) — so sharing these is safe and is what
// keeps pose evaluation allocation-free.
const LOCAL = new Float32Array(16)
const SCRATCH_A = mat4()
const SCRATCH_B = mat4()
const AXIS_DIR = new Float32Array(3)
const BASIS_U = new Float32Array(3)
const BASIS_V = new Float32Array(3)
const BASIS_W = new Float32Array(3)
const CAND_D = new Float64Array(4)
const CAND_J = new Int32Array(4)
const WEIGHT = new Float64Array(4)

/** translation * rotation * scale, written straight into a flat matrix array at `off`. */
function composeInto(
	o: Float32Array, off: number,
	tx: number, ty: number, tz: number,
	qx: number, qy: number, qz: number, qw: number,
	sx: number, sy: number, sz: number,
): void {
	const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz
	const xx = qx * x2, xy = qx * y2, xz = qx * z2
	const yy = qy * y2, yz = qy * z2, zz = qz * z2
	const wx = qw * x2, wy = qw * y2, wz = qw * z2
	o[off] = (1 - (yy + zz)) * sx
	o[off + 1] = (xy + wz) * sx
	o[off + 2] = (xz - wy) * sx
	o[off + 3] = 0
	o[off + 4] = (xy - wz) * sy
	o[off + 5] = (1 - (xx + zz)) * sy
	o[off + 6] = (yz + wx) * sy
	o[off + 7] = 0
	o[off + 8] = (xz + wy) * sz
	o[off + 9] = (yz - wx) * sz
	o[off + 10] = (1 - (xx + yy)) * sz
	o[off + 11] = 0
	o[off + 12] = tx
	o[off + 13] = ty
	o[off + 14] = tz
	o[off + 15] = 1
}

/** out = a * b, column-major, at arbitrary offsets. Both operands are read into locals first, so `out` may alias either. */
function mulInto(o: Float32Array, oo: number, a: Float32Array, ao: number, b: Float32Array, bo: number): void {
	const a00 = a[ao], a01 = a[ao + 1], a02 = a[ao + 2], a03 = a[ao + 3]
	const a10 = a[ao + 4], a11 = a[ao + 5], a12 = a[ao + 6], a13 = a[ao + 7]
	const a20 = a[ao + 8], a21 = a[ao + 9], a22 = a[ao + 10], a23 = a[ao + 11]
	const a30 = a[ao + 12], a31 = a[ao + 13], a32 = a[ao + 14], a33 = a[ao + 15]
	const b00 = b[bo], b01 = b[bo + 1], b02 = b[bo + 2], b03 = b[bo + 3]
	const b10 = b[bo + 4], b11 = b[bo + 5], b12 = b[bo + 6], b13 = b[bo + 7]
	const b20 = b[bo + 8], b21 = b[bo + 9], b22 = b[bo + 10], b23 = b[bo + 11]
	const b30 = b[bo + 12], b31 = b[bo + 13], b32 = b[bo + 14], b33 = b[bo + 15]
	o[oo] = b00 * a00 + b01 * a10 + b02 * a20 + b03 * a30
	o[oo + 1] = b00 * a01 + b01 * a11 + b02 * a21 + b03 * a31
	o[oo + 2] = b00 * a02 + b01 * a12 + b02 * a22 + b03 * a32
	o[oo + 3] = b00 * a03 + b01 * a13 + b02 * a23 + b03 * a33
	o[oo + 4] = b10 * a00 + b11 * a10 + b12 * a20 + b13 * a30
	o[oo + 5] = b10 * a01 + b11 * a11 + b12 * a21 + b13 * a31
	o[oo + 6] = b10 * a02 + b11 * a12 + b12 * a22 + b13 * a32
	o[oo + 7] = b10 * a03 + b11 * a13 + b12 * a23 + b13 * a33
	o[oo + 8] = b20 * a00 + b21 * a10 + b22 * a20 + b23 * a30
	o[oo + 9] = b20 * a01 + b21 * a11 + b22 * a21 + b23 * a31
	o[oo + 10] = b20 * a02 + b21 * a12 + b22 * a22 + b23 * a32
	o[oo + 11] = b20 * a03 + b21 * a13 + b22 * a23 + b23 * a33
	o[oo + 12] = b30 * a00 + b31 * a10 + b32 * a20 + b33 * a30
	o[oo + 13] = b30 * a01 + b31 * a11 + b32 * a21 + b33 * a31
	o[oo + 14] = b30 * a02 + b31 * a12 + b32 * a22 + b33 * a32
	o[oo + 15] = b30 * a03 + b31 * a13 + b32 * a23 + b33 * a33
}

/**
 * Shortest-arc slerp on flat offsets. Identical to `q4.slerp`, restated here because taking a
 * `.subarray()` per bone per frame to reach that function would allocate — rule 6.
 */
function slerpFlat(o: Float32Array, oo: number, a: Float32Array, ao: number, b: Float32Array, bo: number, t: number): void {
	let cos = a[ao] * b[bo] + a[ao + 1] * b[bo + 1] + a[ao + 2] * b[bo + 2] + a[ao + 3] * b[bo + 3]
	let sign = 1
	if (cos < 0) {
		cos = -cos
		sign = -1
	}
	let ka: number
	let kb: number
	if (1 - cos > 1e-6) {
		const omega = Math.acos(cos)
		const sin = Math.sin(omega)
		ka = Math.sin((1 - t) * omega) / sin
		kb = Math.sin(t * omega) / sin
	} else {
		ka = 1 - t
		kb = t
	}
	kb *= sign
	o[oo] = a[ao] * ka + b[bo] * kb
	o[oo + 1] = a[ao + 1] * ka + b[bo + 1] * kb
	o[oo + 2] = a[ao + 2] * ka + b[bo + 2] * kb
	o[oo + 3] = a[ao + 3] * ka + b[bo + 3] * kb
}

/** Basis column `axis` of the rotation a quaternion represents — i.e. that unit axis, rotated. */
function quatColumn(q: Float32Array, off: number, axis: number, out: Float32Array): void {
	const x = q[off], y = q[off + 1], z = q[off + 2], w = q[off + 3]
	const x2 = x + x, y2 = y + y, z2 = z + z
	const xx = x * x2, xy = x * y2, xz = x * z2
	const yy = y * y2, yz = y * z2, zz = z * z2
	const wx = w * x2, wy = w * y2, wz = w * z2
	if (axis === AXIS_X) {
		out[0] = 1 - (yy + zz)
		out[1] = xy + wz
		out[2] = xz - wy
	} else if (axis === AXIS_Y) {
		out[0] = xy - wz
		out[1] = 1 - (xx + zz)
		out[2] = yz + wx
	} else {
		out[0] = xz + wy
		out[1] = yz - wx
		out[2] = 1 - (xx + yy)
	}
}

/** Any orthonormal pair perpendicular to a unit vector. Deterministic: the seed axis is chosen by magnitude, never randomly. */
function perpendicularBasis(w: Float32Array, outU: Float32Array, outV: Float32Array): void {
	const ax = w[0] < 0 ? -w[0] : w[0]
	const ay = w[1] < 0 ? -w[1] : w[1]
	const az = w[2] < 0 ? -w[2] : w[2]
	let sx = 0
	let sy = 0
	let sz = 0
	if (ax <= ay && ax <= az) sx = 1
	else if (ay <= az) sy = 1
	else sz = 1
	outU[0] = sy * w[2] - sz * w[1]
	outU[1] = sz * w[0] - sx * w[2]
	outU[2] = sx * w[1] - sy * w[0]
	v3.normalize(outU, outU)
	outV[0] = w[1] * outU[2] - w[2] * outU[1]
	outV[1] = w[2] * outU[0] - w[0] * outU[2]
	outV[2] = w[0] * outU[1] - w[1] * outU[0]
}

/** Distance from a point to the segment a..b. Degenerates to point distance when a == b. */
function distToSegment(
	px: number, py: number, pz: number,
	ax: number, ay: number, az: number,
	bx: number, by: number, bz: number,
): number {
	const dx = bx - ax
	const dy = by - ay
	const dz = bz - az
	const dd = dx * dx + dy * dy + dz * dz
	let t = 0
	if (dd > 1e-12) t = clamp(((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / dd, 0, 1)
	return Math.hypot(px - (ax + dx * t), py - (ay + dy * t), pz - (az + dz * t))
}
