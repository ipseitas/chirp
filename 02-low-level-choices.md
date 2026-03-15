# SonicLink — Low-Level Choices & Considerations

This document logs every non-obvious technical decision, the alternatives considered, and why each choice was made.

---

## 1. Physical layer

### 1.1 Sample rate: 48 kHz

| Option | Pros | Cons |
|--------|------|------|
| 44.1 kHz | Universal support, CD standard | Nyquist at 22.05 kHz, awkward FFT bin alignment |
| **48 kHz** | Web Audio API default, clean math (48000/2048 = 23.4375 Hz bins) | Some old devices only do 44.1 kHz |
| 96 kHz | Higher Nyquist | Overkill, not all mics/speakers go above 20 kHz anyway |

**Decision**: 48 kHz default. Fall back to 44.1 kHz if `AudioContext.sampleRate` reports it. The FFT bin width changes slightly (21.5 Hz vs 23.4 Hz) — the protocol adapts automatically since subcarrier assignment is frequency-based, not bin-index-based.

### 1.2 Audio API: AudioWorklet, not ScriptProcessorNode

ScriptProcessorNode runs on the main thread and is deprecated. AudioWorklet runs on a dedicated real-time audio thread with 128-sample render quanta (~2.67 ms at 48 kHz).

**Gotcha**: AudioWorklet runs in a separate global scope (`AudioWorkletGlobalScope`). You cannot import arbitrary npm modules. Communication with the main thread is via `MessagePort` or `SharedArrayBuffer`.

For the MVP, we use `MessagePort` to pass sample buffers. This adds ~1 ms of latency per message but avoids the `SharedArrayBuffer` CORS header requirement (`Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin`). Phase 2 can switch to SAB if latency matters.

### 1.3 getUserMedia HTTPS requirement

Chrome requires HTTPS for microphone access. Firefox allows it on localhost. Safari requires HTTPS everywhere. The MVP must be served over HTTPS or localhost.

### 1.4 Firefox 16 kHz ceiling

Firefox's WebAudio resamples mic input to 32 kHz internally, capping usable spectrum at ~15.5 kHz. The protocol must detect this (via `AudioContext.sampleRate` or by observing the chirp response) and limit OFDM subcarrier allocation accordingly.

---

## 2. Robust mode modulation

### 2.1 Why FSK over PSK/QAM

| Modulation | Detection | Room acoustics tolerance | Bits/symbol |
|------------|-----------|--------------------------|-------------|
| OOK (on-off keying) | Amplitude threshold | Good, but amplitude varies with distance | 1 |
| **Multi-tone FSK** | Frequency energy (Goertzel) | Excellent — frequency is preserved through reflections | 1 per tone |
| PSK | Phase detection | Poor — multipath destroys phase coherence | 1-8 per symbol |
| QAM | Phase + amplitude | Very poor through air | 2-8 per symbol |

Phase-based schemes are unreliable over air. Sound bounces off walls, ceiling, desk — each reflection arrives with a different delay, smearing the phase. Frequency detection (is this tone present or not?) is far more robust because multipath doesn't shift frequencies, only amplitudes and phases.

### 2.2 Tone spacing: 400 Hz

The minimum resolvable frequency difference with a 2048-sample FFT at 48 kHz is ~23.4 Hz. So why 400 Hz?

