// soniclink/fsk.js — Multi-tone FSK modulator and demodulator

import {
  TONES, SAMPLE_RATE, SYMBOL_SAMPLES, GUARD_SAMPLES, TOTAL_SYMBOL_SAMPLES,
  BARKER_13, PREAMBLE_TONE, TONE_AMPLITUDE, BITS_PER_SYMBOL, BYTES_PER_SYMBOL,
  NUM_TONES, MIN_SNR_RATIO,
} from './constants.js';
import { GoertzelBank, GoertzelFilter } from './goertzel.js';

// ── Modulator ──────────────────────────────────────────────────────────────

/**
 * Generate audio samples for a Barker-13 preamble.
 * Each chip is one symbol duration on the preamble tone.
 * +1 = tone on, -1 = tone off.
 *
 * @returns {Float32Array} Audio samples for the full preamble
 */
export function generatePreamble() {
  const totalSamples = BARKER_13.length * TOTAL_SYMBOL_SAMPLES;
  const samples = new Float32Array(totalSamples);
  let offset = 0;

  for (const chip of BARKER_13) {
    // Symbol portion
    for (let i = 0; i < SYMBOL_SAMPLES; i++) {
      if (chip === 1) {
        // Tone on
        const t = i / SAMPLE_RATE;
        samples[offset + i] = TONE_AMPLITUDE * Math.sin(2 * Math.PI * PREAMBLE_TONE * t);
      }
      // chip === -1: silence (samples already 0)
    }
    // Guard portion: silence
    offset += TOTAL_SYMBOL_SAMPLES;
  }

  return samples;
}

/**
 * Generate audio samples for a single FSK symbol.
 * Each bit in the data controls one tone (1 = on, 0 = off).
 *
 * @param {number} toneMask - Bitmask of which tones to activate (bit 0 = TONES[0])
 * @returns {Float32Array} Audio samples for one symbol + guard
 */
export function generateSymbol(toneMask) {
  const samples = new Float32Array(TOTAL_SYMBOL_SAMPLES);

  for (let i = 0; i < SYMBOL_SAMPLES; i++) {
    const t = i / SAMPLE_RATE;
    let value = 0;
    for (let bit = 0; bit < BITS_PER_SYMBOL; bit++) {
      if (toneMask & (1 << bit)) {
        // Use tones starting from index 1 (index 0 is reserved for preamble)
        value += TONE_AMPLITUDE * Math.sin(2 * Math.PI * TONES[bit + 1] * t);
      }
    }
    samples[i] = value;
  }
  // Guard interval: already zeros

  return samples;
}

/**
 * Encode a byte array into FSK audio samples.
 * Includes preamble + data symbols.
 *
 * @param {Uint8Array} data - Bytes to encode
 * @returns {Float32Array} Complete audio signal
 */
export function encodeToAudio(data) {
  const preamble = generatePreamble();

  // Number of symbols needed: ceil(data.length / BYTES_PER_SYMBOL)
  const numSymbols = Math.ceil(data.length / BYTES_PER_SYMBOL);
  const totalSamples = preamble.length + numSymbols * TOTAL_SYMBOL_SAMPLES;
  const output = new Float32Array(totalSamples);

  // Copy preamble
  output.set(preamble, 0);
  let offset = preamble.length;

  // Encode data symbols
  for (let sym = 0; sym < numSymbols; sym++) {
    const byteIdx = sym * BYTES_PER_SYMBOL;
    let toneMask = 0;

    // Pack bytes into tone mask: byte 0 → bits 0..7, byte 1 → bits 8..15
    for (let b = 0; b < BYTES_PER_SYMBOL; b++) {
      if (byteIdx + b < data.length) {
        toneMask |= data[byteIdx + b] << (b * 8);
      }
    }

    const symbolSamples = generateSymbol(toneMask);
    output.set(symbolSamples, offset);
    offset += TOTAL_SYMBOL_SAMPLES;
  }

  return output;
}

// ── Demodulator ────────────────────────────────────────────────────────────

/**
 * FSKDemodulator processes incoming audio samples and extracts frames.
 * It first looks for a Barker-13 preamble, then decodes data symbols.
 */
export class FSKDemodulator {
  constructor() {
    // Data tone bank: tones 1..16 (tone 0 is preamble)
    const dataTones = TONES.slice(1, 1 + BITS_PER_SYMBOL);
    this.dataBank = new GoertzelBank(dataTones, SAMPLE_RATE, SYMBOL_SAMPLES);

    // Preamble detector
    this.preambleFilter = new GoertzelFilter(PREAMBLE_TONE, SAMPLE_RATE, SYMBOL_SAMPLES);

    // State
    this.state = 'scanning';  // 'scanning' | 'preamble' | 'data'
    this.sampleBuffer = [];
    this.symbolBuffer = [];
    this.preambleChips = [];
    this.thresholds = null;

    // Calibration data from preamble
    this.preambleOnEnergy = 0;
    this.preambleOffEnergy = 0;

    // Expected data length (set after header decode)
    this.expectedBytes = 0;
    this.decodedFrames = [];
  }

  /**
   * Feed audio samples into the demodulator.
   * @param {Float32Array} samples
   * @returns {Uint8Array[]} Array of decoded frame byte arrays (may be empty)
   */
  feedSamples(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.sampleBuffer.push(samples[i]);

      // Process one symbol's worth of samples at a time
      if (this.sampleBuffer.length >= TOTAL_SYMBOL_SAMPLES) {
        const symbolSamples = new Float32Array(this.sampleBuffer.splice(0, TOTAL_SYMBOL_SAMPLES));
        this._processSymbol(symbolSamples);
      }
    }

