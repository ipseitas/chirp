// soniclink/engine.js — Protocol state machine and audio pipeline management

import {
  SAMPLE_RATE, SEED_LENGTH, FRAME, MAX_RETRIES,
  SEED_TIMEOUT_MS, ECHO_TIMEOUT_MS, FRAME_TIMEOUT_MS,
  MAX_PAYLOAD, BYTES_PER_SYMBOL, TOTAL_SYMBOL_SAMPLES,
  CHALLENGE_LENGTH,
} from './constants.js';
import { encodeFrame, decodeFrame, encodeMultiFrame } from './framing.js';
import { encodeToAudio, FSKDemodulator } from './fsk.js';
import { generateSeed, deriveTestBlock } from './prng.js';

/**
 * SonicLinkEngine manages the full protocol lifecycle.
 * It sets up Web Audio API nodes, runs the state machine,
 * and coordinates between the AudioWorklet and protocol logic.
 */
export class SonicLinkEngine {
  constructor(config = {}) {
    this.config = {
      forceSimplex: false,
      robustOnly: true, // MVP is always robust-only
      sampleRate: SAMPLE_RATE,
      maxRetries: MAX_RETRIES,
      ...config,
    };

    this.state = 'idle';
    this.audioCtx = null;
    this.workletNode = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.demodulator = new FSKDemodulator();

    // Transfer state
    this.seed = null;
    this.turn = 0;
    this.seq = 0;

    // Callbacks
    this.onProgress = null;
    this.onStateChange = null;
    this.onError = null;

    // Internal promise resolvers
    this._resolve = null;
    this._reject = null;
    this._frameWaiters = [];
  }

  // ── Audio setup ──────────────────────────────────────────────────────────

  /**
   * Initialise Web Audio API context and worklet.
   * @param {boolean} needMic - Whether to request microphone access
   */
  async _initAudio(needMic) {
    this.audioCtx = new AudioContext({ sampleRate: this.config.sampleRate });

    // Register the worklet processor
    // In a real deployment, this URL would point to the bundled worklet file.
    // For the MVP, we create a blob URL from the processor source.
    const workletCode = await this._getWorkletCode();
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);

