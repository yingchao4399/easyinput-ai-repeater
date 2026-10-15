import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const origin = `http://127.0.0.1:${Number(process.env.EASYINPUT_REPEATER_PORT || 8766)}`;

async function request(path, body) {
  let response;
  try {
    response = await fetch(`${origin}${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { throw new Error(`本机练习服务未启动：${origin}`); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `本机服务请求失败（HTTP ${response.status}）`);
  return data;
}

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function buildServer() {
  const server = new McpServer({ name: 'easyinput-learning-coach', version: '0.1.0' });
  server.registerTool('search_learning_sources', {
    description: 'Search public text, audio, image and video candidates for an English speaking topic. Returns source URLs, licenses and import candidate IDs.',
    inputSchema: z.object({ query: z.string().min(2).max(160) }),
    annotations: { readOnlyHint: true },
  }, async ({ query }) => result(await request('/api/materials/search-all', { query })));
  server.registerTool('list_learning_materials', {
    description: 'List locally stored lessons, generated voices, imported audio/video/images and source links without reading private recordings.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true },
  }, async () => result((await request('/api/library')).filter(item => item.bucket !== 'recordings')));
  server.registerTool('bookmark_learning_source', {
    description: 'Save an HTTPS source link in the local materials library. This does not claim to download platform media.',
    inputSchema: z.object({ url: z.url().startsWith('https://'), title: z.string().max(150).optional() }),
  }, async input => result(await request('/api/materials/bookmark', input)));
  server.registerTool('import_search_candidate', {
    description: 'Import a licensed search candidate into the local library. Videos also have an audio track extracted when possible.',
    inputSchema: z.object({ candidateId: z.string().min(1) }),
  }, async input => result(await request('/api/materials/import', input)));
  server.registerTool('prepare_lesson_voices', {
    description: 'Generate and save local English voice files for an existing AI lesson plan, then link them to sentence practice.',
    inputSchema: z.object({ materialId: z.string().uuid() }),
  }, async input => result(await request('/api/coach/prepare-audio', input)));
  return server;
}

await serveStdio(() => buildServer(), { onerror: error => process.stderr.write(`${error.message}\n`) });
