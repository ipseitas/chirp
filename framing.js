// soniclink/framing.js — CRC-32 and frame encode/decode

import { MAX_PAYLOAD } from './constants.js';

// ── CRC-32 (ISO-HDLC, polynomial 0xEDB88320 reflected) ────────────────────

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c;
}

export function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Frame structure ────────────────────────────────────────────────────────
//
//  [type: 1 byte] [length: 2 bytes LE] [seq: 1 byte] [payload: 0..127 bytes] [crc32: 4 bytes]
//
//  Total overhead: 8 bytes (4 header + 4 CRC)

/**
 * Encode a frame into a byte array.
 * @param {number} type - Frame type constant
 * @param {number} seq - Sequence number 0-255
 * @param {Uint8Array} payload - Payload bytes (max 127)
 * @returns {Uint8Array} Encoded frame
 */
export function encodeFrame(type, seq, payload) {
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`Payload too large: ${payload.length} > ${MAX_PAYLOAD}`);
  }

  const frameLen = 4 + payload.length + 4; // header + payload + crc
  const frame = new Uint8Array(frameLen);

  // Header
  frame[0] = type & 0xFF;
  frame[1] = payload.length & 0xFF;         // length low byte
  frame[2] = (payload.length >> 8) & 0xFF;  // length high byte
  frame[3] = seq & 0xFF;

  // Payload
  frame.set(payload, 4);

  // CRC-32 over header + payload
  const crc = crc32(frame.subarray(0, 4 + payload.length));
  frame[4 + payload.length]     = crc & 0xFF;
  frame[4 + payload.length + 1] = (crc >> 8) & 0xFF;
  frame[4 + payload.length + 2] = (crc >> 16) & 0xFF;
  frame[4 + payload.length + 3] = (crc >> 24) & 0xFF;

  return frame;
}

/**
 * Decode a frame from a byte array. Returns null if CRC fails.
 * @param {Uint8Array} data - Raw frame bytes
 * @returns {{ type: number, seq: number, payload: Uint8Array } | null}
 */
export function decodeFrame(data) {
  if (data.length < 8) return null; // Minimum frame: 4 header + 0 payload + 4 CRC

  const type = data[0];
  const length = data[1] | (data[2] << 8);
  const seq = data[3];

  if (length > MAX_PAYLOAD) return null;
  if (data.length < 4 + length + 4) return null;

  // Verify CRC
  const payloadEnd = 4 + length;
  const expectedCrc = crc32(data.subarray(0, payloadEnd));
  const actualCrc = (data[payloadEnd]) |
                    (data[payloadEnd + 1] << 8) |
                    (data[payloadEnd + 2] << 16) |
                    (data[payloadEnd + 3] << 24);

  if ((expectedCrc >>> 0) !== (actualCrc >>> 0)) return null;

  return {
    type,
    seq,
    payload: data.slice(4, payloadEnd),
  };
}

/**
 * Split a large payload into multiple frames.
 * @param {number} type - Frame type
 * @param {Uint8Array} data - Full payload
 * @param {number} startSeq - Starting sequence number
 * @returns {Uint8Array[]} Array of encoded frames
 */
export function encodeMultiFrame(type, data, startSeq = 0) {
  const frames = [];
  let offset = 0;
  let seq = startSeq;

  while (offset < data.length) {
    const chunkLen = Math.min(MAX_PAYLOAD, data.length - offset);
    const chunk = data.slice(offset, offset + chunkLen);
    frames.push(encodeFrame(type, seq & 0xFF, chunk));
    offset += chunkLen;
    seq++;
  }

  return frames;
}
