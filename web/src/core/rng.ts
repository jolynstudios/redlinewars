// STEELSEED — core/rng
// SplitMix64. The only source of randomness in the entire presentation layer.
//
// Hard rule 5: the stdlib RNG is banned everywhere. rulecheck-allow (this file names
// the banned call in prose only). Asset generation is a pure function of the asset
// seed, so two runs of the same seed must produce byte-identical geometry and
// textures — that property is what makes baseline.mjs a usable gate.
//
// Never read or perturb the simulation's World.SharedRandom. That belongs to the
// lockstep; touching it desyncs multiplayer minutes later in someone else's match.

const GOLDEN = 0x9e3779b97f4a7c15n
const MIX1 = 0xbf58476d1ce4e5b9n
const MIX2 = 0x94d049bb133111ebn
const M64 = 0xffffffffffffffffn

/**
 * SplitMix64 — small, fast, and trivially forkable. State is a single u64, which is
 * what lets a generator hand an independent stream to a sub-generator without any
 * shared mutable state between workers.
 */
export class Rng {
	private s: bigint

	constructor(seed: bigint | number) {
		this.s = (typeof seed === 'bigint' ? seed : BigInt(Math.trunc(seed))) & M64
	}

	/** Raw next u64. */
	nextU64(): bigint {
		this.s = (this.s + GOLDEN) & M64
		let z = this.s
		z = ((z ^ (z >> 30n)) * MIX1) & M64
		z = ((z ^ (z >> 27n)) * MIX2) & M64
		return (z ^ (z >> 31n)) & M64
	}

	/** Uniform u32. */
	nextU32(): number {
		return Number(this.nextU64() >> 32n) >>> 0
	}

	/**
	 * Uniform float in [0,1). Built from the top 53 bits so the mantissa is filled
	 * exactly once — dividing a u32 by 2^32 would quantise visibly in large point sets.
	 */
	next(): number {
		return Number(this.nextU64() >> 11n) / 9007199254740992
	}

	/** Uniform float in [lo,hi). */
	range(lo: number, hi: number): number {
		return lo + (hi - lo) * this.next()
	}

	/** Uniform integer in [lo,hi). Rejection-free; bias is below float precision here. */
	int(lo: number, hi: number): number {
		return lo + Math.floor(this.next() * (hi - lo))
	}

	/** Symmetric signed float in [-m,m). */
	signed(m = 1): number {
		return (this.next() * 2 - 1) * m
	}

	bool(p = 0.5): boolean {
		return this.next() < p
	}

	pick<T>(arr: readonly T[]): T {
		return arr[Math.floor(this.next() * arr.length)]
	}

	/** In-place deterministic Fisher-Yates. */
	shuffle<T>(arr: T[]): T[] {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = Math.floor(this.next() * (i + 1))
			const t = arr[i]
			arr[i] = arr[j]
			arr[j] = t
		}
		return arr
	}

	/**
	 * Gaussian via Box-Muller. Returns one sample; the paired value is discarded
	 * deliberately so that call-count stays 1:1 with sample-count and a generator's
	 * stream position never depends on whether a cached second value existed.
	 */
	gaussian(mean = 0, sd = 1): number {
		let u = this.next()
		if (u < 1e-12) u = 1e-12
		return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next())
	}

	/**
	 * An independent stream. Use this rather than sharing an Rng across generators:
	 * a fork's output does not depend on how many times the parent was called after
	 * the fork, so adding a call to one generator cannot perturb another's output.
	 */
	fork(): Rng {
		return new Rng(this.nextU64())
	}

	/** A named fork — stable across code reordering, which a positional fork() is not. */
	forkNamed(name: string): Rng {
		return new Rng(mix64(this.s ^ hashString(name)))
	}

	get state(): bigint {
		return this.s
	}
	set state(v: bigint) {
		this.s = v & M64
	}
}

/** FNV-1a over UTF-16 code units, widened to u64. Stable across runs and platforms. */
export function hashString(s: string): bigint {
	let h = 0xcbf29ce484222325n
	for (let i = 0; i < s.length; i++) {
		h ^= BigInt(s.charCodeAt(i))
		h = (h * 0x100000001b3n) & M64
	}
	return h
}

function mix64(x: bigint): bigint {
	let z = (x + GOLDEN) & M64
	z = ((z ^ (z >> 30n)) * MIX1) & M64
	z = ((z ^ (z >> 27n)) * MIX2) & M64
	return (z ^ (z >> 31n)) & M64
}

/** Deterministic root RNG for a given asset seed. */
export function rootRng(assetSeed: string | number | bigint): Rng {
	if (typeof assetSeed === 'string') return new Rng(hashString(assetSeed))
	return new Rng(assetSeed)
}
