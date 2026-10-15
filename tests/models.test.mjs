import test from 'node:test';
import assert from 'node:assert/strict';
import { listOfficialModels } from '../lib/models.mjs';
import { createWebServer } from '../server.mjs';

test('official model lookup calls the selected vendor catalog and normalizes model ids', async () => {
  let requestedUrl;
  let authorization;
  const result = await listOfficialModels('openai', 'test-secret', async (url, options) => {
    requestedUrl = url;
    authorization = options.headers.Authorization;
    return Response.json({ data: [{ id: 'gpt-z' }, { id: 'gpt-a' }, { object: 'permission' }, { id: 'gpt-a' }] });
  });
  assert.equal(requestedUrl, 'https://api.openai.com/v1/models');
  assert.equal(authorization, 'Bearer test-secret');
  assert.deepEqual(result.models, ['gpt-a', 'gpt-z']);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});

test('Ollama model lookup uses its local tags API without an API key', async () => {
  let requestedUrl;
  const result = await listOfficialModels('ollama', '', async url => {
    requestedUrl = url;
    return Response.json({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:latest' }] });
  });
  assert.equal(requestedUrl, 'http://127.0.0.1:11434/api/tags');
  assert.deepEqual(result.models, ['llama3.2:latest', 'qwen3:8b']);
});

test('local web API proxies model lookup without returning or logging the API key', async () => {
  let authorization;
  const bridge = { status: () => ({ micConnected: false, ledConnected: false }) };
  const app = createWebServer(bridge, {
    port: 0,
    modelsFetch: async (_url, options) => {
      authorization = options.headers.Authorization;
      return Response.json({ data: [{ id: 'deepseek-chat' }] });
    },
  });
  await app.listen();
  const { port } = app.server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/providers/models`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', apiKey: 'secret-for-test' }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(authorization, 'Bearer secret-for-test');
    assert.match(body, /deepseek-chat/);
    assert.equal(body.includes('secret-for-test'), false);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
  }
});

test('official model lookup rejects missing credentials and unsupported providers', async () => {
  await assert.rejects(listOfficialModels('openai', ''), /请先填写/);
  await assert.rejects(listOfficialModels('custom', 'secret'), /暂不支持/);
});
