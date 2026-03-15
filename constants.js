// soniclink/constants.js — Protocol constants

export const SAMPLE_RATE = 48000;
export const SYMBOL_DURATION_MS = 80;
export const GUARD_DURATION_MS = 10;
export const SYMBOL_SAMPLES = Math.round(SAMPLE_RATE * SYMBOL_DURATION_MS / 1000);  // 3840
export const GUARD_SAMPLES = Math.round(SAMPLE_RATE * GUARD_DURATION_MS / 1000);    // 480
export const TOTAL_SYMBOL_SAMPLES = SYMBOL_SAMPLES + GUARD_SAMPLES;                  // 4320

// Frequency plan: 20 tone slots from 1000 Hz to 8600 Hz, spaced 400 Hz
export const BASE_FREQUENCY = 1000;
export const TONE_SPACING = 400;
export const NUM_TONES = 20;
export const TONES = Array.from({ length: NUM_TONES }, (_, i) => BASE_FREQUENCY + i * TONE_SPACING);
// [1000, 1400, 1800, 2200, 2600, 3000, 3400, 3800, 4200, 4600,
//  5000, 5400, 5800, 6200, 6600, 7000, 7400, 7800, 8200, 8600]

// We use 16 tones per symbol (2 bytes) for byte-aligned simplicity
export const BITS_PER_SYMBOL = 16;
export const BYTES_PER_SYMBOL = 2;

// Preamble frequency: tone slot 0 (1000 Hz)
export const PREAMBLE_TONE = TONES[0];

// Barker-13 code
export const BARKER_13 = [1, 1, 1, 1, 1, -1, -1, 1, 1, -1, 1, -1, 1];

// Frame types
export const FRAME = {
  SEED:           0x01,
  SEED_ECHO:      0x02,
  CHALLENGE:      0x03,
  CHALLENGE_ECHO: 0x04,
  CAPABILITY:     0x05,
  CONFIG:         0x06,
  DATA:           0x10,
  HASH_CHIRP:     0x20,
  ACK:            0x30,
  NAK:            0x31,
};

// Limits
export const MAX_PAYLOAD = 127;
export const SEED_LENGTH = 64;
export const CHALLENGE_LENGTH = 512;
export const HASH_CHIRP_LENGTH = 8;
export const HASH_CHIRP_INTERVAL_MS = 1000;

// Timeouts
export const SEED_TIMEOUT_MS = 15000;
export const ECHO_TIMEOUT_MS = 10000;
export const FRAME_TIMEOUT_MS = 30000;
export const MAX_RETRIES = 3;

// Detection
export const MIN_SNR_RATIO = 3.0;  // Minimum on/off energy ratio for usable tone
export const TONE_AMPLITUDE = 0.15; // Per-tone output amplitude (0..1). Low to avoid clipping with many tones.
