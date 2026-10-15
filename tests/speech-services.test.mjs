import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCloudSpeech, generateYovoiceSpeech, transcribeCloudSpeech, yovoiceBaseUrl, yovoiceCatalog } from '../lib/speech-services.mjs';
import { createWebServer } from '../server.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Yovoice connection reads the installed model and saved voice through local authenticated API', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, authorization: options.headers.Authorization });
    if (url.endsWith('/v1/status')) return Response.json({ ready: true });
    if (url.endsWith('/v1/models')) return Response.json({ models: [{ id: 'index-2.5-q8', name: 'IndexTTS 2.5' }] });
    return Response.json({ voices: [{ id: 'voice-1', name: 'Voice 1' }] });
  };
  const result = await yovoiceCatalog({ endpoint: 'http://127.0.0.1:8080', token: 'test-token' }, fetchImpl);
  assert.equal(result.models[0].id, 'index-2.5-q8');
  assert.equal(result.voices[0].id, 'voice-1');
  assert.ok(requests.every(item => item.authorization === 'Bearer test-token'));
  assert.throws(() => yovoiceBaseUrl('https://example.com'), /仅允许本机/);
});

test('Yovoice generates each lesson sentence sequentially as WAV with selected model and voice', async () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(48)]);
  const submitted = [];
  const fetchImpl = async (url, options) => {
    if (options.method === 'PUT') { submitted.push(JSON.parse(options.body)); return Response.json({ status: 'running' }); }
    if (url.includes('/v1/jobs/')) return Response.json({ status: 'completed', audio: { id: `audio-${submitted.length}` } });
    if (url.includes('/v1/audio/')) return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
    throw new Error('Unexpected request');
  };
  const files = await generateYovoiceSpeech([{ text: 'Good morning.' }, { text: 'How are you?' }], {
    endpoint: 'http://127.0.0.1:8080', token: 'test-token', modelId: 'index-2.5-q8', voiceId: 'voice-1',
  }, fetchImpl, async () => {});
  assert.equal(files.length, 2);
  assert.deepEqual(submitted.map(item => item.text), ['Good morning.', 'How are you?']);
  assert.ok(submitted.every(item => item.modelId === 'index-2.5-q8' && item.voiceId === 'voice-1'));
});

