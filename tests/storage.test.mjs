import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../server.mjs';

test('practice recording is stored as a local library file and survives a directory migration', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'easyinput-storage-'));
  const first = join(workspace, 'first');
  const second = join(workspace, 'second');
  const app = createWebServer({ status: () => ({}) }, { port: 0, libraryDirectory: first });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const bytes = Buffer.from('RIFF-sample-take');
  try {
    const upload = await fetch(`${origin}/api/recordings`, {
      method: 'POST', headers: { 'content-type': 'audio/wav', 'x-lesson-id': 'psychology-course', 'x-sentence-index': '2', 'x-record-device': 'browser' }, body: bytes,
    });
    assert.equal(upload.status, 200);
    const item = (await upload.json()).item;
    assert.equal(item.materialKind, 'practice-take');
    assert.equal(item.sentenceIndex, 2);
    const migrate = await fetch(`${origin}/api/library/migrate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destination: second }),
    });
    assert.equal(migrate.status, 200);
    assert.equal((await migrate.json()).moved, 1);
    const usage = await fetch(`${origin}/api/library/usage`).then(response => response.json());
    assert.equal(usage.directory, second);
    const restored = await fetch(`${origin}/api/library/${item.id}/audio`);
    assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
