const MAGIC = {
  heartbeat: 'EIHB',
  audio: 'EIAU',
  ack: 'EICA',
};

export function parseHeartbeat(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 20 || packet.toString('ascii', 0, 4) !== MAGIC.heartbeat || packet[4] !== 1) return null;
  return {
    streaming: Boolean(packet[5] & 1),
    audioReady: Boolean(packet[5] & 2),
    sessionId: packet.readBigUInt64LE(8),
    sequence: packet.readUInt32LE(16),
  };
}

export function parseAudio(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 32 || packet.toString('ascii', 0, 4) !== MAGIC.audio || packet[4] !== 2 || packet[5] !== 32 || packet[6] !== 1 || packet[7] !== 1) return null;
  const payloadBytes = packet.readUInt16LE(30);
  const samples = packet.readUInt16LE(28);
  const sampleRate = packet.readUInt32LE(20);
  if (sampleRate !== 16000 || samples === 0 || payloadBytes !== samples * 2 || packet.length !== 32 + payloadBytes) return null;
  return {
    sessionId: packet.readBigUInt64LE(8),
    sequence: packet.readUInt32LE(16),
    timestampMs: packet.readUInt32LE(24),
    samples,
    pcm: packet.subarray(32),
  };
}

export function parseAck(packet) {
  if (!Buffer.isBuffer(packet) || packet.length !== 20 || packet.toString('ascii', 0, 4) !== MAGIC.ack || packet[4] !== 1) return null;
  return { action: packet[5], status: packet[6], sessionId: packet.readBigUInt64LE(8), sequence: packet.readUInt32LE(16) };
}

export function encodeControl(action, sessionId, sequence) {
  if (![1, 2, 3].includes(action) || typeof sessionId !== 'bigint' || sessionId === 0n) throw new Error('Invalid audio control command');
  const packet = Buffer.alloc(36);
  packet.write('EICC', 0, 'ascii');
  packet[4] = 1;
  packet[5] = action;
  packet.writeBigUInt64LE(sessionId, 8);
  packet.writeUInt32LE(sequence >>> 0, 16);
  return packet;
}

export function encodeLevel(level, sequence) {
  const packet = Buffer.alloc(12);
  packet.write('EILM', 0, 'ascii');
  packet[4] = 1;
  packet[5] = Math.max(0, Math.min(255, Math.round(level)));
  packet.writeUInt32LE(sequence >>> 0, 8);
  return packet;
}

export function wavFromPcm(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) throw new Error('PCM16 data required');
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}
