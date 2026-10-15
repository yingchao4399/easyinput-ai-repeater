import { randomBytes } from 'node:crypto';

export function yovoiceBaseUrl(value) {
  const url = new URL(String(value || 'http://127.0.0.1:8080'));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Yovoice 接口仅允许本机 http://127.0.0.1:端口');
  }
  return url.origin;
}

function headers(token) {
  if (!token || typeof token !== 'string') throw new Error('请填写 Yovoice 本地 API 令牌');
  return { Authorization: `Bearer ${token}` };
}

async function request(base, path, token, options = {}, fetchImpl = fetch) {
  const requestHeaders = { ...headers(token), ...options.headers };
  let response;
  try { response = await fetchImpl(`${base}${path}`, { ...options, headers: requestHeaders, redirect: 'error' }); }
  catch { throw new Error('无法连接 Yovoice。请在 Yovoice 设置 → 常规 → 本地 API 中开启服务。'); }
  if (!response.ok) {
    if (response.status === 401) throw new Error('Yovoice 令牌无效，请复制本地 API 页面当前令牌');
    if (response.status === 409) throw new Error('Yovoice 正在执行其他任务，请稍后重试');
    let detail = '';
    try { detail = String((await response.json()).error || '').slice(0, 180); } catch {}
    throw new Error(`Yovoice 请求失败（${response.status}）${detail ? `：${detail}` : ''}`);
  }
  return response;
}

export async function yovoiceCatalog(settings, fetchImpl = fetch) {
  const base = yovoiceBaseUrl(settings.endpoint);
  const [status, models, voices] = await Promise.all([
    request(base, '/v1/status', settings.token, {}, fetchImpl).then(r => r.json()),
    request(base, '/v1/models', settings.token, {}, fetchImpl).then(r => r.json()),
    request(base, '/v1/voices', settings.token, {}, fetchImpl).then(r => r.json()),
  ]);
  return { status, models: Array.isArray(models) ? models : models.models || [], voices: Array.isArray(voices) ? voices : voices.voices || [] };
}

export async function generateYovoiceSpeech(sentences, settings, fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const base = yovoiceBaseUrl(settings.endpoint);
  const modelId = String(settings.modelId || '');
  const voiceId = String(settings.voiceId || '');
  if (!modelId || !voiceId) throw new Error('请先在语音模型设置中选择 IndexTTS 模型和参考声音');
  const lines = sentences.map(line => String(line.text || '').trim());
  if (!lines.length || lines.length > 30 || lines.some(line => !line || line.length > 500)) throw new Error('课程句子不符合语音生成要求');
  const audio = [];
  for (const text of lines) {
    const id = randomBytes(16).toString('hex');
    const payload = { text, modelId, voiceId };
    await request(base, `/v1/jobs/${id}`, settings.token, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, fetchImpl);
    let completed = null;
    for (let attempt = 0; attempt < 450; attempt++) {
      const job = await request(base, `/v1/jobs/${id}`, settings.token, {}, fetchImpl).then(r => r.json());
      if (job.status === 'completed') { completed = job; break; }
      if (['failed', 'cancelled', 'timed_out'].includes(job.status)) throw new Error(`Yovoice 语音生成${job.status}：${String(job.error || '未知错误').slice(0, 180)}`);
      await wait(2000);
    }
    if (!completed) throw new Error('Yovoice 语音生成超时');
    const audioId = completed.audio?.id || completed.audioId;
    if (!audioId || !/^[\w-]+$/.test(audioId)) throw new Error('Yovoice 没有返回可下载的音频标识');
    const wav = Buffer.from(await request(base, `/v1/audio/${audioId}`, settings.token, {}, fetchImpl).then(r => r.arrayBuffer()));
    if (wav.subarray(0, 4).toString() !== 'RIFF') throw new Error('Yovoice 返回的音频不是 WAV 文件');
    audio.push(wav);
  }
  return audio;
}

