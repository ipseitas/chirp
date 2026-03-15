# SonicLink — Low-Level Interface & Implementation Spec

---

## 1. Module architecture

```
soniclink/
├── soniclink.js           # Main entry point, public API
├── engine.js              # Protocol state machine + frame logic
├── audio-worklet.js       # AudioWorkletProcessor (runs in audio thread)
├── goertzel.js            # Goertzel algorithm implementation
├── fsk.js                 # FSK modulator/demodulator (robust mode)
├── framing.js             # Frame encode/decode, CRC-32
├── prng.js                # xoshiro256** + SHA-256 key derivation
└── constants.js           # Protocol constants and configuration
```

---

## 2. Public API

### 2.1 SonicLink class

```typescript
interface SonicLinkConfig {
  forceSimplex?: boolean;       // Default: false. Skip echo, assume no back-channel.
  robustOnly?: boolean;         // Default: false (MVP is always robust-only anyway).
  sampleRate?: number;          // Default: 48000. Override only if needed.
  toneSpacing?: number;         // Default: 400 Hz.
  symbolDuration?: number;      // Default: 80 ms.
  guardDuration?: number;       // Default: 10 ms.
  baseFrequency?: number;       // Default: 1000 Hz.
  maxFrequency?: number;        // Default: 9000 Hz (conservative for all browsers).
  hashChirpInterval?: number;   // Default: 1000 ms.
  maxRetries?: number;          // Default: 3 per phase.
}

interface TransferProgress {
  phase: 'idle' | 'seed' | 'challenge' | 'transfer' | 'done' | 'error';
  bytesSent: number;
  bytesTotal: number;
  currentTurn: number;
  hashChirpStatus: 'ok' | 'mismatch' | 'pending';
}

interface TransferResult {
  success: boolean;
  bytesTransferred: number;
  duration: number;           // ms
  retransmits: number;
  autotuneCount: number;
  error?: string;
}

class SonicLink {
  constructor(config?: SonicLinkConfig);

  // Sender: transmit arbitrary bytes
  async send(data: Uint8Array): Promise<TransferResult>;

  // Receiver: listen and receive bytes
  async receive(): Promise<Uint8Array>;

  // Cancel ongoing transfer
  abort(): void;

  // Event callbacks
  onProgress?: (progress: TransferProgress) => void;
  onStateChange?: (state: string) => void;
  onError?: (error: Error) => void;

  // Cleanup
  async destroy(): void;
}
```

### 2.2 Usage example

```javascript
// Sender
const sender = new SonicLink();
sender.onProgress = (p) => console.log(`${p.bytesSent}/${p.bytesTotal}`);
const result = await sender.send(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
console.log(result.success ? 'Done!' : `Failed: ${result.error}`);
await sender.destroy();

// Receiver
const receiver = new SonicLink();
const data = await receiver.receive();
console.log('Got:', new TextDecoder().decode(data));
await receiver.destroy();
```

---

## 3. Internal interfaces

### 3.1 Goertzel filter

```typescript
class GoertzelFilter {
  constructor(targetFrequency: number, sampleRate: number, blockSize: number);

  // Process a single sample. Call blockSize times, then read magnitude.
  processSample(sample: number): void;

  // Get magnitude² after processing a full block. Resets internal state.
  getMagnitude(): number;

  // Reset without reading
  reset(): void;
}
```

**Implementation detail**: The optimised Goertzel computes magnitude² directly (no phase). For FSK we only care about whether a tone is present, not its phase.

```javascript
// Core algorithm (3 state variables per filter instance)
class GoertzelFilter {
  constructor(targetFreq, sampleRate, blockSize) {
    this.blockSize = blockSize;
    const k = Math.round(blockSize * targetFreq / sampleRate);
    this.w = (2 * Math.PI * k) / blockSize;
    this.coeff = 2 * Math.cos(this.w);
    this.reset();
  }

  reset() {
    this.s0 = 0;    // s[n]
    this.s1 = 0;    // s[n-1]
    this.s2 = 0;    // s[n-2]
    this.count = 0;
  }

  processSample(sample) {
    this.s0 = sample + this.coeff * this.s1 - this.s2;
    this.s2 = this.s1;
    this.s1 = this.s0;
    this.count++;
  }

  getMagnitude() {
    // magnitude² = s1² + s2² - coeff * s1 * s2
    const mag = this.s1 * this.s1 + this.s2 * this.s2
                - this.coeff * this.s1 * this.s2;
    this.reset();
    return mag;
  }
}
```

### 3.2 FSK modulator

```typescript
class FSKModulator {
  constructor(config: {
    frequencies: number[];   // Tone slot center frequencies
    sampleRate: number;
    symbolDuration: number;  // seconds
    guardDuration: number;   // seconds
    amplitude: number;       // 0.0..1.0
  });

  // Generate audio samples for one symbol (bitmask of active tones)
  generateSymbol(toneMask: number): Float32Array;

  // Generate Barker-13 preamble samples
  generatePreamble(): Float32Array;
}
```

### 3.3 FSK demodulator

