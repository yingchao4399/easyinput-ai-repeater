import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardBridge } from '../server.mjs';

function bind(socket) { return new Promise(resolve => socket.bind(0, '127.0.0.1', resolve)); }
function send(socket, bytes, port) { return new Promise((resolve, reject) => socket.send(bytes, port, '127.0.0.1', error => error ? reject(error) : resolve())); }
function heartbeat() { const bytes = Buffer.alloc(20); bytes.write('EIHB'); bytes[4] = 1; bytes[5] = 2; return bytes; }
function audio(sessionId, sequence, value) {
  const bytes = Buffer.alloc(672);
  bytes.write('EIAU'); bytes[4] = 2; bytes[5] = 32; bytes[6] = 1; bytes[7] = 1;
  bytes.writeBigUInt64LE(sessionId, 8); bytes.writeUInt32LE(sequence, 16);
  bytes.writeUInt32LE(16000, 20); bytes.writeUInt16LE(320, 28); bytes.writeUInt16LE(640, 30);
  bytes.fill(value, 32); return bytes;
}

test('simulated board completes heartbeat → control ack → audio → WAV and LED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'easyinput-repeater-'));
  const bridge = new BoardBridge({ micPort: 0, ledPort: 0, recordingsDir: dir });
  const board = createSocket('udp4');
  let ledPacket;
  try {
    await bridge.start(); await bind(board);
    const micPort = bridge.mic.address().port;
    const ledPort = bridge.led.address().port;
    board.on('message', (packet, from) => {
      if (packet.toString('ascii', 0, 4) === 'EILM') { ledPacket = packet; return; }
      if (packet.toString('ascii', 0, 4) !== 'EICC') return;
      const ack = Buffer.alloc(20);
      ack.write('EICA'); ack[4] = 1; ack[5] = packet[5];
      packet.copy(ack, 8, 8, 20);
      board.send(ack, from.port, from.address);
      if (packet[5] === 1) {
        const sessionId = packet.readBigUInt64LE(8);
        board.send(audio(sessionId, 1, 17), from.port, from.address);
        board.send(audio(sessionId, 3, 34), from.port, from.address);
      }
    });
    await send(board, heartbeat(), micPort);
    await send(board, heartbeat(), ledPort);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(bridge.status().micConnected, true);
    assert.equal(bridge.status().ledConnected, true);
    await bridge.beginRecord();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(bridge.status().packets, 2);
    const result = await bridge.endRecord();
    assert.equal(result.latest.packets, 2);
    assert.equal(result.latest.gaps, 1);
    const wav = await readFile(bridge.latest.path);
    assert.equal(wav.readUInt32LE(40), 1920);
    assert.equal(wav[44], 17);
    assert.equal(wav[44 + 640], 0);
    assert.equal(wav[44 + 1280], 34);
    bridge.setLedState('weak');
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(ledPacket?.toString('ascii', 0, 4), 'EILM');
  } finally {
    bridge.close(); board.close(); await rm(dir, { recursive: true, force: true });
  }
});