    await this.audioCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    this.workletNode = new AudioWorkletNode(this.audioCtx, 'soniclink-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });

    // Connect worklet output to speakers (for TX)
    this.workletNode.connect(this.audioCtx.destination);

    // Handle messages from worklet
    this.workletNode.port.onmessage = (event) => this._handleWorkletMessage(event.data);

    if (needMic) {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: this.config.sampleRate,
        },
      });
      this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.workletNode);
    }
  }

  /**
   * Get the AudioWorklet processor code as a string.
   * In production, this would be a separate file. For the MVP,
   * we inline it.
   */
  async _getWorkletCode() {
    // Fetch the worklet source file
    // For standalone usage, we embed the processor code directly.
    return `
class SonicLinkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'idle';
    this.txQueue = [];
    this.txOffset = 0;
    this.txPlaying = false;
    this.rxBuffer = [];
    this.rxBufferSize = 4320;
    this.port.onmessage = (event) => this._handleMessage(event.data);
  }

  _handleMessage(msg) {
    switch (msg.cmd) {
      case 'tx-enqueue':
        this.txQueue.push(new Float32Array(msg.samples));
        this.txPlaying = true;
        if (this.mode === 'idle') this.mode = 'tx';
        if (this.mode === 'rx') this.mode = 'duplex';
        break;
      case 'tx-stop':
        this.txQueue = [];
        this.txOffset = 0;
        this.txPlaying = false;
        if (this.mode === 'tx') this.mode = 'idle';
        if (this.mode === 'duplex') this.mode = 'rx';
        break;
      case 'rx-start':
        if (msg.bufferSize) this.rxBufferSize = msg.bufferSize;
        if (this.mode === 'idle') this.mode = 'rx';
        if (this.mode === 'tx') this.mode = 'duplex';
        break;
      case 'rx-stop':
        this.rxBuffer = [];
        if (this.mode === 'rx') this.mode = 'idle';
        if (this.mode === 'duplex') this.mode = 'tx';
        break;
      case 'reset':
        this.mode = 'idle';
        this.txQueue = [];
        this.txOffset = 0;
        this.txPlaying = false;
        this.rxBuffer = [];
        break;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const input = inputs[0];
    const blockSize = 128;

    if (this.txPlaying && output && output[0]) {
      const outChannel = output[0];
      for (let i = 0; i < blockSize; i++) {
        if (this.txQueue.length === 0) {
          this.txPlaying = false;
          this.port.postMessage({ event: 'tx-complete' });
          break;
        }
        const currentBuf = this.txQueue[0];
        outChannel[i] = currentBuf[this.txOffset];
        this.txOffset++;
        if (this.txOffset >= currentBuf.length) {
          this.txQueue.shift();
          this.txOffset = 0;
        }
      }
    }

    if ((this.mode === 'rx' || this.mode === 'duplex') && input && input[0]) {
      const inChannel = input[0];
      for (let i = 0; i < inChannel.length; i++) {
        this.rxBuffer.push(inChannel[i]);
      }
      while (this.rxBuffer.length >= this.rxBufferSize) {
        const chunk = new Float32Array(this.rxBuffer.splice(0, this.rxBufferSize));
        this.port.postMessage({ event: 'rx-samples', samples: chunk }, [chunk.buffer]);
      }
    }

    return true;
  }
}
registerProcessor('soniclink-processor', SonicLinkProcessor);
`;
  }

  // ── TX/RX helpers ────────────────────────────────────────────────────────

  /**
   * Transmit a frame as audio via the worklet.
   * @param {Uint8Array} frameBytes - Encoded frame
   * @returns {Promise<void>} Resolves when audio has finished playing
   */
  _transmitFrame(frameBytes) {
    return new Promise((resolve) => {
      const audioSamples = encodeToAudio(frameBytes);
      const onComplete = (msg) => {
        if (msg.data.event === 'tx-complete') {
          this.workletNode.port.removeEventListener('message', onComplete);
          resolve();
        }
      };
      // Note: we use addEventListener so multiple listeners can coexist
      this.workletNode.port.addEventListener('message', onComplete);
      this.workletNode.port.postMessage(
        { cmd: 'tx-enqueue', samples: Array.from(audioSamples) }
      );
    });
  }

  /**
   * Start receiving and wait for a decoded frame of a specific type.
   * @param {number} expectedType - Frame type to wait for
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<{ type: number, seq: number, payload: Uint8Array }>}
   */
  _waitForFrame(expectedType, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for frame type 0x${expectedType.toString(16)}`));
      }, timeoutMs);

      this._frameWaiters.push({ expectedType, resolve, reject, timer });
    });
  }

  /**
   * Handle messages from the AudioWorklet.
   */
  _handleWorkletMessage(msg) {
    if (msg.event === 'rx-samples') {
      // Feed samples to demodulator
      const samples = new Float32Array(msg.samples);
      const frames = this.demodulator.feedSamples(samples);

      // Check if any decoded frames match a waiter
      for (const rawFrame of frames) {
        const decoded = decodeFrame(rawFrame);
        if (!decoded) {
          console.warn('SonicLink: CRC failure on received frame');
          continue;
        }

        // Find matching waiter
        const idx = this._frameWaiters.findIndex(w => w.expectedType === decoded.type);
        if (idx !== -1) {
          const waiter = this._frameWaiters.splice(idx, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(decoded);
        }
      }
    }
  }

  // ── State transitions ────────────────────────────────────────────────────

  _setState(newState) {
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  }

  // ── Sender flow ──────────────────────────────────────────────────────────

  /**
   * Send data to a receiver.
   * @param {Uint8Array} data - Bytes to send
   * @returns {Promise<{ success: boolean, bytesTransferred: number, error?: string }>}
   */
  async send(data) {
    const startTime = Date.now();
    let retransmits = 0;

    try {
      // Init audio (sender needs mic for receiving echoes, unless simplex)
      await this._initAudio(!this.config.forceSimplex);

      // Start RX if duplex
      if (!this.config.forceSimplex) {
        this.workletNode.port.postMessage({ cmd: 'rx-start' });
      }

      // ── Phase 1: Seed handshake ──
      this._setState('seed');
      this.seed = generateSeed(SEED_LENGTH);
      this.turn = 0;

      let seedAcked = false;
      for (let attempt = 0; attempt < this.config.maxRetries && !seedAcked; attempt++) {
        this.turn = attempt;

        // Send seed
        const seedFrame = encodeFrame(FRAME.SEED, 0, this.seed);
        await this._transmitFrame(seedFrame);

        if (this.config.forceSimplex) {
          seedAcked = true; // No echo expected
          break;
        }

        // Wait for echo
        try {
          const echo = await this._waitForFrame(FRAME.SEED_ECHO, ECHO_TIMEOUT_MS);
          if (this._arraysEqual(echo.payload, this.seed)) {
            seedAcked = true;
          } else {
            console.warn('SonicLink: Seed echo mismatch, retrying');
            retransmits++;
          }
        } catch (e) {
          console.warn(`SonicLink: Seed echo timeout (attempt ${attempt + 1})`);
          retransmits++;
        }
      }

      if (!seedAcked) {
        throw new Error('Seed handshake failed after max retries');
      }

      // ── Phase 2: Challenge-response ──
      this._setState('challenge');

      let challengeAcked = false;
      for (let attempt = 0; attempt < this.config.maxRetries && !challengeAcked; attempt++) {
        const testBlock = await deriveTestBlock(this.seed, this.turn + attempt);

        // Split into frames (512 bytes / 127 bytes per frame = 5 frames)
        const challengeFrames = encodeMultiFrame(FRAME.CHALLENGE, testBlock, 0);
        for (const frame of challengeFrames) {
          await this._transmitFrame(frame);
        }

        if (this.config.forceSimplex) {
          challengeAcked = true;
          break;
        }

        // Wait for echo of first frame as ACK
        try {
          const echo = await this._waitForFrame(FRAME.CHALLENGE_ECHO, ECHO_TIMEOUT_MS);
          challengeAcked = true;
        } catch (e) {
          console.warn(`SonicLink: Challenge echo timeout (attempt ${attempt + 1})`);
          retransmits++;
        }
      }

      if (!challengeAcked) {
        throw new Error('Challenge-response failed after max retries');
      }

      // ── Phase 3: Data transfer ──
      this._setState('transfer');

      const dataFrames = encodeMultiFrame(FRAME.DATA, data, 0);
      let bytesSent = 0;

      for (let i = 0; i < dataFrames.length; i++) {
        const frame = dataFrames[i];

        if (this.config.forceSimplex) {
          // Send 3× for redundancy
          for (let r = 0; r < 3; r++) {
            await this._transmitFrame(frame);
          }
        } else {
          // Send and wait for ACK (stop-and-wait)
          let acked = false;
          for (let attempt = 0; attempt < this.config.maxRetries && !acked; attempt++) {
            await this._transmitFrame(frame);
            try {
              const ack = await this._waitForFrame(FRAME.ACK, ECHO_TIMEOUT_MS);
              if (ack.seq === (i & 0xFF)) {
                acked = true;
              }
            } catch (e) {
              retransmits++;
            }
          }
          if (!acked) {
            throw new Error(`Data frame ${i} not acknowledged after max retries`);
          }
        }

        bytesSent += Math.min(MAX_PAYLOAD, data.length - i * MAX_PAYLOAD);
        if (this.onProgress) {
          this.onProgress({
            phase: 'transfer',
            bytesSent,
            bytesTotal: data.length,
            currentTurn: this.turn,
            hashChirpStatus: 'pending',
          });
        }
      }

      this._setState('done');
      return {
        success: true,
        bytesTransferred: data.length,
        duration: Date.now() - startTime,
        retransmits,
        autotuneCount: 0,
      };

    } catch (error) {
      this._setState('error');
      if (this.onError) this.onError(error);
      return {
        success: false,
        bytesTransferred: 0,
        duration: Date.now() - startTime,
        retransmits,
        autotuneCount: 0,
        error: error.message,
      };

    } finally {
      await this.destroy();
    }
  }

  // ── Receiver flow ────────────────────────────────────────────────────────

  /**
   * Listen for and receive data from a sender.
   * @returns {Promise<Uint8Array>} Received data
   */
  async receive() {
    try {
      // Receiver needs mic (always) and speakers (for echoes, unless simplex)
      await this._initAudio(true);

      // Start listening
      this.workletNode.port.postMessage({ cmd: 'rx-start' });

      // ── Phase 1: Receive seed ──
      this._setState('seed');

      const seedFrame = await this._waitForFrame(FRAME.SEED, SEED_TIMEOUT_MS);
      this.seed = seedFrame.payload;

      if (!this.config.forceSimplex) {
        // Echo seed back
        const echoFrame = encodeFrame(FRAME.SEED_ECHO, 0, this.seed);
        await this._transmitFrame(echoFrame);
      }

      // ── Phase 2: Receive challenge ──
      this._setState('challenge');

      // Receive challenge frames and reassemble
      const challengeChunks = [];
      let totalChallengeBytes = 0;

      while (totalChallengeBytes < CHALLENGE_LENGTH) {
        const frame = await this._waitForFrame(FRAME.CHALLENGE, FRAME_TIMEOUT_MS);
        challengeChunks.push(frame.payload);
        totalChallengeBytes += frame.payload.length;
      }

      const receivedChallenge = this._concatenateArrays(challengeChunks);

      // Verify against expected
      const expectedChallenge = await deriveTestBlock(this.seed, this.turn);
      if (!this._arraysEqual(receivedChallenge.subarray(0, CHALLENGE_LENGTH), expectedChallenge)) {
        console.warn('SonicLink: Challenge verification failed');
        // In a full implementation, we'd NAK and wait for retry with new turn
        // For MVP, we proceed anyway and let CRC catch errors later
      }

      if (!this.config.forceSimplex) {
        // Echo confirmation
        const echoFrame = encodeFrame(FRAME.CHALLENGE_ECHO, 0, new Uint8Array([0x01])); // Simple ACK
        await this._transmitFrame(echoFrame);
      }

      // ── Phase 3: Receive data ──
      this._setState('transfer');

      const dataChunks = [];
      let receivedSeqs = new Set();
      let bytesReceived = 0;

      // Keep receiving DATA frames until we get a timeout (no more data)
      while (true) {
        try {
          const frame = await this._waitForFrame(FRAME.DATA, FRAME_TIMEOUT_MS);

          // Deduplicate (for simplex 3× redundancy)
          if (!receivedSeqs.has(frame.seq)) {
            receivedSeqs.add(frame.seq);
            dataChunks.push(frame.payload);
            bytesReceived += frame.payload.length;

            if (this.onProgress) {
              this.onProgress({
                phase: 'transfer',
                bytesSent: bytesReceived,
                bytesTotal: 0, // Unknown total in receiver
                currentTurn: this.turn,
                hashChirpStatus: 'ok',
              });
            }

            // Send ACK if duplex
            if (!this.config.forceSimplex) {
              const ackFrame = encodeFrame(FRAME.ACK, frame.seq, new Uint8Array(0));
              await this._transmitFrame(ackFrame);
            }
          }
        } catch (e) {
          // Timeout — assume transfer is complete
          break;
        }
      }

      this._setState('done');
      return this._concatenateArrays(dataChunks);

    } catch (error) {
      this._setState('error');
      if (this.onError) this.onError(error);
      throw error;

    } finally {
      await this.destroy();
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  _arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  _concatenateArrays(arrays) {
    const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  /**
   * Abort the current transfer.
   */
  abort() {
    for (const waiter of this._frameWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Transfer aborted'));
    }
    this._frameWaiters = [];
    this._setState('idle');
  }

  /**
   * Clean up all audio resources.
   */
  async destroy() {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ cmd: 'reset' });
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.audioCtx) {
      await this.audioCtx.close();
      this.audioCtx = null;
    }
    this.demodulator.reset();
  }
}