```typescript
class FSKDemodulator {
  constructor(config: {
    frequencies: number[];
    sampleRate: number;
    symbolDuration: number;
    guardDuration: number;
    threshold: number;       // Energy threshold for "tone present"
  });

  // Feed audio samples. Returns decoded symbols as they complete.
  feedSamples(samples: Float32Array): DecodedSymbol[];

  // Check if a Barker-13 preamble was detected
  hasPreamble(): boolean;
}

interface DecodedSymbol {
  toneMask: number;         // Bitmask of detected tones
  energies: number[];       // Per-tone energy levels (for diagnostics)
  timestamp: number;        // Sample offset
}
```

### 3.4 Frame encoder/decoder

```typescript
// Frame types
enum FrameType {
  SEED          = 0x01,
  SEED_ECHO     = 0x02,
  CHALLENGE     = 0x03,
  CHALLENGE_ECHO = 0x04,
  CAPABILITY    = 0x05,
  CONFIG        = 0x06,
  DATA          = 0x10,
  HASH_CHIRP    = 0x20,
  ACK           = 0x30,
  NAK           = 0x31,
}

class FrameEncoder {
  // Encode a frame into a byte array (header + payload + CRC)
  static encode(type: FrameType, seq: number, payload: Uint8Array): Uint8Array;
}

class FrameDecoder {
  // Decode a byte array back into frame components. Returns null if CRC fails.
  static decode(data: Uint8Array): { type: FrameType, seq: number, payload: Uint8Array } | null;
}
```

**CRC-32 implementation**: Standard CRC-32/ISO-HDLC (polynomial 0xEDB88320, reflected). ~30 lines of JS using a precomputed 256-entry lookup table.

### 3.5 PRNG (xoshiro256**)

```typescript
class Xoshiro256ss {
  constructor(seed: Uint8Array);  // 32-byte seed → 4 × 64-bit state

  // Generate next 64-bit value as BigInt
  next(): bigint;

  // Generate N bytes
  nextBytes(n: number): Uint8Array;
}

// Key derivation
async function deriveTestBlock(seed: Uint8Array, turn: number): Promise<Uint8Array> {
  // SHA-256(seed || turn_le32) → 32 bytes → seed Xoshiro → generate 512 bytes
}
```

### 3.6 AudioWorklet processor

```typescript
// audio-worklet.js — runs in AudioWorkletGlobalScope
class SonicLinkProcessor extends AudioWorkletProcessor {
  // Modes: 'idle', 'tx', 'rx'
  private mode: string;
  private txBuffer: Float32Array[];
  private rxAccumulator: Float32Array;
  private goertzelFilters: GoertzelFilter[];

  process(inputs, outputs, parameters): boolean {
    if (this.mode === 'tx') {
      // Copy from txBuffer to output
    } else if (this.mode === 'rx') {
      // Accumulate input samples
      // Run Goertzel filters every symbolDuration samples
      // Post detected energies to main thread
    }
    return true;  // Keep processor alive
  }
}
```

**Message protocol** between main thread and worklet:

```
Main → Worklet:
  { cmd: 'tx-start', samples: Float32Array }
  { cmd: 'tx-stop' }
  { cmd: 'rx-start', config: { frequencies, sampleRate, symbolDuration } }
  { cmd: 'rx-stop' }

Worklet → Main:
  { event: 'tx-complete' }
  { event: 'symbol-detected', toneMask: number, energies: number[] }
  { event: 'preamble-detected', offset: number }
  { event: 'rx-samples', samples: Float32Array }  // raw, for diagnostics
```

---

## 4. Protocol state machine

### 4.1 Sender states

```
IDLE
  → user calls send(data)
  → generate 64-byte seed
  → go to SEND_SEED

SEND_SEED
  → encode seed as SEED frame
  → transmit via robust mode
  → start timeout (5 seconds)
  → on SEED_ECHO received and matches: go to SEND_CHALLENGE
  → on timeout: increment turn, retry (max 3), then FAIL
  → if forceSimplex: skip echo, go to SEND_CHALLENGE

SEND_CHALLENGE
  → derive 512-byte block from PRNG(seed, turn)
  → encode as CHALLENGE frame(s) (splits across multiple frames if >127 B)
  → transmit via robust mode
  → on CHALLENGE_ECHO received and matches: go to CAPABILITY_WAIT
  → on timeout: increment turn, retry, then FAIL
  → if forceSimplex: skip echo, go to TRANSFER_SIMPLEX

CAPABILITY_WAIT
  → wait for CAPABILITY frame from receiver
  → parse spectrum profile
  → send CONFIG frame with negotiated parameters
  → go to TRANSFER_FAST (or TRANSFER_ROBUST if robustOnly)

TRANSFER_FAST (v0.2)
  → send DATA frames via OFDM
  → monitor hash chirps from receiver
  → on hash mismatch: retransmit window
  → on 3 consecutive mismatches: AUTOTUNE
  → on all data sent + final hash confirmed: DONE

TRANSFER_ROBUST
  → send DATA frames via robust mode
  → if duplex: wait for ACK per frame (stop-and-wait)
  → if simplex: send each frame 3×
  → on all data sent: DONE

AUTOTUNE
  → pause transfer
  → re-send chirp probe
  → receive updated capability
  → reconfigure OFDM
  → resume TRANSFER_FAST

DONE → clean up, return TransferResult
FAIL → clean up, return error
```

