// soniclink/prng.js — xoshiro256** PRNG + SHA-256 key derivation

/**
 * xoshiro256** PRNG using BigInt for 64-bit arithmetic.
 * Not cryptographic — used for deterministic test data generation.
 */
export class Xoshiro256ss {
  /**
   * @param {Uint8Array} seed - 32 bytes → 4 × 64-bit state words
   */
  constructor(seed) {
    if (seed.length !== 32) throw new Error('Seed must be 32 bytes');
    const view = new DataView(seed.buffer, seed.byteOffset, 32);
    this.s = [
      view.getBigUint64(0, true),
      view.getBigUint64(8, true),
      view.getBigUint64(16, true),
      view.getBigUint64(24, true),
    ];
    // Ensure non-zero state
    if (this.s.every(v => v === 0n)) {
      this.s[0] = 1n;
    }
  }

  static MASK = (1n << 64n) - 1n;

  /**
   * Rotate left 64-bit.
   */
  static rotl(x, k) {
    return ((x << k) | (x >> (64n - k))) & Xoshiro256ss.MASK;
  }

  /**
   * Generate next 64-bit value.
   * @returns {bigint}
   */
  next() {
    const M = Xoshiro256ss.MASK;
    const result = (Xoshiro256ss.rotl((this.s[1] * 5n) & M, 7n) * 9n) & M;

    const t = (this.s[1] << 17n) & M;
    this.s[2] ^= this.s[0];
    this.s[3] ^= this.s[1];
    this.s[1] ^= this.s[2];
    this.s[0] ^= this.s[3];

    this.s[2] ^= t;
    this.s[3] = Xoshiro256ss.rotl(this.s[3], 45n);

    return result;
  }

  /**
   * Generate n bytes of pseudo-random data.
   * @param {number} n - Number of bytes to generate
   * @returns {Uint8Array}
   */
  nextBytes(n) {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const val = this.next();
      // Extract up to 8 bytes from each 64-bit value
      for (let i = 0; i < 8 && offset < n; i++) {
        out[offset++] = Number((val >> BigInt(i * 8)) & 0xFFn);
      }
    }
    return out;
  }
}

/**
 * Derive a deterministic test block from a seed and turn number.
 *
 * Process: SHA-256(seed || turn_le32) → 32-byte PRNG seed → xoshiro256** → 512 bytes
 *
 * @param {Uint8Array} seed - 64-byte random seed
 * @param {number} turn - Turn number (0, 1, 2, ...)
 * @returns {Promise<Uint8Array>} 512-byte test block
 */
export async function deriveTestBlock(seed, turn) {
  // Concatenate seed + turn number (4 bytes, little-endian)
  const input = new Uint8Array(seed.length + 4);
  input.set(seed);
  const view = new DataView(input.buffer);
  view.setUint32(seed.length, turn, true); // little-endian

  // SHA-256 hash → 32 bytes
  const hashBuffer = await crypto.subtle.digest('SHA-256', input);
  const prngSeed = new Uint8Array(hashBuffer);

  // Generate 512 bytes from xoshiro256**
  const rng = new Xoshiro256ss(prngSeed);
  return rng.nextBytes(512);
}

/**
 * Compute truncated SHA-256 hash (first 8 bytes) of data.
 * Used for hash chirps.
 *
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>} 8-byte hash
 */
export async function hashChirpDigest(data) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hashBuffer).slice(0, 8);
}

/**
 * Generate a cryptographically random seed.
 * @param {number} length - Seed length in bytes
 * @returns {Uint8Array}
 */
export function generateSeed(length = 64) {
  const seed = new Uint8Array(length);
  crypto.getRandomValues(seed);
  return seed;
}
