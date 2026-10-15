import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { encodeControl, encodeLevel, parseAck, parseAudio, parseHeartbeat, wavFromPcm } from './lib/protocol.mjs';
import { listOfficialModels } from './lib/models.mjs';
import { MaterialLibrary } from './lib/library.mjs';
import { downloadOpenverseAudio, englishSearchQuery, planLesson, searchOpenverseAudio, searchWikipediaText } from './lib/coach.mjs';
import { generateLessonSpeech } from './lib/tts.mjs';
import { generateCloudSpeech, generateYovoiceSpeech, transcribeCloudSpeech, yovoiceCatalog } from './lib/speech-services.mjs';
import { downloadCommonsMedia, extractVideoAudio, searchCommonsMedia } from './lib/commons.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const recordingsDir = join(root, 'recordings');
const webPort = Number(process.env.EASYINPUT_REPEATER_PORT || 8766);
// EasyInput's companion application uses 17335 for its own microphone listener.
// Keep the repeater bridge on a separate port so both programs can stay open.
const micPort = Number(process.env.EASYINPUT_MIC_PORT || 17336);
const ledPort = Number(process.env.EASYINPUT_LED_PORT || 17334);

export class BoardBridge {
  constructor(options = {}) {
    this.micPort = options.micPort ?? micPort;
    this.ledPort = options.ledPort ?? ledPort;
    this.recordingsDir = options.recordingsDir ?? recordingsDir;
    this.mic = createSocket('udp4');
    this.led = createSocket('udp4');
    this.micBoard = null;
    this.ledBoard = null;
    this.recording = null;
    this.latest = null;
    this.sequence = 0;
    this.ledSequence = 0;
    this.ledState = 'idle';
    this.errors = [];
    this.pending = new Map();
    this.keepalive = null;
    this.ledTicker = null;
  }

  async bind(socket, port, kind) {
    return new Promise(resolveBind => {
      const onError = error => {
        this.errors.push(`${kind} UDP ${port}: ${error.message}`);
        resolveBind(false);
      };
      socket.once('error', onError);
      socket.bind(port, '0.0.0.0', () => {
        socket.off('error', onError);
        socket.on('error', error => this.errors.push(`${kind}: ${error.message}`));
        resolveBind(true);
      });
    });
  }

  async start() {
    this.mic.on('message', (packet, from) => this.onMicPacket(packet, from));
    this.led.on('message', (packet, from) => this.onLedPacket(packet, from));
    this.micReady = await this.bind(this.mic, this.micPort, '麦克风');
    this.ledReady = await this.bind(this.led, this.ledPort, '灯光');
    this.ledTicker = setInterval(() => this.tickLed(), 90);
  }

  boardFresh(board) { return board && Date.now() - board.seenAt < 6500; }

  status() {
    const mic = this.boardFresh(this.micBoard) ? this.micBoard : null;
    const led = this.boardFresh(this.ledBoard) ? this.ledBoard : null;
    return {
      micPort: this.micPort,
      ledPort: this.ledPort,
      micReady: Boolean(this.micReady),
      ledReady: Boolean(this.ledReady),
      micConnected: Boolean(mic && mic.audioReady && this.micReady),
      ledConnected: Boolean(led && this.ledReady),
      recording: this.recording?.state ?? 'idle',
      packets: this.recording?.frames.size ?? 0,
      latest: this.latest ? { durationSeconds: this.latest.durationSeconds, packets: this.latest.packets, gaps: this.latest.gaps, createdAt: this.latest.createdAt } : null,
      errors: this.errors.slice(-3),
    };
  }

  onMicPacket(packet, from) {
    if (from.family !== 'IPv4') return;
    const heartbeat = parseHeartbeat(packet);
    if (heartbeat) {
      if (this.boardFresh(this.micBoard) && this.micBoard.ip !== from.address) return;
      this.micBoard = { ip: from.address, port: from.port, seenAt: Date.now(), audioReady: heartbeat.audioReady };
      return;
    }
    const ack = parseAck(packet);
    if (ack) {
      const waiter = this.pending.get(ack.sequence);
      if (waiter && from.address === waiter.ip && ack.action === waiter.action && ack.sessionId === waiter.sessionId) {
        this.pending.delete(ack.sequence);
        clearTimeout(waiter.timer);
        waiter.resolve(ack);
      }
      return;
    }
    const frame = parseAudio(packet);
    const record = this.recording;
    if (!frame || !record || from.address !== record.boardIp || frame.sessionId !== record.sessionId || !['starting', 'recording', 'stopping'].includes(record.state)) return;
    if (record.frames.size < 3000 && !record.frames.has(frame.sequence)) record.frames.set(frame.sequence, frame.pcm);
  }

