# SonicLink Protocol Design — High Level

**Version**: 0.1-draft  
**Date**: 2026-03-15  
**Status**: Design phase

---

## 1. Purpose

SonicLink is an acoustic data transfer protocol that moves arbitrary byte payloads between two devices using speaker-to-microphone audio. It operates in the audible and near-ultrasonic spectrum (1–20 kHz) and targets indoor environments (home/office, ~40–60 dB SNR).

The protocol does not attempt to be inaudible or noise-resilient in adversarial environments. It prioritises efficient use of the available spectrum and reliable delivery over comfort.

---

## 2. Protocol stack

```
┌──────────────────────────────┐
│  Application                 │  Arbitrary bytes in, bytes out
├──────────────────────────────┤
│  Transport                   │  Framing, FEC, ACK/retransmit
├──────────────────────────────┤
│  Modulation                  │  Robust FSK or adaptive OFDM
├──────────────────────────────┤
│  Physical                    │  Web Audio API (speaker ↔ mic)
└──────────────────────────────┘
```

---

## 3. Two operating modes

| Property            | Robust (thick) mode         | Fast mode                       |
|---------------------|-----------------------------|---------------------------------|
| Modulation          | Multi-tone FSK              | OFDM with adaptive QAM         |
| FEC                 | RS(255,127) + interleaving  | Rate-3/4 convolutional          |
| Throughput          | ~30–60 bps effective        | ~1–10 kbps effective            |
| Detection method    | Goertzel algorithm per tone | Full FFT per OFDM symbol        |
| Use case            | Handshake, hash chirps, simplex fallback | Bulk data transfer   |
| Reliability model   | 3× redundancy (simplex) or stop-and-wait ARQ | Sliding window ARQ |

Robust mode is always available. Fast mode requires a completed handshake.

---

## 4. Connection lifecycle

```
       ┌───────┐
       │ Idle  │
       └───┬───┘
           │ start()
       ┌───▼────────────┐
       │ Seed broadcast │  Sender transmits 64-byte seed via robust mode
       └───┬────────────┘
           │
       ┌───▼────────────┐
       │ Seed echo      │  Receiver echoes seed back (robust mode)
       └───┬────────────┘
           │ seed matches?
      ┌────┴─────┐
      │no        │yes
      ▼          ▼
   retry    ┌───────────────────┐
   (new     │ Challenge-response│  PRNG(seed, turn) → 512-byte block
    turn)   │ verification      │  Sender transmits, receiver echoes
            └───┬───────────────┘
                │ verified?
           ┌────┴─────┐
           │no        │yes
           ▼          ▼
        retry    ┌──────────────┐
                 │ Capability   │  Receiver sends spectrum profile
                 │ exchange     │  via robust mode
                 └───┬──────────┘
                     │
                ┌────┴─────────────┐
                │ has back-channel?│
                ├──yes─────────────┤──────no──────┐
                ▼                                 ▼
         ┌──────────────┐                  ┌──────────────┐
         │ Fast transfer │                  │ Simplex      │
         │ OFDM + hash  │                  │ robust 3×    │
         │ chirp monitor │                  │ redundancy   │
         └───┬──────────┘                  └──────┬───────┘
             │                                    │
             └──────────┬─────────────────────────┘
                        ▼
                   ┌────────┐
                   │  Done  │
                   └────────┘
```

---

## 5. Seed handshake (new design)

The classical approach uses a known chirp for synchronisation. SonicLink replaces this with a **seed-based challenge-response** that simultaneously achieves sync, channel probing, and mutual authentication.

### 5.1 Seed broadcast

1. Sender generates a cryptographically random 64-byte seed.
2. Sender broadcasts the seed using robust mode (multi-tone FSK).
3. The seed is preceded by a Barker-13 preamble for frame detection.

### 5.2 Seed echo

1. Receiver decodes the seed.
2. Receiver echoes the same 64 bytes back in robust mode.
3. Sender verifies the echo matches.
4. If mismatch or timeout → sender retransmits (same seed, incremented turn counter).

### 5.3 Challenge-response verification