function cloudEndpoint(settings) {
  const provider = settings.provider;
  const raw = String(settings.endpoint || (provider === 'openai-speech' ? 'https://api.openai.com/v1' : '')).trim();
  if (!raw) throw new Error('请填写云端语音 API 地址');
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new Error('云端语音 API 必须使用 HTTPS；本机服务可使用 HTTP');
  }
  if (provider === 'qwen-speech') {
    if (!/(^|\.)dashscope\.aliyuncs\.com$|(^|\.)cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname)) throw new Error('百炼语音地址必须是阿里云官方域名');
    if (url.pathname === '/') url.pathname = '/api/v1/services/audio/tts/SpeechSynthesizer';
  } else if (!url.pathname.endsWith('/audio/speech')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/audio/speech`;
  }
  return url.toString();
}

export async function generateCloudSpeech(sentences, settings, fetchImpl = fetch) {
  const endpoint = cloudEndpoint(settings);
  const key = String(settings.token || '');
  const model = String(settings.modelId || '');
  const voice = String(settings.voiceId || '');
  if (!key) throw new Error('请填写语音服务的 API Key');
  if (!model || !voice) throw new Error('请填写语音模型名称和声音名称');
  const lines = sentences.map(line => String(line.text || '').trim());
  if (!lines.length || lines.length > 30 || lines.some(line => !line || line.length > 500)) throw new Error('课程句子不符合语音生成要求');
  const wavFiles = [];
  for (const text of lines) {
    const payload = settings.provider === 'qwen-speech'
      ? { model, input: { text, voice, format: 'wav', sample_rate: 24000 } }
      : { model, voice, input: text, response_format: 'wav' };
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(180000),
      });
    } catch { throw new Error('云端语音服务连接失败，请检查 API 地址与网络'); }
    if (!response.ok) {
      let message = '';
      try { const data = await response.json(); message = String(data.error?.message || data.message || '').slice(0, 180); } catch {}
      throw new Error(`云端语音生成失败（${response.status}）${message ? `：${message}` : ''}`);
    }
    if (settings.provider === 'qwen-speech') {
      const data = await response.json();
      const audioUrl = new URL(String(data.output?.audio?.url || ''));
      if (!/^dashscope-result-[a-z-]+\.oss-cn-[a-z-]+\.aliyuncs\.com$/.test(audioUrl.hostname) || !['http:', 'https:'].includes(audioUrl.protocol)) throw new Error('百炼返回了无法验证的音频下载地址');
      response = await fetchImpl(audioUrl, { redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`百炼音频下载失败（${response.status}）`);
    }
    const wav = Buffer.from(await response.arrayBuffer());
    if (wav.length > 15 * 1024 * 1024 || wav.subarray(0, 4).toString() !== 'RIFF') throw new Error('语音服务未返回有效的 WAV 音频');
    wavFiles.push(wav);
  }
  return wavFiles;
}

function transcriptionEndpoint(settings) {
  const raw = String(settings.endpoint || 'https://api.openai.com/v1').trim();
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new Error('语音识别 API 必须使用 HTTPS；本机服务可使用 HTTP');
  }
  if (!url.pathname.endsWith('/audio/transcriptions')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/audio/transcriptions`;
  }
  return url.toString();
}

export async function transcribeCloudSpeech(audioBytes, mimeType, settings, fetchImpl = fetch) {
  const endpoint = transcriptionEndpoint(settings);
  const key = String(settings.token || '');
  const model = String(settings.modelId || 'whisper-1');
  if (!key) throw new Error('请填写语音识别服务的 API Key');
  if (!model) throw new Error('请填写语音识别模型名称');
  const data = Buffer.from(audioBytes);
  if (!data.length || data.length > 20 * 1024 * 1024) throw new Error('录音文件为空或超过 20 MB');
  const type = String(mimeType || 'audio/wav').split(';')[0] || 'audio/wav';
  const extension = { 'audio/wav': '.wav', 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3' }[type] || '.audio';
  const form = new FormData();
  form.append('file', new Blob([data], { type }), `practice${extension}`);
  form.append('model', model);
  form.append('language', String(settings.language || 'en'));
  form.append('response_format', 'json');
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(180000),
    });
  } catch { throw new Error('语音识别服务连接失败，请检查 API 地址与网络'); }
  if (!response.ok) {
    let message = '';
    try { const result = await response.json(); message = String(result.error?.message || result.message || '').slice(0, 180); } catch {}
    throw new Error(`语音识别失败（${response.status}）${message ? `：${message}` : ''}`);
  }
  let result;
  try { result = await response.json(); } catch { throw new Error('语音识别服务返回了无效结果'); }
  const text = String(result.text || '').trim();
  if (!text) throw new Error('语音识别服务没有返回文字');
  return { text, provider: 'OpenAI 兼容语音识别', model };
}
