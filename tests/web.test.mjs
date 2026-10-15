import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebServer } from '../server.mjs';

test('built-in lesson assets are available from the local web server', async () => {
  const bridge = { status: () => ({ micConnected: false, ledConnected: false }) };
  const app = createWebServer(bridge, { port: 0 });
  await app.listen();
  const { port } = app.server.address();
  try {
    const [page, audio, subtitles] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`),
      fetch(`http://127.0.0.1:${port}/demo/five-sentences.wav`),
      fetch(`http://127.0.0.1:${port}/demo/five-sentences.srt`),
    ]);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /按键开始：听原句/);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/wav');
    assert.equal((await audio.arrayBuffer()).byteLength > 44, true);
    assert.equal(subtitles.status, 200);
    assert.match(await subtitles.text(), /Good morning/);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
  }
});
