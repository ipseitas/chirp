// soniclink/audio-worklet.js — AudioWorkletProcessor for real-time audio I/O
//
// This file runs in AudioWorkletGlobalScope (separate thread).
// It handles:
//   TX: Playing queued audio buffers to the speaker
//   RX: Capturing mic samples and posting them to the main thread
//
// Communication with main thread is via MessagePort.

class SonicLinkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.mode = 'idle';  // 'idle' | 'tx' | 'rx' | 'duplex'

    // TX state
    this.txQueue = [];       // Array of Float32Array buffers to play
    this.txOffset = 0;       // Current position in current buffer
    this.txPlaying = false;

    // RX state
    this.rxBuffer = [];       // Accumulated samples to send to main thread
    this.rxBufferSize = 4320; // Send every symbol period (~90ms at 48kHz)

    this.port.onmessage = (event) => this._handleMessage(event.data);
  }

  _handleMessage(msg) {
    switch (msg.cmd) {
      case 'tx-enqueue':
        // Add audio buffer to TX queue
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
    const blockSize = 128; // AudioWorklet render quantum

    // ── TX: write queued audio to output ──
    if (this.txPlaying && output && output[0]) {
      const outChannel = output[0];

      for (let i = 0; i < blockSize; i++) {
        if (this.txQueue.length === 0) {
          // No more data to play
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

    // ── RX: capture input samples ──
    if ((this.mode === 'rx' || this.mode === 'duplex') && input && input[0]) {
      const inChannel = input[0];

      for (let i = 0; i < inChannel.length; i++) {
        this.rxBuffer.push(inChannel[i]);
      }

      // Send accumulated samples when we have enough
      while (this.rxBuffer.length >= this.rxBufferSize) {
        const chunk = new Float32Array(this.rxBuffer.splice(0, this.rxBufferSize));
        this.port.postMessage(
          { event: 'rx-samples', samples: chunk },
          [chunk.buffer]  // Transfer ownership for zero-copy
        );
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor('soniclink-processor', SonicLinkProcessor);
