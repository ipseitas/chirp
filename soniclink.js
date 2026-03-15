// soniclink/soniclink.js — Public API entry point

import { SonicLinkEngine } from './engine.js';

/**
 * SonicLink — Acoustic data transfer protocol.
 *
 * Transfers arbitrary bytes between two devices via speaker-to-microphone audio.
 * Uses multi-tone FSK modulation with seed-based handshake and CRC-32 error detection.
 *
 * @example
 * // Sender
 * const link = new SonicLink();
 * link.onProgress = (p) => console.log(`${p.bytesSent}/${p.bytesTotal}`);
 * const result = await link.send(new TextEncoder().encode('Hello, world!'));
 *
 * // Receiver (on another device/tab)
 * const link = new SonicLink();
 * const data = await link.receive();
 * console.log(new TextDecoder().decode(data));
 */
export class SonicLink {
  /**
   * @param {Object} config
   * @param {boolean} [config.forceSimplex=false] - Assume no back-channel (no echoes/ACKs)
   * @param {boolean} [config.robustOnly=true]    - Only use robust (FSK) mode (MVP default)
   * @param {number}  [config.sampleRate=48000]   - Audio sample rate
   * @param {number}  [config.maxRetries=3]       - Max retries per handshake phase
   */
  constructor(config = {}) {
    this._engine = new SonicLinkEngine(config);

    /**
     * Progress callback.
     * @type {function({ phase, bytesSent, bytesTotal, currentTurn, hashChirpStatus }): void}
     */
    this.onProgress = null;

    /**
     * State change callback.
     * @type {function(string): void}
     */
    this.onStateChange = null;

    /**
     * Error callback.
     * @type {function(Error): void}
     */
    this.onError = null;
  }

  /**
   * Send data to a listening receiver.
   *
   * Must be called from a user gesture (click/tap) to satisfy browser autoplay policy.
   *
   * @param {Uint8Array} data - Bytes to transfer
   * @returns {Promise<{ success: boolean, bytesTransferred: number, duration: number, retransmits: number, error?: string }>}
   */
  async send(data) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError('data must be a Uint8Array');
    }
    if (data.length === 0) {
      throw new Error('Cannot send empty data');
    }

    this._engine.onProgress = this.onProgress;
    this._engine.onStateChange = this.onStateChange;
    this._engine.onError = this.onError;

    return this._engine.send(data);
  }

  /**
   * Listen for incoming data from a sender.
   *
   * Will request microphone permission.
   *
   * @returns {Promise<Uint8Array>} Received bytes
   */
  async receive() {
    this._engine.onProgress = this.onProgress;
    this._engine.onStateChange = this.onStateChange;
    this._engine.onError = this.onError;

    return this._engine.receive();
  }

  /**
   * Abort the current send or receive operation.
   */
  abort() {
    this._engine.abort();
  }

  /**
   * Release all audio resources.
   * Call this when done to free the microphone and audio context.
   */
  async destroy() {
    await this._engine.destroy();
  }

  /**
   * Get the current protocol state.
   * @returns {string} One of: idle, seed, challenge, transfer, done, error
   */
  get state() {
    return this._engine.state;
  }
}

// Default export
export default SonicLink;
