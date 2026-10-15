import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planLesson, searchOpenverseAudio, downloadOpenverseAudio, englishSearchQuery } from '../lib/coach.mjs';
import { createWebServer } from '../server.mjs';

test('course planner authenticates to the selected model and validates generated teaching material', async () => {
  let request;
  const plan = await planLesson({
    provider: 'deepseek', model: 'deepseek-chat', apiKey: 'secret-test', goal: 'hardware support calls', level: '初中级', minutes: 10,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Support English', sentences: [
        { text: 'Could you restart the device?', translation: '你能重启设备吗？', focus: '重读 restart' },
        { text: 'The status light is blinking.', translation: '状态灯正在闪烁。', focus: '连读 is blinking' },
        { text: 'I will check the connection.', translation: '我会检查连接。', focus: '弱读 will' },
      ] }) } }] });
    },
  });
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-test');
  assert.equal(plan.sentences.length, 3);
  assert.equal(plan.sentences[0].focus, '重读 restart');
  assert.equal(JSON.stringify(plan).includes('secret-test'), false);
});

test('Openverse results retain source and license attribution and downloads reject arbitrary hosts', async () => {
  const results = await searchOpenverseAudio('English conversation', { fetchImpl: async () => Response.json({ results: [{
    id: 17, title: 'Short dialogue.mp3', creator: 'A. Teacher', license: 'by', license_version: '4.0',
    foreign_landing_url: 'https://freesound.org/s/17', url: 'https://cdn.freesound.org/previews/17/17.mp3', duration: 12,
  }] }) });
  assert.equal(results[0].canImport, true);
  assert.equal(results[0].sourceUrl, 'https://freesound.org/s/17');
  await assert.rejects(downloadOpenverseAudio('https://127.0.0.1/private.wav'), /允许的素材来源/);
});

test('Chinese learning topics get a local English search fallback without a teaching model', async () => {
  const query = await englishSearchQuery('普通心理学英语口语');
  assert.match(query, /general psychology/i);
  assert.match(query, /English speaking/i);
  assert.doesNotMatch(query, /普通心理学/);
});

test('coach API searches, imports, and serves a licensed audio material from the local library', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easyinput-coach-'));
  const audio = Buffer.from('test audio bytes');
  const bridge = { status: () => ({ micConnected: false, ledConnected: false }) };
  const app = createWebServer(bridge, {
    port: 0, libraryDirectory: directory,
    audioSearchFetch: async () => Response.json({ results: [{
      id: 'audio-1', title: 'Practice audio.mp3', creator: 'Trainer', license: 'by', license_version: '4.0',
      foreign_landing_url: 'https://freesound.org/s/1', url: 'https://cdn.freesound.org/previews/1/practice.mp3', duration: 8,
    }] }),
    audioDownloadFetch: async () => new Response(audio, { headers: { 'content-type': 'audio/mpeg' } }),
  });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const searchResponse = await post('/api/materials/search', { query: 'English at work' });
    assert.equal(searchResponse.status, 200);
    const candidate = (await searchResponse.json()).results[0];
    const importResponse = await post('/api/materials/import', { candidateId: candidate.candidateId });
    assert.equal(importResponse.status, 200);
    const imported = (await importResponse.json()).item;
    assert.equal(imported.license, 'by');
    assert.equal(imported.creator, 'Trainer');
    const listing = await fetch(`${origin}/api/library`).then(response => response.json());
    assert.equal(listing.length, 1);
    assert.equal(listing[0].id, imported.id);
    const audioResponse = await fetch(`${origin}/api/library/${imported.id}/audio`);
    assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), audio);
    assert.equal((await readFile(join(directory, 'library.json'), 'utf8')).includes('freesound.org'), true);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('publishing a lesson stores English voice files and links them to sentence practice', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easyinput-voice-'));
  const app = createWebServer({ status: () => ({}) }, { port: 0, libraryDirectory: directory });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const response = await fetch(`${origin}/api/coach/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: { title: 'Psychology practice', sentences: [
        { text: 'Memory helps us learn.', translation: '记忆帮助我们学习。' },
        { text: 'I can describe my feelings.', translation: '我可以描述自己的感受。' },
      ] } }),
    });
    assert.equal(response.status, 200);
    const published = await response.json();
    assert.equal(published.audioWarning, '');
    assert.equal(published.audioItems.length, 2);
    const savedPlan = await fetch(`${origin}/api/library/${published.item.id}/audio`).then(reply => reply.json());
    assert.deepEqual(savedPlan.audioIds, published.audioItems.map(item => item.id));
    const audio = await fetch(`${origin}/api/library/${savedPlan.audioIds[0]}/audio`);
    assert.equal(audio.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await audio.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
    const listing = await fetch(`${origin}/api/library`).then(reply => reply.json());
    assert.equal(listing.filter(item => item.materialKind === 'lesson-audio').length, 2);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