  onLedPacket(packet, from) {
    if (from.family !== 'IPv4' || !parseHeartbeat(packet)) return;
    if (this.boardFresh(this.ledBoard) && this.ledBoard.ip !== from.address) return;
    this.ledBoard = { ip: from.address, port: from.port, seenAt: Date.now() };
  }

  async control(action, sessionId) {
    if (!this.boardFresh(this.micBoard) || !this.micReady) throw new Error('板载麦克风未连接');
    const board = { ...this.micBoard };
    const sequence = ++this.sequence;
    const packet = encodeControl(action, sessionId, sequence);
    return new Promise((resolveAck, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence);
        reject(new Error('开发板未确认录音命令；检查 Wi-Fi、audio_host 和端口'));
      }, 1800);
      this.pending.set(sequence, { ip: board.ip, action, sessionId, timer, resolve: resolveAck });
      this.mic.send(packet, board.port, board.ip, error => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(sequence);
          reject(error);
        }
      });
    });
  }

  async beginRecord() {
    if (this.recording) throw new Error('录音已在进行中');
    if (!this.status().micConnected) throw new Error('尚未发现可用的板载麦克风');
    const sessionId = randomBytes(8).readBigUInt64LE() || 1n;
    this.recording = { state: 'starting', sessionId, boardIp: this.micBoard.ip, frames: new Map(), startedAt: Date.now() };
    try {
      const ack = await this.control(1, sessionId);
      if (ack.status !== 0) throw new Error(`开发板拒绝开始录音（状态 ${ack.status}）`);
      this.recording.state = 'recording';
      this.ledState = 'recording';
      this.keepalive = setInterval(() => { this.control(3, sessionId).catch(() => {}); }, 5000);
      return this.status();
    } catch (error) {
      this.recording = null;
      throw error;
    }
  }

  async endRecord() {
    const record = this.recording;
    if (!record || !['starting', 'recording'].includes(record.state)) throw new Error('当前没有板载录音');
    record.state = 'stopping';
    clearInterval(this.keepalive);
    this.keepalive = null;
    try { await this.control(2, record.sessionId); } catch (error) { this.errors.push(`停止录音确认：${error.message}`); }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    this.recording = null;
    this.ledState = 'idle';
    const sequenceNumbers = [...record.frames.keys()].sort((a, b) => a - b);
    if (!sequenceNumbers.length) throw new Error('未收到开发板音频，请检查麦克风配置与网络');
    const chunks = [];
    let gaps = 0;
    let previous = sequenceNumbers[0] - 1;
    for (const number of sequenceNumbers) {
      const gap = Math.min(10, Math.max(0, number - previous - 1));
      for (let i = 0; i < gap; i++) { chunks.push(Buffer.alloc(640)); gaps++; }
      chunks.push(record.frames.get(number));
      previous = number;
    }
    const wav = wavFromPcm(Buffer.concat(chunks));
    await mkdir(this.recordingsDir, { recursive: true });
    const createdAt = new Date().toISOString();
    const filename = `repeater-${createdAt.replace(/[:.]/g, '-')}.wav`;
    await writeFile(join(this.recordingsDir, filename), wav);
    this.latest = { path: join(this.recordingsDir, filename), wav, durationSeconds: (wav.length - 44) / 32000, packets: record.frames.size, gaps, createdAt };
    return this.status();
  }

  setLedState(state) {
    if (!['idle', 'playing', 'recording', 'weak', 'mastered'].includes(state)) throw new Error('未知灯光状态');
    this.ledState = state;
    if (state === 'idle') this.tickLed(true);
  }

  tickLed(force = false) {
    if (!this.ledReady || !this.boardFresh(this.ledBoard)) return;
    const levels = { idle: 0, playing: 65, recording: 230, weak: 155, mastered: 105 };
    if (this.ledState === 'idle' && !force) return;
    this.led.send(encodeLevel(levels[this.ledState], ++this.ledSequence), this.ledBoard.port, this.ledBoard.ip);
  }

  close() {
    clearInterval(this.keepalive);
    clearInterval(this.ledTicker);
    for (const waiter of this.pending.values()) clearTimeout(waiter.timer);
    this.pending.clear();
    if (this.micReady) this.mic.close();
    if (this.ledReady) this.led.close();
  }
}