### 4.2 Receiver states

```
IDLE
  → user calls receive()
  → start listening (rx mode)
  → go to LISTEN_SEED

LISTEN_SEED
  → wait for Barker preamble
  → decode SEED frame
  → if forceSimplex: store seed, go to LISTEN_CHALLENGE
  → else: echo seed back as SEED_ECHO, go to LISTEN_CHALLENGE

LISTEN_CHALLENGE
  → derive expected 512-byte block from PRNG(seed, turn)
  → wait for CHALLENGE frame(s)
  → verify against expected
  → if match: echo back as CHALLENGE_ECHO, send CAPABILITY, go to RECEIVE_DATA
  → if mismatch: send NAK, wait for retry with incremented turn

RECEIVE_DATA
  → decode incoming DATA frames
  → accumulate payload bytes
  → every 1 second: compute hash of received window, send HASH_CHIRP
  → on final frame received: DONE

DONE → return accumulated Uint8Array
```

---

## 5. Bit encoding — symbols to bytes

### 5.1 Multi-tone FSK mapping

With 20 tone slots, each symbol carries 20 bits (one bit per slot). Bytes are packed MSB-first:

```
Byte 0:  bits [0..7]   → tones 0..7 of symbol 0
Byte 1:  bits [8..15]  → tones 8..15 of symbol 0
Byte 2:  bits [16..19] → tones 16..19 of symbol 0
                         + bits [0..3] of next byte → tones 0..3 of symbol 1
...
```

Actually, for simplicity in the MVP, we sacrifice efficiency: each symbol carries 2 bytes (16 bits across tones 0..15). Tones 16..19 are unused overhead.

```
Symbol N:
  tone 0  = bit 7 of byte 2N
  tone 1  = bit 6 of byte 2N
  ...
  tone 7  = bit 0 of byte 2N
  tone 8  = bit 7 of byte 2N+1
  ...
  tone 15 = bit 0 of byte 2N+1
  tones 16..19 = unused (always off)
```

This gives 2 bytes per 90 ms symbol → ~22 bytes/sec → **~177 bps effective**.

### 5.2 Why waste 4 tones?

Byte alignment makes the framing code trivial. The lost 4 bits/symbol is a 20% throughput reduction, but robust mode isn't speed-critical. If we later want to pack tighter, we can switch to arbitrary bit-packing.

---

## 6. Threshold calibration

### 6.1 Adaptive threshold for tone detection

The Goertzel magnitude for a "tone present" symbol varies with:
- Speaker volume
- Microphone gain
- Distance between devices
- Room acoustics

Static thresholds don't work. Instead, the receiver calibrates during the Barker preamble:

1. During preamble, measure Goertzel magnitude for tone-ON chips and tone-OFF chips.
2. Set threshold = `(mean_on + mean_off) / 2`.
3. If `mean_on / mean_off < 3.0`, the channel is too noisy for this frequency — mark it unusable.

### 6.2 Per-tone threshold

Different frequencies may have different SNR (speaker frequency response, room resonances). Each tone slot gets its own threshold, calibrated from the preamble and first few symbols of the seed.

---

## 7. Timing and synchronisation

### 7.1 Initial sync: Barker correlation

The receiver continuously runs a sliding correlator against the preamble frequency's Goertzel output. When the correlation peak exceeds a threshold, a preamble is declared and the symbol clock starts.

### 7.2 Symbol clock drift

The sender's and receiver's `AudioContext` clocks may drift relative to each other. Over a 10-second transfer, 50 ppm drift at 48 kHz = 24 samples = 0.5 ms. This is negligible compared to the 80 ms symbol duration.

For long transfers (minutes), we re-sync by looking for the next Barker preamble at the start of each frame. Each frame begins with its own preamble in the MVP. This is wasteful (~1.2 seconds of overhead per frame) but maximises robustness.

### 7.3 MVP simplification: frame-level sync only

In the MVP, we don't maintain a running symbol clock. Instead:
1. Listen for preamble.
2. After preamble, read fixed number of symbols (based on header length field).
3. Go back to listening for next preamble.

This means every frame has its own preamble overhead. For a 127-byte payload frame, the data takes ~5.7 seconds and the preamble takes ~1.2 seconds — about 17% overhead. Acceptable for an MVP.

---

## 8. Error handling

| Error condition | Handling |
|-----------------|----------|
| Mic permission denied | Throw immediately, user-facing error |
| No audio output device | Throw immediately |
| Preamble not detected within 30 seconds | Timeout, abort |
| CRC mismatch on frame | Request retransmit (duplex) or discard (simplex) |
| Seed echo mismatch | Retry with incremented turn |
| 3+ handshake failures | Abort with "channel too noisy" error |
| Hash chirp mismatch | Retransmit window |
| 5+ hash chirp failures | Abort transfer |
| AudioContext suspended (browser policy) | Prompt user to click/tap |