1. Both sides derive a 512-byte test block from: `PRNG(seed || turn_number)`.
2. The turn number is a monotonically increasing counter starting at 0.
3. On retries, the turn number increments, producing different test data from the same seed. This means the channel is tested with different frequency patterns each attempt.
4. Sender transmits the 512-byte block in robust mode.
5. Receiver verifies against its own locally-generated copy.
6. Receiver echoes the block back as confirmation.

### 5.4 PRNG specification

- Algorithm: `xoshiro256**` seeded from the 64-byte seed via SHA-256.
- Input to SHA-256: `seed (64 bytes) || turn_number (4 bytes, little-endian)`.
- The SHA-256 output (32 bytes) seeds the four 64-bit state words of xoshiro256**.
- 512 bytes are generated by calling the PRNG 64 times (8 bytes per call).

**Why xoshiro256\*\* and not a CSPRNG?** Speed. The seed itself is cryptographically random, and the PRNG output is only used for channel testing — not for security. xoshiro256** is fast, has excellent statistical properties, and is trivial to implement (~20 lines).

---

## 6. Hash chirp integrity monitor

During fast-mode data transfer, the receiver periodically sends a **hash chirp** back to the sender in robust mode. This is the ongoing integrity check.

### 6.1 Mechanism

- Every ~1 second, the receiver computes a hash over all data bytes it has successfully decoded in the last 1-second window.
- Hash: truncated SHA-256 (first 8 bytes) of the received data window.
- The receiver transmits this 8-byte hash as a robust-mode frame.
- The sender independently computes the same hash over the data it sent in that window.

### 6.2 Outcomes

| Sender comparison | Action |
|-------------------|--------|
| Hash matches      | Continue fast transfer |
| Hash mismatch     | Retransmit the affected 1-second window |
| No hash received within 2 seconds | Retransmit last window |
| 3 consecutive mismatches | Trigger autotune (re-run discovery/handshake) |
| 5 consecutive mismatches | Abort transfer, report error |

### 6.3 Timing

- Hash chirps are sent in robust mode, which takes ~2–3 seconds for an 8-byte payload.
- During hash chirp transmission, the sender continues fast-mode data on non-overlapping frequencies.
- The robust-mode hash chirp uses a reserved frequency band (e.g., 1–3 kHz) that is excluded from the OFDM subcarrier allocation during hash windows.

### 6.4 Window tracking

- Both sides maintain a sliding window counter aligned to sequence numbers.
- Window N covers sequence numbers `[N*window_size .. (N+1)*window_size - 1]`.
- The hash chirp frame includes the window number so both sides agree on what's being hashed.

---

## 7. Autotune

When 3 consecutive hash chirps fail, the protocol assumes the acoustic channel has degraded (someone opened a window, moved a laptop, etc.).

Autotune procedure:
1. Sender pauses fast-mode transfer.
2. Sender re-broadcasts a chirp probe (same as initial discovery).
3. Receiver responds with updated capability report.
4. Sender recalculates OFDM parameters (may reduce modulation order, drop noisy subcarriers).
5. Both sides resume fast transfer with new parameters.
6. Sequence numbers continue from where they left off — no data is lost, only retransmitted.

---

## 8. Simplex fallback

When the sender has no microphone or the receiver has no speakers:
- All data is sent in robust mode with 3× redundancy (each frame sent 3 times).
- No hash chirps are possible — integrity relies entirely on per-frame CRC-32 + RS FEC.
- No autotune is possible.
- The receiver deduplicates by sequence number and discards corrupted frames.

---

## 9. Target implementation

| Phase | Platform | Scope |
|-------|----------|-------|
| MVP   | JavaScript (browser) | Robust mode only: seed handshake + data transfer via FSK |
| v0.2  | JavaScript | Add OFDM fast mode + hash chirp monitor |
| v0.3  | Rust → WASM | Port DSP hot path (FFT, Goertzel, RS codec, PRNG) |
| v1.0  | Rust → WASM + JS glue | Full protocol with autotune |

---

## 10. Non-goals

- Encryption (out of scope; layer on top if needed)
- Multi-device broadcast (1:1 only)
- Operation in high-noise environments (airports, concerts, etc.)
- Inaudible/ultrasonic-only operation (sacrifices too much bandwidth)
- Streaming audio (this is a file/blob transfer protocol)
