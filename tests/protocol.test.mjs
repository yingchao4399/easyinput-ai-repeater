import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeControl, encodeLevel, parseAck, parseAudio, parseHeartbeat, wavFromPcm } from '../lib/protocol.mjs';
import { parseSrt } from '../lib/srt.mjs';

test('firmware control and LED wire formats match offsets', () => {
  const command = encodeControl(1, 42n, 7);
  assert.equal(command.length, 36);
  assert.equal(command.toString('ascii', 0, 4), 'EICC');
  assert.equal(command[4], 1);
  assert.equal(command[5], 1);
  assert.equal(command.readBigUInt64LE(8), 42n);
  assert.equal(command.readUInt32LE(16), 7);
  const level = encodeLevel(230, 4);
  assert.equal(level.length, 12);
  assert.equal(level.toString('ascii', 0, 4), 'EILM');
  assert.equal(level[5], 230);
  assert.equal(level.readUInt32LE(8), 4);
});

test('heartbeat, acknowledgement and audio reject incompatible frames', () => {
  const heartbeat = Buffer.alloc(20);
  heartbeat.write('EIHB'); heartbeat[4] = 1; heartbeat[5] = 2;
  assert.equal(parseHeartbeat(heartbeat).audioReady, true);
  heartbeat[4] = 2;
  assert.equal(parseHeartbeat(heartbeat), null);
  const ack = Buffer.alloc(20);
  ack.write('EICA'); ack[4] = 1; ack[5] = 1; ack.writeBigUInt64LE(42n, 8);
  assert.equal(parseAck(ack).sessionId, 42n);
  const audio = Buffer.alloc(672);
  audio.write('EIAU'); audio[4] = 2; audio[5] = 32; audio[6] = 1; audio[7] = 1;
  audio.writeBigUInt64LE(42n, 8); audio.writeUInt32LE(16000, 20);
  audio.writeUInt16LE(320, 28); audio.writeUInt16LE(640, 30);
  assert.equal(parseAudio(audio).pcm.length, 640);
  audio.writeUInt16LE(638, 30);
  assert.equal(parseAudio(audio), null);
});

test('PCM becomes a playable mono 16 kHz WAV and captions remain ordered', () => {
  const wav = wavFromPcm(Buffer.alloc(640));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 640);
  const captions = parseSrt('2\n00:00:02,000 --> 00:00:03,000\nSecond\n\n1\n00:00:00,000 --> 00:00:01,500\n<b>First</b>');
  assert.deepEqual(captions.map(x => x.text), ['First', 'Second']);
});
