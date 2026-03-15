// soniclink/goertzel.js — Goertzel algorithm for efficient single-frequency detection

/**
 * GoertzelFilter detects the energy of a single frequency in a block of audio samples.
 * Much more efficient than FFT when you only need a few specific frequencies.
 *
 * Usage:
 *   const g = new GoertzelFilter(1000, 48000, 3840);
 *   for (const sample of block) g.processSample(sample);
 *   const energy = g.getMagnitude();  // resets automatically
 */
export class GoertzelFilter {
  /**
   * @param {number} targetFreq - Frequency to detect (Hz)
   * @param {number} sampleRate - Audio sample rate (Hz)
   * @param {number} blockSize  - Number of samples per detection block
   */
  constructor(targetFreq, sampleRate, blockSize) {
    this.blockSize = blockSize;
    // Normalised frequency bin index (can be non-integer)
    const k = (blockSize * targetFreq) / sampleRate;
    this.w = (2 * Math.PI * k) / blockSize;
    this.coeff = 2 * Math.cos(this.w);
    this.cosW = Math.cos(this.w);
    this.sinW = Math.sin(this.w);
    this.reset();
  }

  reset() {
    this.s1 = 0;  // s[n-1]
    this.s2 = 0;  // s[n-2]
    this.count = 0;
  }

  /**
   * Feed one audio sample into the filter.
   * @param {number} sample - Audio sample value (float, typically -1..1)
   */
  processSample(sample) {
    const s0 = sample + this.coeff * this.s1 - this.s2;
    this.s2 = this.s1;
    this.s1 = s0;
    this.count++;
  }

  /**
   * Compute the magnitude² of the target frequency.
   * Call after processing exactly blockSize samples.
   * Automatically resets the filter state.
   * @returns {number} Magnitude squared (proportional to energy at target frequency)
   */
  getMagnitude() {
    // Optimised Goertzel: magnitude² without complex arithmetic
    const mag2 = this.s1 * this.s1 + this.s2 * this.s2 - this.coeff * this.s1 * this.s2;
    this.reset();
    return mag2;
  }

  /**
   * Get complex DFT value (real + imaginary parts).
   * More expensive than getMagnitude but gives phase info.
   * @returns {{ real: number, imag: number, magnitude: number }}
   */
  getComplex() {
    const real = this.s1 - this.s2 * this.cosW;
    const imag = this.s2 * this.sinW;
    const magnitude = Math.sqrt(real * real + imag * imag);
    this.reset();
    return { real, imag, magnitude };
  }
}

/**
 * GoertzelBank manages multiple GoertzelFilters for simultaneous multi-frequency detection.
 */
export class GoertzelBank {
  /**
   * @param {number[]} frequencies - Array of frequencies to detect
   * @param {number} sampleRate
   * @param {number} blockSize
   */
  constructor(frequencies, sampleRate, blockSize) {
    this.filters = frequencies.map(f => new GoertzelFilter(f, sampleRate, blockSize));
    this.frequencies = frequencies;
    this.blockSize = blockSize;
  }

  /**
   * Feed one sample to all filters.
   * @param {number} sample
   */
  processSample(sample) {
    for (const f of this.filters) {
      f.processSample(sample);
    }
  }

  /**
   * Process an entire block of samples.
   * @param {Float32Array} samples
   */
  processBlock(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.processSample(samples[i]);
    }
  }

  /**
   * Get magnitudes for all frequencies. Resets all filters.
   * @returns {number[]} Array of magnitude² values, one per frequency
   */
  getMagnitudes() {
    return this.filters.map(f => f.getMagnitude());
  }

  /**
   * Reset all filters.
   */
  reset() {
    for (const f of this.filters) f.reset();
  }
}
