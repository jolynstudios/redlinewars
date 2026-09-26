// STEELSEED — core/math
// The math library. Hard rule 4: zero runtime dependencies — no gl-matrix, no three.
//
// Every operation takes an explicit `out` and returns it. There is no operator-style
// API that allocates a result, because hard rule 6 forbids allocating per frame and a
// `new Vec3()` inside update() is a bug. Use the scratch pool below for temporaries.

export type Vec2 = Float32Array
export type Vec3 = Float32Array
export type Vec4 = Float32Array
export type Quat = Float32Array
/** Column-major 4x4, matching WGSL and GLSL upload layout. */
export type Mat4 = Float32Array

export const vec2 = (x = 0, y = 0): Vec2 => Float32Array.of(x, y)
export const vec3 = (x = 0, y = 0, z = 0): Vec3 => Float32Array.of(x, y, z)
export const vec4 = (x = 0, y = 0, z = 0, w = 1): Vec4 => Float32Array.of(x, y, z, w)
export const quat = (): Quat => Float32Array.of(0, 0, 0, 1)
export const mat4 = (): Mat4 => {
	const m = new Float32Array(16)
	m[0] = m[5] = m[10] = m[15] = 1
	return m
}

export const DEG2RAD = Math.PI / 180
export const RAD2DEG = 180 / Math.PI

export function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v
}
export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t
}
export function smoothstep(e0: number, e1: number, x: number): number {
	const t = clamp((x - e0) / (e1 - e0), 0, 1)
	return t * t * (3 - 2 * t)
}
/**
 * Frame-rate independent exponential approach. `rate` is the fraction of the remaining
 * distance covered per second. A raw `lerp(a, b, k)` in update() is framerate-dependent
 * and makes turret lag feel different on a 144 Hz display than on 60 Hz.
 */
export function damp(a: number, b: number, rate: number, dt: number): number {
	return b + (a - b) * Math.exp(-rate * dt)
}

// ---------------------------------------------------------------------------
// Vec3
// ---------------------------------------------------------------------------

export const v3 = {
	set(o: Vec3, x: number, y: number, z: number): Vec3 {
		o[0] = x
		o[1] = y
		o[2] = z
		return o
	},
	copy(o: Vec3, a: Vec3): Vec3 {
		o[0] = a[0]
		o[1] = a[1]
		o[2] = a[2]
		return o
	},
	add(o: Vec3, a: Vec3, b: Vec3): Vec3 {
		o[0] = a[0] + b[0]
		o[1] = a[1] + b[1]
		o[2] = a[2] + b[2]
		return o
	},
	sub(o: Vec3, a: Vec3, b: Vec3): Vec3 {
		o[0] = a[0] - b[0]
		o[1] = a[1] - b[1]
		o[2] = a[2] - b[2]
		return o
	},
	scale(o: Vec3, a: Vec3, s: number): Vec3 {
		o[0] = a[0] * s
		o[1] = a[1] * s
		o[2] = a[2] * s
		return o
	},
	mul(o: Vec3, a: Vec3, b: Vec3): Vec3 {
		o[0] = a[0] * b[0]
		o[1] = a[1] * b[1]
		o[2] = a[2] * b[2]
		return o
	},
	addScaled(o: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
		o[0] = a[0] + b[0] * s
		o[1] = a[1] + b[1] * s
		o[2] = a[2] + b[2] * s
		return o
	},
	dot(a: Vec3, b: Vec3): number {
		return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
	},
	cross(o: Vec3, a: Vec3, b: Vec3): Vec3 {
		const ax = a[0],
			ay = a[1],
			az = a[2]
		const bx = b[0],
			by = b[1],
			bz = b[2]
		o[0] = ay * bz - az * by
		o[1] = az * bx - ax * bz
		o[2] = ax * by - ay * bx
		return o
	},
	len(a: Vec3): number {
		return Math.hypot(a[0], a[1], a[2])
	},
	lenSq(a: Vec3): number {
		return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]
	},
	dist(a: Vec3, b: Vec3): number {
		return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
	},
	normalize(o: Vec3, a: Vec3): Vec3 {
		const l = Math.hypot(a[0], a[1], a[2])
		if (l < 1e-9) return v3.set(o, 0, 0, 0)
		const inv = 1 / l
		o[0] = a[0] * inv
		o[1] = a[1] * inv
		o[2] = a[2] * inv
		return o
	},
	lerp(o: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
		o[0] = a[0] + (b[0] - a[0]) * t
		o[1] = a[1] + (b[1] - a[1]) * t
		o[2] = a[2] + (b[2] - a[2]) * t
		return o
	},
	transformMat4(o: Vec3, a: Vec3, m: Mat4): Vec3 {
		const x = a[0],
			y = a[1],
			z = a[2]
		const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1
		o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w
		o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w
		o[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w
		return o
	},
	/** Direction transform — ignores translation. For normals use a normal matrix. */
	transformDir(o: Vec3, a: Vec3, m: Mat4): Vec3 {
		const x = a[0],
			y = a[1],
			z = a[2]
		o[0] = m[0] * x + m[4] * y + m[8] * z
		o[1] = m[1] * x + m[5] * y + m[9] * z
		o[2] = m[2] * x + m[6] * y + m[10] * z
		return o
	},
}