    // Return any complete frames
    const frames = this.decodedFrames;
    this.decodedFrames = [];
    return frames;
  }

  /**
   * Process one symbol period of audio.
   * @private
   */
  _processSymbol(samples) {
    // Only use the non-guard portion for detection
    const dataSamples = samples.subarray(0, SYMBOL_SAMPLES);

    if (this.state === 'scanning' || this.state === 'preamble') {
      // Check preamble frequency energy
      for (let i = 0; i < dataSamples.length; i++) {
        this.preambleFilter.processSample(dataSamples[i]);
      }
      const energy = this.preambleFilter.getMagnitude();

      if (this.state === 'scanning') {
        // Look for first preamble chip
        if (energy > 0.001) {  // Minimal threshold to detect any signal
          this.state = 'preamble';
          this.preambleChips = [energy];
          this.preambleOnEnergy = energy;
          this.preambleOffEnergy = 0;
        }
      } else {
        // Accumulating preamble chips
        this.preambleChips.push(energy);

        // Track on/off energy for threshold calibration
        // Barker-13: 9 ON chips, 4 OFF chips
        // We just separate by energy level after all 13 chips
        if (this.preambleChips.length >= BARKER_13.length) {
          if (this._validatePreamble()) {
            this._calibrateFromPreamble();
            this.state = 'data';
            this.symbolBuffer = [];
          } else {
            // False alarm, back to scanning
            this.state = 'scanning';
            this.preambleChips = [];
          }
        }
      }
    } else if (this.state === 'data') {
      // Decode data symbol
      const dataPortion = dataSamples;
      for (let i = 0; i < dataPortion.length; i++) {
        this.dataBank.processSample(dataPortion[i]);
      }
      const energies = this.dataBank.getMagnitudes();

      // Determine which tones are active
      let toneMask = 0;
      for (let bit = 0; bit < BITS_PER_SYMBOL; bit++) {
        if (energies[bit] > this.threshold) {
          toneMask |= (1 << bit);
        }
      }

      // Extract bytes from tone mask
      const bytes = [];
      for (let b = 0; b < BYTES_PER_SYMBOL; b++) {
        bytes.push((toneMask >> (b * 8)) & 0xFF);
      }
      this.symbolBuffer.push(...bytes);

      // After first 2 symbols (4 bytes = header), we know the payload length
      if (this.symbolBuffer.length === 4 && this.expectedBytes === 0) {
        const length = this.symbolBuffer[1] | (this.symbolBuffer[2] << 8);
        // Total frame bytes: 4 header + length payload + 4 CRC
        this.expectedBytes = 4 + length + 4;
      }

      // Check if we have enough bytes
      if (this.expectedBytes > 0 && this.symbolBuffer.length >= this.expectedBytes) {
        const frameBytes = new Uint8Array(this.symbolBuffer.slice(0, this.expectedBytes));
        this.decodedFrames.push(frameBytes);

        // Reset for next frame
        this.state = 'scanning';
        this.symbolBuffer = [];
        this.expectedBytes = 0;
        this.preambleChips = [];
      }
    }
  }

  /**
   * Validate preamble by correlating with Barker-13.
   * @private
   * @returns {boolean}
   */
  _validatePreamble() {
    if (this.preambleChips.length < BARKER_13.length) return false;

    // Sort energies to find threshold between ON and OFF
    const sorted = [...this.preambleChips].sort((a, b) => a - b);
    // Barker-13 has 4 OFF chips and 9 ON chips
    // Threshold between 4th and 5th sorted value
    const midThreshold = (sorted[3] + sorted[4]) / 2;

    // Convert to binary: above threshold = 1, below = -1
    const detected = this.preambleChips.map(e => e > midThreshold ? 1 : -1);

    // Cross-correlate with Barker-13
    let correlation = 0;
    for (let i = 0; i < BARKER_13.length; i++) {
      correlation += detected[i] * BARKER_13[i];
    }

    // Barker-13 peak correlation is 13, sidelobes are ≤1
    // Accept if correlation ≥ 10 (allows up to 1 chip error)
    return correlation >= 10;
  }

  /**
   * Calibrate tone detection threshold from preamble ON/OFF energies.
   * @private
   */
  _calibrateFromPreamble() {
    const sorted = [...this.preambleChips].sort((a, b) => a - b);

    // Average of bottom 4 (OFF chips) and top 9 (ON chips)
    const offAvg = sorted.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
    const onAvg = sorted.slice(4).reduce((a, b) => a + b, 0) / 9;

    // Set threshold at geometric mean (works better than arithmetic for energy)
    this.threshold = Math.sqrt(onAvg * Math.max(offAvg, 1e-10));

    // Sanity check: on/off ratio should be at least MIN_SNR_RATIO
    if (onAvg / Math.max(offAvg, 1e-10) < MIN_SNR_RATIO) {
      console.warn('SonicLink: Low SNR detected during preamble calibration');
    }
  }

  /**
   * Reset the demodulator to initial state.
   */
  reset() {
    this.state = 'scanning';
    this.sampleBuffer = [];
    this.symbolBuffer = [];
    this.preambleChips = [];
    this.thresholds = null;
    this.expectedBytes = 0;
    this.decodedFrames = [];
    this.dataBank.reset();
    this.preambleFilter.reset();
  }
}