export function createWebServer(bridge, options = {}) {
  const port = options.port ?? webPort;
  const modelsFetch = options.modelsFetch ?? fetch;
  const coachFetch = options.coachFetch ?? fetch;
  const audioSearchFetch = options.audioSearchFetch ?? fetch;
  const audioDownloadFetch = options.audioDownloadFetch ?? fetch;
  const textSearchFetch = options.textSearchFetch ?? fetch;
  const commonsSearchFetch = options.commonsSearchFetch ?? fetch;
  const commonsDownloadFetch = options.commonsDownloadFetch ?? fetch;
  const speechFetch = options.speechFetch ?? fetch;
  const defaultDataDirectory = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'EasyInputRepeater', 'materials')
    : join(homedir(), '.easyinput-repeater', 'materials');
  const settingsPath = join(dirname(defaultDataDirectory), 'settings.json');
  const library = options.library ?? new MaterialLibrary(options.libraryDirectory ?? defaultDataDirectory);
  let libraryReady;
  const ensureLibrary = () => (libraryReady ||= (async () => {
    if (!options.library && !options.libraryDirectory) {
      try {
        const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
        if (typeof settings.materialsDirectory === 'string') library.directory = resolve(settings.materialsDirectory);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return library.init();
  })());
  const audioCandidates = new Map();
  const generateAudioItems = async (plan, speech = {}) => {
    const selected = {
      yovoice: 'Yovoice IndexTTS 2.5',
      'openai-speech': '云端兼容语音 API',
      'qwen-speech': '阿里云百炼 Qwen-Audio-TTS',
    }[speech.provider] || 'Windows 本机英语语音';
    const wavFiles = speech.provider === 'yovoice'
      ? await generateYovoiceSpeech(plan.sentences, speech, speechFetch)
      : ['openai-speech', 'qwen-speech'].includes(speech.provider)
        ? await generateCloudSpeech(plan.sentences, speech, speechFetch)
        : await generateLessonSpeech(plan.sentences);
    const items = [];
    for (let index = 0; index < wavFiles.length; index++) {
      const sentence = plan.sentences[index];
      items.push(await library.addFile({
        bucket: 'generated-audio', group: 'ai-courses', name: `${String(plan.title || 'AI课程').slice(0, 65)} · 第${index + 1}句.wav`,
        mimeType: 'audio/wav', bytes: wavFiles[index],
        metadata: { materialKind: 'lesson-audio', sentenceIndex: index, transcript: String(sentence.text || ''), translation: String(sentence.translation || ''), sourceProvider: selected },
      }));
    }
    return items;
  };
  const routes = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/srt.js', ['../lib/srt.mjs', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/demo/five-sentences.wav', ['../demo/five-sentences.wav', 'audio/wav']],
    ['/demo/five-sentences.srt', ['../demo/five-sentences.srt', 'text/plain; charset=utf-8']],
  ]);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'GET' && url.pathname === '/api/status') return json(200, bridge.status());
      if (req.method === 'GET' && url.pathname === '/api/library') {
        await ensureLibrary();
        return json(200, await library.list());
      }
      if (req.method === 'GET' && url.pathname === '/api/library/usage') {
        await ensureLibrary();
        return json(200, await library.usage());
      }
      if (req.method === 'POST' && url.pathname === '/api/recordings') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(403, { error: '来源未被允许' });
        const mimeType = String(req.headers['content-type'] || '').split(';')[0];
        if (!['audio/webm', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/mpeg'].includes(mimeType)) return json(415, { error: '仅接受音频录音文件' });
        const lessonId = decodeURIComponent(String(req.headers['x-lesson-id'] || '')).slice(0, 512);
        const sentenceIndex = Number(req.headers['x-sentence-index']);
        if (!lessonId || !Number.isInteger(sentenceIndex) || sentenceIndex < 0 || sentenceIndex > 10000) return json(400, { error: '录音缺少课程与句子标识' });
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 20 * 1024 * 1024) return json(413, { error: '单条录音超过 20 MB' });
          chunks.push(chunk);
        }
        if (!size) return json(400, { error: '录音为空' });
        await ensureLibrary();
        const extension = { 'audio/webm': '.webm', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3' }[mimeType];
        const item = await library.addFile({
          bucket: 'recordings', group: 'practice-takes', name: `第${sentenceIndex + 1}句跟读-${Date.now()}${extension}`,
          mimeType, bytes: Buffer.concat(chunks),
          metadata: { materialKind: 'practice-take', lessonId, sentenceIndex, device: decodeURIComponent(String(req.headers['x-record-device'] || 'browser')).slice(0, 30) },
        });
        return json(200, { item });
      }
      const audioMatch = url.pathname.match(/^\/api\/library\/([\w-]+)\/audio$/);
      if (req.method === 'GET' && audioMatch) {
        await ensureLibrary();
        const file = await library.getFile(audioMatch[1]);
        if (!file) return json(404, { error: '材料不存在' });
        res.writeHead(200, { 'Content-Type': file.item.mimeType, 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store' });
        return res.end(file.bytes);
      }
      if (req.method === 'GET' && url.pathname === '/api/record/latest.wav') {
        if (!bridge.latest) return json(404, { error: '尚无录音' });
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bridge.latest.wav.length, 'Cache-Control': 'no-store' });
        return res.end(bridge.latest.wav);
      }
      if (req.method === 'POST' && url.pathname === '/api/speech/transcribe') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(403, { error: '来源未被允许' });
        if (req.headers['content-type'] !== 'application/json') return json(415, { error: '需要 JSON 请求' });
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 28 * 1024 * 1024) return json(413, { error: '录音请求超过 20 MB' });
        }
        const data = raw ? JSON.parse(raw) : {};
        const encoded = String(data.audioBase64 || '');
        if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return json(400, { error: '录音数据格式无效' });
        const bytes = Buffer.from(encoded, 'base64');
        if (!bytes.length || bytes.length > 20 * 1024 * 1024) return json(413, { error: '录音为空或超过 20 MB' });
        const result = await transcribeCloudSpeech(bytes, String(data.mimeType || 'audio/wav'), data.speech || {}, speechFetch);
        return json(200, result);
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(403, { error: '来源未被允许' });
        if (req.headers['content-type'] !== 'application/json') return json(415, { error: '需要 JSON 请求' });
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 16384) return json(413, { error: '请求过大' });
        }
        const data = raw ? JSON.parse(raw) : {};
        if (url.pathname === '/api/providers/models') {
          if (typeof data.provider !== 'string' || typeof data.apiKey !== 'string') return json(400, { error: '服务商或 API Key 格式无效' });
          return json(200, await listOfficialModels(data.provider, data.apiKey, modelsFetch));
        }
        if (url.pathname === '/api/speech/catalog') {
          return json(200, await yovoiceCatalog(data, speechFetch));
        }
        if (url.pathname === '/api/speech/test') {
          const provider = String(data.speech?.provider || '');
          if (!['openai-speech', 'qwen-speech'].includes(provider)) {
            return json(400, { error: '请先选择云端语音服务' });
          }
          const wavFiles = await generateCloudSpeech(
            [{ text: 'This is a cloud speech test.' }],
            data.speech,
            speechFetch,
          );
          const wav = wavFiles[0];
          res.writeHead(200, {
            'Content-Type': 'audio/wav',
            'Content-Length': wav.length,
            'Cache-Control': 'no-store',
          });
          return res.end(wav);
        }
        if (url.pathname === '/api/library/migrate') {
          await ensureLibrary();
          const destination = String(data.destination || '').trim();
          if (!isAbsolute(destination)) return json(400, { error: '请输入电脑上的绝对目录路径' });
          const result = await library.migrate(destination);
          if (!options.library && !options.libraryDirectory) {
            await mkdir(dirname(settingsPath), { recursive: true });
            await writeFile(settingsPath, JSON.stringify({ materialsDirectory: result.directory }, null, 2));
          }
          return json(200, result);
        }
        if (url.pathname === '/api/recordings/from-board') {
          if (!bridge.latest?.wav) return json(404, { error: '尚无板载录音' });
          const lessonId = String(data.lessonId || '').slice(0, 512);
          const sentenceIndex = Number(data.sentenceIndex);
          if (!lessonId || !Number.isInteger(sentenceIndex) || sentenceIndex < 0) return json(400, { error: '录音缺少课程与句子标识' });
          await ensureLibrary();
          const item = await library.addFile({
            bucket: 'recordings', group: 'practice-takes', name: `第${sentenceIndex + 1}句板载跟读-${Date.now()}.wav`,
            mimeType: 'audio/wav', bytes: bridge.latest.wav,
            metadata: { materialKind: 'practice-take', lessonId, sentenceIndex, device: 'EasyInput 麦克风' },
          });
          return json(200, { item });
        }
        if (url.pathname === '/api/recordings/analysis') {
          await ensureLibrary();
          const id = String(data.id || '');
          const existing = await library.getFile(id);
          if (!existing || existing.item.materialKind !== 'practice-take') return json(404, { error: '跟读录音不存在' });
          const metadata = {};
          for (const key of ['transcript', 'analysisProvider', 'analysisResult', 'analysisFeedback']) {
            if (data[key] !== undefined) metadata[key] = String(data[key]).slice(0, 2000);
          }
          if (data.analysisScore !== undefined && Number.isFinite(Number(data.analysisScore))) metadata.analysisScore = Math.max(0, Math.min(1, Number(data.analysisScore)));
          const item = await library.updateFile(id, existing.bytes, metadata);
          return json(200, { item });
        }
        if (url.pathname === '/api/coach/plan') {
          const plan = await planLesson({ ...data, fetchImpl: coachFetch });
          return json(200, plan);
        }
        if (url.pathname === '/api/coach/publish') {
          await ensureLibrary();
          if (!data.plan || !Array.isArray(data.plan.sentences) || !data.plan.sentences.length) return json(400, { error: '没有可发布的课程计划' });
          const audioItems = [];
          let audioWarning = '';
          try {
            audioItems.push(...await generateAudioItems(data.plan, data.speech));
          } catch (error) { audioWarning = error.message; }
          const bytes = Buffer.from(JSON.stringify({ ...data.plan, audioIds: audioItems.map(item => item.id), sourceMaterials: Array.isArray(data.sourceMaterials) ? data.sourceMaterials : [] }, null, 2));
          const item = await library.addFile({
            bucket: 'materials', group: 'ai-courses', name: `${String(data.plan.title || 'AI课程').slice(0, 90)}.json`,
            mimeType: 'application/json', bytes,
            metadata: { materialKind: 'lesson-plan', provider: data.plan.provider, model: data.plan.model, generatedAudioCount: audioItems.length },
          });
          return json(200, { item, audioItems, audioWarning });
        }
        if (url.pathname === '/api/coach/prepare-audio') {
          await ensureLibrary();
          const existing = await library.getFile(String(data.materialId || ''));
          if (!existing || existing.item.materialKind !== 'lesson-plan') return json(404, { error: '没有找到这份 AI 课程' });
          const plan = JSON.parse(existing.bytes.toString('utf8'));
          if (Array.isArray(plan.audioIds) && plan.audioIds.length === plan.sentences?.length) return json(200, { item: existing.item, plan, audioItems: [] });
          const audioItems = await generateAudioItems(plan, data.speech);
          plan.audioIds = audioItems.map(item => item.id);
          const item = await library.updateFile(existing.item.id, Buffer.from(JSON.stringify(plan, null, 2)), { generatedAudioCount: audioItems.length });
          return json(200, { item, plan, audioItems });
        }
        if (url.pathname === '/api/materials/search-all') {
          const query = String(data.query || '').trim().slice(0, 160);
          if (!query) return json(400, { error: '请先填写学习目标' });
          let englishQuery = query;
          let queryWarning = '';
          try {
            englishQuery = await englishSearchQuery(query, { provider: data.provider, model: data.model, apiKey: data.apiKey, fetchImpl: coachFetch });
          } catch (error) { queryWarning = error.message; }
          const searches = await Promise.allSettled([
            searchOpenverseAudio(englishQuery, { fetchImpl: audioSearchFetch, limit: 5 }),
            searchWikipediaText(englishQuery, { fetchImpl: textSearchFetch, limit: 5 }),
            searchCommonsMedia(englishQuery, { fetchImpl: commonsSearchFetch, limit: 5 }),
          ]);
          const sources = searches.map((result, index) => ({
            provider: ['Openverse', 'Wikipedia', 'Wikimedia Commons'][index],
            status: result.status === 'fulfilled' ? 'ok' : 'error',
            count: result.status === 'fulfilled' ? result.value.length : 0,
            error: result.status === 'rejected' ? result.reason.message : '',
          }));
          const results = searches.flatMap((result, index) => result.status === 'fulfilled'
            ? result.value.map(item => {
              const candidate = { ...item, type: index === 0 ? 'audio' : index === 1 ? 'text' : item.type, provider: ['Openverse', 'Wikipedia', 'Wikimedia Commons'][index] };
              const candidateId = randomBytes(16).toString('hex');
              audioCandidates.set(candidateId, candidate);
              return { ...candidate, candidateId };
            })
            : []);
          return json(200, { query, englishQuery, queryWarning, sources, results });
        }
        if (url.pathname === '/api/materials/search') {
          const results = await searchOpenverseAudio(data.query, { fetchImpl: audioSearchFetch, limit: data.limit });
          const candidates = results.map(item => {
            const candidateId = randomBytes(16).toString('hex');
            audioCandidates.set(candidateId, item);
            return { ...item, candidateId };
          });
          return json(200, { provider: 'Openverse', query: data.query, results: candidates });
        }
        if (url.pathname === '/api/materials/import') {
          const candidate = audioCandidates.get(String(data.candidateId || ''));
          if (!candidate) return json(404, { error: '搜索结果已过期，请重新搜索' });
          if (!candidate.canImport) return json(403, { error: '该素材许可信息不足，不能自动导入' });
          if (candidate.type === 'text') {
            await ensureLibrary();
            const item = await library.addFile({
              bucket: 'materials', group: 'wikipedia-text', name: `${candidate.title}.json`,
              mimeType: 'application/json',
              bytes: Buffer.from(JSON.stringify({ title: candidate.title, excerpt: candidate.excerpt, sourceUrl: candidate.sourceUrl, license: candidate.license, creator: candidate.creator }, null, 2)),
              metadata: { materialKind: 'source-text', sourceProvider: candidate.provider, sourceUrl: candidate.sourceUrl, license: candidate.license, creator: candidate.creator },
            });
            audioCandidates.delete(String(data.candidateId));
            return json(200, { item });
          }
          if (candidate.provider === 'Wikimedia Commons') {
            const bytes = await downloadCommonsMedia(candidate.mediaUrl, { fetchImpl: commonsDownloadFetch });
            await ensureLibrary();
            const metadata = { sourceProvider: candidate.provider, sourceUrl: candidate.sourceUrl, creator: candidate.creator, license: candidate.license, licenseUrl: candidate.licenseUrl, materialKind: `source-${candidate.type}` };
            const extension = extname(new URL(candidate.mediaUrl).pathname).toLowerCase() || '.bin';
            const sourceMime = candidate.type === 'video' && candidate.mimeType === 'application/ogg' ? 'video/ogg'
              : candidate.type === 'audio' && candidate.mimeType === 'application/ogg' ? 'audio/ogg' : candidate.mimeType;
            const original = await library.addFile({
              bucket: 'materials', group: `commons-${candidate.type}`, name: `${candidate.title}${candidate.title.toLowerCase().endsWith(extension) ? '' : extension}`,
              mimeType: sourceMime, bytes, metadata,
            });
            let audioItem = null;
            let warning = '';
            if (candidate.type === 'video') {
              try {
                const audioBytes = await extractVideoAudio(bytes);
                audioItem = await library.addFile({
                  bucket: 'materials', group: 'extracted-audio', name: `${candidate.title.replace(/\.[^.]+$/, '')} · 视频音轨.wav`,
                  mimeType: 'audio/wav', bytes: audioBytes,
                  metadata: { ...metadata, materialKind: 'extracted-audio', sourceVideoId: original.id, extractionStatus: 'audio-ready' },
                });
              } catch (error) { warning = error.message; }
            }
            audioCandidates.delete(String(data.candidateId));
            return json(200, { item: audioItem || original, original, audioItem, warning });
          }
          const { bytes, contentType } = await downloadOpenverseAudio(candidate.audioUrl, audioDownloadFetch);
          await ensureLibrary();
          const extension = extname(new URL(candidate.audioUrl).pathname) || (contentType.includes('mpeg') ? '.mp3' : '.audio');
          const item = await library.addFile({
            bucket: 'materials', group: 'openverse', name: `${candidate.title}${extension}`,
            mimeType: contentType, bytes,
            metadata: { sourceProvider: 'Openverse', sourceUrl: candidate.sourceUrl, creator: candidate.creator, license: candidate.license, licenseVersion: candidate.licenseVersion, audioDuration: candidate.duration },
          });
          audioCandidates.delete(String(data.candidateId));
          return json(200, { item });
        }
        if (url.pathname === '/api/materials/bookmark') {
          let source;
          try { source = new URL(String(data.url || '').trim()); }
          catch { return json(400, { error: '请输入完整的 HTTPS 链接' }); }
          if (source.protocol !== 'https:' || source.username || source.password || !source.hostname.includes('.')) return json(400, { error: '仅接受不含账号密码的 HTTPS 链接' });
          const domain = source.hostname.toLowerCase();
          const sourceType = /(^|\.)(bilibili\.com|b23\.tv)$/.test(domain) ? 'video'
            : /\.(mp3|wav|m4a|ogg)$/i.test(source.pathname) ? 'audio'
            : /\.(mp4|webm|mov)$/i.test(source.pathname) ? 'video' : 'web';
          await ensureLibrary();
          const title = String(data.title || domain).trim().slice(0, 150);
          const item = await library.addFile({
            bucket: 'materials', group: 'source-links', name: `${title}.json`,
            mimeType: 'application/json',
            bytes: Buffer.from(JSON.stringify({ title, url: source.href, sourceType, status: '待解析：已保存来源链接，尚未获取字幕或媒体文件' }, null, 2)),
            metadata: { materialKind: 'source-link', sourceProvider: domain, sourceUrl: source.href, sourceType, extractionStatus: 'pending' },
          });
          return json(200, { item });
        }
        if (url.pathname === '/api/record/start') return json(200, await bridge.beginRecord());
        if (url.pathname === '/api/record/stop') return json(200, await bridge.endRecord());
        if (url.pathname === '/api/led') { bridge.setLedState(data.state); return json(200, bridge.status()); }
      }
      const file = routes.get(url.pathname);
      if (req.method === 'GET' && file) {
        const bytes = await readFile(resolve(publicDir, file[0]));
        res.writeHead(200, { 'Content-Type': file[1], 'Content-Length': bytes.length });
        return res.end(bytes);
      }
      json(404, { error: '未找到页面' });
    } catch (error) { json(400, { error: error.message }); }
  });
  return { server, listen: () => new Promise(resolveListen => server.listen(port, '127.0.0.1', () => resolveListen(port))) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bridge = new BoardBridge();
  await bridge.start();
  const app = createWebServer(bridge);
  await app.listen();
  console.log(`EasyInput 复读机已启动：http://127.0.0.1:${webPort}`);
  console.log(`板载麦克风 UDP ${micPort}；五灯 UDP ${ledPort}。录音仅保存在本机。`);
  process.on('SIGINT', () => { bridge.close(); app.server.close(); process.exit(0); });
}