// ---------------------------------------------------------------------------
// Mat4 — column-major
// ---------------------------------------------------------------------------

export const m4 = {
	identity(o: Mat4): Mat4 {
		o.fill(0)
		o[0] = o[5] = o[10] = o[15] = 1
		return o
	},
	copy(o: Mat4, a: Mat4): Mat4 {
		o.set(a)
		return o
	},
	multiply(o: Mat4, a: Mat4, b: Mat4): Mat4 {
		// Reads a and b fully into locals first, so `multiply(m, m, x)` is safe.
		const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3]
		const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
		const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11]
		const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]
		for (let i = 0; i < 4; i++) {
			const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3]
			o[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
			o[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
			o[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
			o[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
		}
		return o
	},
	fromTranslation(o: Mat4, x: number, y: number, z: number): Mat4 {
		m4.identity(o)
		o[12] = x
		o[13] = y
		o[14] = z
		return o
	},
	fromScale(o: Mat4, x: number, y: number, z: number): Mat4 {
		o.fill(0)
		o[0] = x
		o[5] = y
		o[10] = z
		o[15] = 1
		return o
	},
	fromRotationZ(o: Mat4, rad: number): Mat4 {
		const c = Math.cos(rad),
			s = Math.sin(rad)
		m4.identity(o)
		o[0] = c
		o[1] = s
		o[4] = -c === 0 ? 0 : -s
		o[5] = c
		return o
	},
	/** Compose translation * rotation(quat) * scale without an intermediate matrix. */
	compose(o: Mat4, t: Vec3, q: Quat, s: Vec3): Mat4 {
		const x = q[0], y = q[1], z = q[2], w = q[3]
		const x2 = x + x, y2 = y + y, z2 = z + z
		const xx = x * x2, xy = x * y2, xz = x * z2
		const yy = y * y2, yz = y * z2, zz = z * z2
		const wx = w * x2, wy = w * y2, wz = w * z2
		const sx = s[0], sy = s[1], sz = s[2]
		o[0] = (1 - (yy + zz)) * sx
		o[1] = (xy + wz) * sx
		o[2] = (xz - wy) * sx
		o[3] = 0
		o[4] = (xy - wz) * sy
		o[5] = (1 - (xx + zz)) * sy
		o[6] = (yz + wx) * sy
		o[7] = 0
		o[8] = (xz + wy) * sz
		o[9] = (yz - wx) * sz
		o[10] = (1 - (xx + yy)) * sz
		o[11] = 0
		o[12] = t[0]
		o[13] = t[1]
		o[14] = t[2]
		o[15] = 1
		return o
	},
	/**
	 * Reverse-Z perspective with an infinite far plane. Reverse-Z because an RTS camera
	 * spans a huge depth range and standard [0,1] depth loses precision at distance —
	 * that shows up as z-fighting on far terrain, which §5.4 calls an outright failure.
	 * Depth range is [1,0]; configure the depth compare as GREATER and clear to 0.
	 */
	perspectiveReverseZ(o: Mat4, fovY: number, aspect: number, near: number): Mat4 {
		const f = 1 / Math.tan(fovY / 2)
		o.fill(0)
		o[0] = f / aspect
		o[5] = f
		o[11] = -1
		o[14] = near
		return o
	},
	orthographic(o: Mat4, l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
		o.fill(0)
		o[0] = 2 / (r - l)
		o[5] = 2 / (t - b)
		o[10] = 1 / (n - f)
		o[12] = (r + l) / (l - r)
		o[13] = (t + b) / (b - t)
		o[14] = n / (n - f)
		o[15] = 1
		return o
	},
	lookAt(o: Mat4, eye: Vec3, target: Vec3, up: Vec3): Mat4 {
		const s = scratch
		const z = v3.normalize(s.v3a, v3.sub(s.v3a, eye, target))
		// Degenerate when the view direction is parallel to up — nudge rather than
		// producing a NaN matrix that silently blanks the frame.
		if (v3.lenSq(z) < 1e-12) z[2] = 1
		const x = v3.normalize(s.v3b, v3.cross(s.v3b, up, z))
		if (v3.lenSq(x) < 1e-12) {
			v3.set(s.v3c, up[0] + 1e-4, up[1], up[2])
			v3.normalize(x, v3.cross(x, s.v3c, z))
		}
		const y = v3.cross(s.v3c, z, x)
		o[0] = x[0]; o[1] = y[0]; o[2] = z[0]; o[3] = 0
		o[4] = x[1]; o[5] = y[1]; o[6] = z[1]; o[7] = 0
		o[8] = x[2]; o[9] = y[2]; o[10] = z[2]; o[11] = 0
		o[12] = -v3.dot(x, eye)
		o[13] = -v3.dot(y, eye)
		o[14] = -v3.dot(z, eye)
		o[15] = 1
		return o
	},
	invert(o: Mat4, a: Mat4): Mat4 | null {
		const b00 = a[0] * a[5] - a[1] * a[4]
		const b01 = a[0] * a[6] - a[2] * a[4]
		const b02 = a[0] * a[7] - a[3] * a[4]
		const b03 = a[1] * a[6] - a[2] * a[5]
		const b04 = a[1] * a[7] - a[3] * a[5]
		const b05 = a[2] * a[7] - a[3] * a[6]
		const b06 = a[8] * a[13] - a[9] * a[12]
		const b07 = a[8] * a[14] - a[10] * a[12]
		const b08 = a[8] * a[15] - a[11] * a[12]
		const b09 = a[9] * a[14] - a[10] * a[13]
		const b10 = a[9] * a[15] - a[11] * a[13]
		const b11 = a[10] * a[15] - a[11] * a[14]
		let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
		if (!det) return null
		det = 1 / det
		const r = [
			a[5] * b11 - a[6] * b10 + a[7] * b09, a[2] * b10 - a[1] * b11 - a[3] * b09,
			a[13] * b05 - a[14] * b04 + a[15] * b03, a[10] * b04 - a[9] * b05 - a[11] * b03,
			a[6] * b08 - a[4] * b11 - a[7] * b07, a[0] * b11 - a[2] * b08 + a[3] * b07,
			a[14] * b02 - a[12] * b05 - a[15] * b01, a[8] * b05 - a[10] * b02 + a[11] * b01,
			a[4] * b10 - a[5] * b08 + a[7] * b06, a[1] * b08 - a[0] * b10 - a[3] * b06,
			a[12] * b04 - a[13] * b02 + a[15] * b00, a[9] * b02 - a[8] * b04 - a[11] * b00,
			a[5] * b07 - a[4] * b09 - a[6] * b06, a[0] * b09 - a[1] * b07 + a[2] * b06,
			a[13] * b01 - a[12] * b03 - a[14] * b00, a[8] * b03 - a[9] * b01 + a[10] * b00,
		]
		for (let i = 0; i < 16; i++) o[i] = r[i] * det
		return o
	},
}

// ---------------------------------------------------------------------------
// Quat
// ---------------------------------------------------------------------------

export const q4 = {
	identity(o: Quat): Quat {
		o[0] = o[1] = o[2] = 0
		o[3] = 1
		return o
	},
	fromAxisAngle(o: Quat, axis: Vec3, rad: number): Quat {
		const h = rad / 2
		const s = Math.sin(h)
		o[0] = axis[0] * s
		o[1] = axis[1] * s
		o[2] = axis[2] * s
		o[3] = Math.cos(h)
		return o
	},
	multiply(o: Quat, a: Quat, b: Quat): Quat {
		const ax = a[0], ay = a[1], az = a[2], aw = a[3]
		const bx = b[0], by = b[1], bz = b[2], bw = b[3]
		o[0] = ax * bw + aw * bx + ay * bz - az * by
		o[1] = ay * bw + aw * by + az * bx - ax * bz
		o[2] = az * bw + aw * bz + ax * by - ay * bx
		o[3] = aw * bw - ax * bx - ay * by - az * bz
		return o
	},
	/** Shortest-arc spherical interpolation; falls back to nlerp when nearly parallel. */
	slerp(o: Quat, a: Quat, b: Quat, t: number): Quat {
		let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
		let s = 1
		if (cos < 0) {
			cos = -cos
			s = -1
		}
		let ka: number, kb: number
		if (1 - cos > 1e-6) {
			const omega = Math.acos(cos)
			const sin = Math.sin(omega)
			ka = Math.sin((1 - t) * omega) / sin
			kb = Math.sin(t * omega) / sin
		} else {
			ka = 1 - t
			kb = t
		}
		kb *= s
		o[0] = a[0] * ka + b[0] * kb
		o[1] = a[1] * ka + b[1] * kb
		o[2] = a[2] * ka + b[2] * kb
		o[3] = a[3] * ka + b[3] * kb
		return o
	},
}

/**
 * Shared scratch. Use inside a single synchronous block only — never hold a reference
 * across an await or a call into another system, which would alias someone else's use.
 */
export const scratch = {
	v3a: vec3(), v3b: vec3(), v3c: vec3(), v3d: vec3(),
	v4a: vec4(), v4b: vec4(),
	qa: quat(), qb: quat(),
	ma: mat4(), mb: mat4(), mc: mat4(),
}