test('course publish saves Yovoice speech in practice without storing the API token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easyinput-yovoice-'));
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(48)]);
  const speechFetch = async (url, options) => {
    if (options.method === 'PUT') return Response.json({ status: 'running' });
    if (url.includes('/v1/jobs/')) return Response.json({ status: 'completed', audio: { id: 'audio-test' } });
    if (url.endsWith('/v1/audio/audio-test')) return new Response(wav);
    throw new Error('Unexpected request');
  };
  const app = createWebServer({ status: () => ({}) }, { port: 0, libraryDirectory: directory, speechFetch });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const reply = await fetch(`${origin}/api/coach/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: { title: 'Psychology', sentences: [{ text: 'Memory helps us learn.' }] },
        speech: { provider: 'yovoice', endpoint: 'http://127.0.0.1:8080', token: 'secret-test-token', modelId: 'index-2.5-q8', voiceId: 'voice-1' },
      }),
    });
    assert.equal(reply.status, 200);
    const result = await reply.json();
    assert.equal(result.audioWarning, '');
    assert.equal(result.audioItems[0].sourceProvider, 'Yovoice IndexTTS 2.5');
    const plan = await fetch(`${origin}/api/library/${result.item.id}/audio`).then(r => r.json());
    assert.equal(plan.audioIds[0], result.audioItems[0].id);
    const index = await readFile(join(directory, 'library.json'), 'utf8');
    assert.equal(index.includes('secret-test-token'), false);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('cloud speech calls an OpenAI-compatible WAV API for every sentence', async () => {
  const requests = [];
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(48)]);
  const files = await generateCloudSpeech([{ text: 'Hello.' }, { text: 'Goodbye.' }], {
    provider: 'openai-speech', endpoint: 'https://api.openai.com/v1', token: 'test-key', modelId: 'gpt-4o-mini-tts', voiceId: 'alloy',
  }, async (url, options) => {
    requests.push({ url, options });
    return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
  });
  assert.equal(files.length, 2);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(requests.map(item => JSON.parse(item.options.body).input), ['Hello.', 'Goodbye.']);
  assert.ok(requests.every(item => JSON.parse(item.options.body).response_format === 'wav'));
});

test('Qwen cloud speech saves the signed official audio URL as WAV', async () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(48)]);
  const requests = [];
  const files = await generateCloudSpeech([{ text: 'Learn psychology.' }], {
    provider: 'qwen-speech', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer', token: 'test-key',
    modelId: 'qwen-audio-3.0-tts-flash', voiceId: 'longanhuan_v3.6',
  }, async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === 'POST') return Response.json({ output: { audio: { url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav?signature=test' } } });
    return new Response(wav);
  });
  assert.equal(files[0].subarray(0, 4).toString(), 'RIFF');
  assert.equal(JSON.parse(requests[0].options.body).input.voice, 'longanhuan_v3.6');
  assert.equal(requests[1].options.headers, undefined);
  await assert.rejects(generateCloudSpeech([{ text: 'test' }], {
    provider: 'qwen-speech', endpoint: 'https://example.com/api', token: 'test-key', modelId: 'x', voiceId: 'y',
  }, async () => { throw new Error('should not call'); }), /官方域名/);
});

test('cloud speech test endpoint returns one WAV without creating a library item', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easyinput-cloud-test-'));
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(48)]);
  const app = createWebServer({ status: () => ({}) }, {
    port: 0,
    libraryDirectory: directory,
    speechFetch: async () => new Response(wav, { headers: { 'Content-Type': 'audio/wav' } }),
  });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const reply = await fetch(`${origin}/api/speech/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        speech: {
          provider: 'openai-speech',
          endpoint: 'https://api.openai.com/v1',
          token: 'test-key',
          modelId: 'gpt-4o-mini-tts',
          voiceId: 'alloy',
        },
      }),
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await reply.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
    const library = await fetch(`${origin}/api/library`).then(response => response.json());
    assert.deepEqual(library, []);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('cloud speech course publish stores each sentence audio and links it into the plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easyinput-cloud-publish-'));
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(48)]);
  const requests = [];
  const app = createWebServer({ status: () => ({}) }, {
    port: 0,
    libraryDirectory: directory,
    speechFetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
    },
  });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const reply = await fetch(`${origin}/api/coach/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: {
          title: 'Psychology speaking',
          sentences: [
            { text: 'Memory helps us learn.', translation: '记忆帮助我们学习。' },
            { text: 'Attention shapes what we notice.', translation: '注意力塑造我们注意到的内容。' },
          ],
        },
        speech: {
          provider: 'openai-speech',
          endpoint: 'https://api.openai.com/v1',
          token: 'test-key',
          modelId: 'gpt-4o-mini-tts',
          voiceId: 'alloy',
        },
      }),
    });
    assert.equal(reply.status, 200);
    const result = await reply.json();
    assert.equal(result.audioWarning, '');
    assert.equal(result.audioItems.length, 2);
    assert.equal(requests.length, 2);
    const plan = await fetch(`${origin}/api/library/${result.item.id}/audio`).then(r => r.json());
    assert.deepEqual(plan.audioIds, result.audioItems.map(item => item.id));
    const library = await fetch(`${origin}/api/library`).then(r => r.json());
    assert.equal(library.filter(item => item.materialKind === 'lesson-audio').length, 2);
    assert.equal(library.some(item => item.materialKind === 'lesson-plan'), true);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('cloud transcription returns text through an OpenAI-compatible multipart API', async () => {
  let request;
  const result = await transcribeCloudSpeech(Buffer.from('RIFFfake'), 'audio/wav', {
    provider: 'openai-transcription', endpoint: 'https://api.openai.com/v1', token: 'test-key', modelId: 'whisper-1',
  }, async (url, options) => {
    request = { url, options };
    return Response.json({ text: 'Memory helps us learn.' });
  });
  assert.equal(result.text, 'Memory helps us learn.');
  assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.options.body.get('model'), 'whisper-1');
  assert.equal(request.options.body.get('file').type, 'audio/wav');
});

test('local transcription proxy sends a saved recording to the configured speech service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easyinput-transcribe-'));
  const app = createWebServer({ status: () => ({}) }, {
    port: 0,
    libraryDirectory: directory,
    speechFetch: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      return Response.json({ text: 'I can practice speaking.' });
    },
  });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const reply = await fetch(`${origin}/api/speech/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        speech: { provider: 'openai-transcription', endpoint: 'https://api.openai.com/v1', token: 'test-key', modelId: 'whisper-1' },
        mimeType: 'audio/wav', audioBase64: Buffer.from('RIFFfake').toString('base64'),
      }),
    });
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { text: 'I can practice speaking.', provider: 'OpenAI 兼容语音识别', model: 'whisper-1' });
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