- **Doppler tolerance**: If someone moves a device while transmitting, the perceived frequency shifts. At walking speed (~1.5 m/s) and 10 kHz carrier, Doppler shift is ~44 Hz. 400 Hz spacing gives 10× margin.
- **Clock drift**: Two devices with different crystal oscillators may disagree on the sample rate by up to ±50 ppm. At 10 kHz, that's ±0.5 Hz — negligible, but combined with other effects it adds up.
- **Spectral leakage**: Without a perfect rectangular window (which doesn't exist in practice), energy from one tone leaks into adjacent bins. 400 Hz spacing means ~17 bins of separation — leakage is effectively zero.
- **Speaker nonlinearity**: Cheap speakers produce harmonics and intermodulation products. Wide spacing reduces the chance that a harmonic of tone A lands on tone B.

**Trade-off**: With 400 Hz spacing across 1–9 kHz, we get 20 tone slots. Each slot carries 1 bit per symbol → 20 bits/symbol. At 80 ms/symbol → 250 bps raw. After RS FEC → ~125 bps effective. This is slow but the mode exists for reliability, not speed.

### 2.3 Goertzel vs FFT for robust mode

For detecting 20 specific frequencies, Goertzel is more efficient than a full FFT. Goertzel computes the DFT magnitude at a single frequency bin with O(N) operations. For K frequencies, that's O(K*N). A full 2048-point FFT is O(N*log₂N) = O(N*11).

With K=20 and N=2048: Goertzel = 20*2048 = 40960 multiplies. FFT = 2048*11 = 22528 multiplies. FFT wins on raw count, but Goertzel has much less overhead (no bit-reversal, no complex butterfly, no memory allocation for the full spectrum). In practice they're comparable for K≤30.

**Decision**: Use Goertzel for robust mode (simpler code, no FFT dependency for MVP). Use FFT only for OFDM fast mode.

### 2.4 Symbol duration: 80 ms

At 48 kHz, 80 ms = 3840 samples. We run Goertzel over these 3840 samples per tone. Longer windows give sharper frequency resolution but slower symbol rate:

| Duration | Samples | Frequency resolution | Symbol rate | Bits/sec (20 tones) |
|----------|---------|---------------------|-------------|---------------------|
| 40 ms | 1920 | 25 Hz | 25/s | 500 |
| **80 ms** | 3840 | 12.5 Hz | 12.5/s | 250 |
| 160 ms | 7680 | 6.25 Hz | 6.25/s | 125 |

80 ms is the sweet spot: enough resolution to cleanly separate 400 Hz-spaced tones with margin, fast enough that the handshake doesn't take forever.

### 2.5 Guard interval between symbols: 10 ms

After each 80 ms symbol, 10 ms of silence. This lets room reverberations die out before the next symbol starts. Total symbol period: 90 ms.

---

## 3. Seed handshake

### 3.1 Why not a known chirp?

A known chirp (linear frequency sweep) is the standard approach for synchronisation. It works well but provides no verification that the receiver actually decoded anything correctly. You have to trust the cross-correlation metric.

The seed-based approach serves three purposes simultaneously:
1. **Sync**: The Barker-13 preamble before the seed provides frame synchronisation (just like a chirp would).
2. **Channel test**: The 512-byte challenge data exercises many different frequency patterns across retries (different PRNG output each turn).
3. **Mutual verification**: Both sides prove they can decode robust-mode data before committing to fast mode.

### 3.2 Why 64-byte seed?

- 64 bytes = 512 bits of entropy. More than enough for uniqueness.
- At ~125 bps effective in robust mode, transmitting 64 bytes takes ~4 seconds. Acceptable for a one-time handshake.
- 32 bytes would also work but leaves less margin if we ever want to derive multiple keys/nonces.

### 3.3 Why xoshiro256** for the PRNG?

| PRNG | Speed | Quality | Code size |
|------|-------|---------|-----------|
| Math.random() | Fast | Implementation-dependent, not seedable | 0 lines |
| **xoshiro256**** | Very fast | Excellent (passes BigCrush) | ~20 lines |
| ChaCha20 | Moderate | Cryptographic | ~100 lines |
| AES-CTR | Moderate (needs WebCrypto) | Cryptographic | ~50 lines + async |

We don't need cryptographic randomness for the test data — we only need deterministic, seedable output with good statistical properties (so the test data exercises the full spectrum). xoshiro256** is perfect for this. The seed itself is crypto-random (from `crypto.getRandomValues`).

### 3.4 Turn-dependent derivation

`SHA-256(seed || turn_number_le32)` → 32 bytes → xoshiro256** state.

The turn number is appended as a 4-byte little-endian integer. This ensures:
- Turn 0, 1, 2, ... produce completely different 512-byte blocks.
- Both sides can independently compute the expected data for any turn.
- A failed attempt doesn't waste time retransmitting the same bit pattern that might systematically fail on a particular channel characteristic.

### 3.5 SHA-256 for key derivation

We need SHA-256 anyway (for hash chirps), so reusing it here adds no code. WebCrypto's `crypto.subtle.digest('SHA-256', ...)` is available in all modern browsers, runs natively (not in JS), and is fast.

---

## 4. FEC choices

### 4.1 Robust mode: RS(255, 127)

Reed-Solomon over GF(2⁸). Each codeword is 255 bytes: 127 data + 128 parity. Can correct up to 64 byte errors (or detect up to 128).

**Why so aggressive?** Robust mode is for situations where the channel is unknown or degraded. A 50% code rate means we can lose half the symbols and still recover. Given the slow speed of robust mode, the extra redundancy costs time but almost guarantees delivery.

**Implementation**: The MVP includes a hand-rolled GF(2⁸) RS encoder/decoder. It's ~300 lines of JS. Using a library (like `reedsolomon.es`) is an option but they tend to be poorly maintained or have awkward APIs. The GF(2⁸) arithmetic is straightforward — the only tricky part is the Berlekamp-Massey or Euclidean algorithm for finding the error locator polynomial.

For the MVP, we simplify: encoder only (no decoder yet). The receiver simply checks CRC-32 on each frame. If CRC fails, it requests retransmit. Full RS decoding is a v0.2 feature.

### 4.2 MVP simplification: CRC-32 only

For the MVP, we skip RS encoding/decoding entirely and rely on:
- CRC-32 per frame for error detection
- 3× frame redundancy (simplex) or ARQ retransmit (duplex)
- The inherent robustness of wide-spaced FSK

This dramatically reduces code complexity for the first working version. RS is added later when we need to push throughput.

### 4.3 Fast mode: Convolutional code (rate 3/4)

Planned for v0.2. Convolutional codes with Viterbi decoding are well-suited to the random error patterns from OFDM over noisy channels. Rate 3/4 means 25% overhead — a good balance for indoor use.

---

## 5. Frame structure

### 5.1 Robust frame

```
┌──────────┬────────┬─────────────────┬────────────┬──────────┐
│ Barker13 │ Header │ Payload         │ CRC-32     │ (guard)  │
│ 13 sym   │ 4 B    │ 0..127 B        │ 4 B        │ 10ms     │
└──────────┴────────┴─────────────────┴────────────┘
```

Header fields (4 bytes):
- `type` (1 byte): SEED=0x01, SEED_ECHO=0x02, CHALLENGE=0x03, CHALLENGE_ECHO=0x04, CAPABILITY=0x05, CONFIG=0x06, DATA=0x10, HASH_CHIRP=0x20, ACK=0x30, NAK=0x31
- `length` (2 bytes, LE): payload length
- `seq` (1 byte): sequence number (wrapping 0–255)

### 5.2 Barker-13 preamble encoding

The 13-chip Barker code `[+1, +1, +1, +1, +1, -1, -1, +1, +1, -1, +1, -1, +1]` is transmitted as a sequence of 13 FSK symbols on a dedicated preamble frequency (e.g., 1000 Hz):
- `+1` → tone ON (1000 Hz present)
- `-1` → tone OFF (silence at 1000 Hz)

Each chip lasts one symbol period (80 ms), so the full preamble is 1.17 seconds. The receiver cross-correlates the detected on/off pattern against the known Barker code to find frame boundaries.

**Autocorrelation properties**: The Barker-13 code has peak-to-sidelobe ratio of 22.3 dB, meaning false triggers from random noise are very unlikely.

### 5.3 Hash chirp frame

Uses the standard robust frame format with `type=0x20`:
```
Payload (10 bytes):
  window_number (2 bytes, LE)
  hash (8 bytes, truncated SHA-256)
```

---

## 6. Hash chirp design

### 6.1 Why 8-byte truncated hash?

Full SHA-256 is 32 bytes → ~2 seconds in robust mode. Truncated to 8 bytes → ~0.7 seconds. The collision probability for an 8-byte hash is 1/2⁶⁴, which is astronomically unlikely for our use case (we're comparing known data, not defending against adversaries).

### 6.2 Frequency band reservation

During fast-mode transfer with hash chirps active:
- Robust mode uses frequencies 1000–3000 Hz (5 tone slots at 400 Hz spacing)
- OFDM fast mode uses frequencies 3400 Hz and above
- This wastes some spectrum but avoids interference between the two modes

When no hash chirp is being transmitted, the sender can opportunistically use the 1–3 kHz band for additional OFDM subcarriers. The receiver knows when to expect a hash chirp (every ~1 second) and switches the band allocation accordingly.

### 6.3 Window alignment

Both sides maintain a `window_counter` that increments every 1 second (wall clock). The hash covers all data frames with sequence numbers received/sent during that window.

If the receiver is still receiving data when the window expires, it finishes the current frame, then computes and sends the hash. The window boundaries don't need to be sample-accurate — they just need to agree on which sequence numbers belong to which window.

### 6.4 Autotune trigger

```
hash_mismatch_count = 0

on hash_chirp_received(window, hash):
    expected = sha256(data_sent_in_window(window))[:8]
    if hash == expected:
        hash_mismatch_count = 0
    else:
        hash_mismatch_count++
        retransmit_window(window)
        if hash_mismatch_count >= 3:
            initiate_autotune()
        if hash_mismatch_count >= 5:
            abort_transfer()
```

---

## 7. Web Audio API specifics

### 7.1 Autoplay policy

Browsers block audio output until a user gesture (click/tap). The sender must be triggered by a button click. The receiver only needs mic access (getUserMedia), which has its own permission prompt.

### 7.2 AudioWorklet processor structure

```
Main thread                    AudioWorklet thread
┌──────────────────┐           ┌──────────────────────┐
│ SonicLinkEngine  │           │ SonicLinkProcessor   │
│                  │  port     │                      │
│ - state machine  │ ◄──────► │ - sample accumulator  │
│ - frame assembly │ message  │ - Goertzel filters    │
│ - FEC encode/    │ port     │ - tone generator      │
│   decode         │           │ - output buffer       │
│ - PRNG           │           │                      │
└──────────────────┘           └──────────────────────┘
```

The AudioWorklet handles:
- TX: generating tone samples and writing to output buffer
- RX: accumulating input samples, running Goertzel, posting energy levels to main thread

The main thread handles:
- Protocol state machine
- Frame encoding/decoding
- FEC
- Hash computation (via WebCrypto)

### 7.3 Latency budget

| Component | Latency |
|-----------|---------|
| AudioWorklet render quantum | 2.67 ms |
| MessagePort round-trip | ~1 ms |
| Symbol duration | 80 ms |
| Guard interval | 10 ms |
| **Total per symbol** | **~94 ms** |

This is acceptable. We're not building a real-time communication system — we're transferring data. Throughput matters more than latency.

---

## 8. PRNG implementation notes

### 8.1 xoshiro256** in JavaScript

JavaScript doesn't have native 64-bit integers. We have two options:
1. **BigInt**: Clean but slow (~10× slower than number arithmetic).
2. **Paired 32-bit numbers**: Fast but ugly. Each 64-bit value is `[hi, lo]`.

For the MVP, we use BigInt. The PRNG is called 64 times per turn — performance is irrelevant at this scale. If we later port to WASM, Rust handles u64 natively.

### 8.2 SHA-256

Use WebCrypto API: `crypto.subtle.digest('SHA-256', buffer)`. This is async but fast (native implementation). For the MVP this is fine — we only hash during handshake and once per second during transfer.

---

## 9. Browser compatibility

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| AudioWorklet | ✅ | ✅ | ✅ | ✅ |
| getUserMedia | ✅ (HTTPS) | ✅ (localhost OK) | ✅ (HTTPS) | ✅ (HTTPS) |
| WebCrypto SHA-256 | ✅ | ✅ | ✅ | ✅ |
| Max mic frequency | ~22 kHz | ~15.5 kHz | ~22 kHz | ~22 kHz |
| BigInt | ✅ | ✅ | ✅ | ✅ |

Firefox's 16 kHz mic ceiling is the main compatibility concern. The protocol handles it by limiting tone allocation to the detected usable range.
