const providers = {
  openai: { url: 'https://api.openai.com/v1/models', keyRequired: true },
  deepseek: { url: 'https://api.deepseek.com/models', keyRequired: true },
  qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models', keyRequired: true },
  kimi: { url: 'https://api.moonshot.cn/v1/models', keyRequired: true },
  ollama: { url: 'http://127.0.0.1:11434/api/tags', keyRequired: false },
};

function modelIds(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(rows)) throw new Error('服务商返回的数据里没有模型列表');
  return [...new Set(rows.map(row => String(row?.id ?? row?.name ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export async function listOfficialModels(provider, apiKey = '', fetchImpl = fetch) {
  const config = providers[provider];
  if (!config) throw new Error('该服务商暂不支持自动获取模型列表');
  if (config.keyRequired && !String(apiKey).trim()) throw new Error('请先填写该服务商的 API Key');
  const headers = { Accept: 'application/json' };
  if (config.keyRequired) headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  const response = await fetchImpl(config.url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`官方模型目录请求失败（HTTP ${response.status}）`);
  const models = modelIds(await response.json());
  return { provider, models, retrievedAt: new Date().toISOString() };
}

export const supportedModelProviders = Object.keys(providers);
