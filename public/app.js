import { parseSrt } from '/srt.js';

const $ = id => document.getElementById(id);
const audioMedia = $('audioMedia');
const videoMedia = $('videoMedia');
const videoStage = $('videoStage');
const actionButtons = [...document.querySelectorAll('[data-action]')];
const translations = [
  '早上好。我们一句一句地练习。',
  '我可以听原句、跟读，并对比自己的声音。',
  '慢一点练习，能帮我听清每个发音。',
  '小键盘让我练习时不用离开学习内容。',
  '今天我学会了如何用人工智能开发。',
];
const state = {
  mediaFile: null, mediaUrl: null, mediaKind: 'audio', media: audioMedia,
  demoMode: localStorage.getItem('repeater-demo-mode') || 'media', utterance: null,
  lessonId: '', captions: [], translations, line: 0, sourceMode: 'audio', courseAudioIds: [],
  a: null, b: null, looping: false, slow: false, heard: false,
  phase: 'ready', recognition: null, recognitionText: '', recognitionSupported: false,
  recordSource: null, recorder: null, stream: null, chunks: [],
  recordingUrl: null, recordingBlob: null, recordingItemId: null, recordingLine: null, persistPromise: Promise.resolve(),
  recordedLines: new Set(), board: null, comparing: false, compareDone: false,
  marks: {}, benchmark: { current: null, results: [] },
  s5Timer: null, s5Held: false,
};

function say(message, error = false) {
  $('message').textContent = message;
  $('message').classList.toggle('error', error);
}
function updateCoach() {
  const title = $('coachTitle');
  const phase = $('coachPhase');
  const instruction = $('coachInstruction');
  const button = $('practiceButton');
  if (!title || !phase || !instruction || !button) return;
  const copy = {
    ready: ['准备好了，按键开始', '第 1 步', state.sourceMode === 'speech' ? '这份课程使用系统语音朗读；按一下听当前句。' : state.sourceMode === 'course' ? '这份课程已生成逐句语音；按一下听当前句。' : '按一下播放示范；可选材料原音或 AI 朗读。', '按键开始：听示范', false],
    speaking: [state.demoMode === 'speech' ? 'AI 正在朗读这一句' : '正在播放材料原音', '第 1 步', '示范结束后就轮到你跟读。', '示范播放中…', true],
    awaitingRecord: ['轮到你跟读', '第 2 步', '按一下开始录音；说完后再按一下结束。', '按键开始跟读录音', false],
    recording: ['正在录你的声音', '第 2 步', '说完这一句后再按一下，AI 会自动分析。', '按键结束并让 AI 分析', false],
    analyzing: ['AI 正在分析', '第 3 步', '正在播放原声和你的跟读，并检查词语。', '分析中…', true],
    feedback: ['根据反馈再练一次', '第 3 步', '按一下重听示范，听完后再跟读。', '按键再练这一句', false],
    passed: ['这一句练会了', '完成', '可以继续下一句，也可以再听一遍。', state.line < (state.captions.length - 1) ? '按键练下一句' : '按键再练这一句', false],
  }[state.phase] || null;
  if (!copy) return;
  title.textContent = copy[0]; phase.textContent = copy[1]; instruction.textContent = copy[2];
  button.textContent = copy[3]; button.disabled = copy[4]; button.classList.toggle('recording', state.phase === 'recording');
  document.querySelectorAll('input[name="demoMode"]').forEach(input => {
    input.checked = input.value === state.demoMode;
    input.disabled = state.sourceMode === 'speech' || ['speaking', 'recording', 'analyzing'].includes(state.phase);
  });
}
function showFeedback(html, pass = false) {
  const panel = $('feedbackPanel');
  if (!panel) return;
  panel.hidden = false; panel.classList.toggle('pass', pass); panel.innerHTML = html;
}
function format(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const total = Math.floor(Math.max(0, seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function segment(index = state.line) {
  const caption = state.captions[index];
  return caption ?? { start: 0, end: state.media?.duration || 0, text: state.sourceMode === 'audio' ? '' : state.mediaFile?.name || '整段素材' };
}
function bounds() {
  const line = segment();
  return { start: state.a ?? line.start, end: state.b ?? (line.end > line.start ? line.end : state.media?.duration || 1e9) };
}
function markKey() { return `easyinput-repeater:${state.lessonId}`; }

let dbPromise;
function openTakeDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('此浏览器不支持本机录音保存'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('easyinput-repeater', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('takes', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本机录音库'));
  });
  return dbPromise;
}
async function uploadTake(lessonId, sentenceIndex, blob, device = 'browser') {
  const response = await fetch('/api/recordings', {
    method: 'POST',
    headers: { 'Content-Type': blob.type?.split(';')[0] || 'audio/webm', 'X-Lesson-Id': encodeURIComponent(lessonId), 'X-Sentence-Index': String(sentenceIndex), 'X-Record-Device': encodeURIComponent(device) },
    body: blob,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '本机录音保存失败');
  return data.item;
}
async function migrateLegacyTakes() {
  try {
    const db = await openTakeDb();
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction('takes', 'readonly').objectStore('takes').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    for (const row of rows) {
      const separator = String(row.key || '').lastIndexOf(':');
      if (separator < 0 || !row.blob) continue;
      const lessonId = row.key.slice(0, separator);
      const sentenceIndex = Number(row.key.slice(separator + 1));
      if (!Number.isInteger(sentenceIndex)) continue;
      await uploadTake(lessonId, sentenceIndex, row.blob, '旧版浏览器录音');
      await new Promise((resolve, reject) => {
        const request = db.transaction('takes', 'readwrite').objectStore('takes').delete(row.key);
        request.onsuccess = resolve; request.onerror = () => reject(request.error);
      });
    }
  } catch (error) { console.warn('旧录音迁移未完成：', error.message); }
}
async function loadSavedLines() {
  state.recordedLines.clear();
  try {
    const rows = await fetch('/api/library', { cache: 'no-store' }).then(response => response.json());
    rows.filter(item => item.materialKind === 'practice-take' && item.lessonId === state.lessonId)
      .forEach(item => state.recordedLines.add(item.sentenceIndex));
  } catch { /* The session still works when local persistence is unavailable. */ }
}
function setCurrentTake(blob) {
  if (state.recordingUrl?.startsWith('blob:')) URL.revokeObjectURL(state.recordingUrl);
  state.recordingBlob = blob;
  state.recordingUrl = blob ? URL.createObjectURL(blob) : null;
  updateRecordStatus();
}
async function loadCurrentTake() {
  const index = state.line;
  try {
    const rows = await fetch('/api/library', { cache: 'no-store' }).then(response => response.json());
    const row = rows.find(item => item.materialKind === 'practice-take' && item.lessonId === state.lessonId && item.sentenceIndex === index);
    const blob = row ? await fetch(`/api/library/${row.id}/audio`, { cache: 'no-store' }).then(response => response.blob()) : null;
    if (state.line !== index) return;
    state.recordingItemId = row?.id || null;
    setCurrentTake(blob);
  } catch {
    if (state.line === index) {
      state.recordingItemId = null;
      setCurrentTake(null);
      $('recordStatus').textContent = '本机录音读取失败；当前仍可重新录制。';
    }
  }
}
async function commitTake(index, blob, source = 'browser') {
  const result = source === 'board'
    ? await api('/api/recordings/from-board', { lessonId: state.lessonId, sentenceIndex: index })
    : { item: await uploadTake(state.lessonId, index, blob, source) };
  state.recordingItemId = result.item?.id || null;
  state.recordedLines.add(index);
  renderLines();
  if (state.line === index) setCurrentTake(blob);
}

function updatePracticeSteps() {
  const recorded = state.recordedLines.has(state.line);
  $('stepListen').classList.toggle('done', state.heard);
  $('stepListen').classList.toggle('active', !state.heard);
  $('stepRecord').classList.toggle('done', recorded);
  $('stepRecord').classList.toggle('active', state.heard && !recorded);
  $('stepCompare').classList.toggle('done', state.compareDone);
  $('stepCompare').classList.toggle('active', recorded && !state.compareDone);
  $('compareButton').disabled = !state.recordingUrl || state.comparing;
  $('compareButton').textContent = state.comparing ? '正在对比…' : state.recordingUrl ? '对比原声和我的跟读' : '先录音，再对比';
  $('recordButton').textContent = state.recordSource ? '结束并保存录音' : recorded ? '重新录下这一句' : '录下我的跟读';
  $('recordButton').classList.toggle('recording', !!state.recordSource);
  $('loopButton').classList.toggle('active', state.looping);
  $('speedBadge').textContent = state.slow ? '慢速 0.75×' : '正常速度';
  $('loopButton').textContent = state.looping ? '停止重复' : '重复本句';
  updateCoach();
}
function updateRecordStatus() {
  if (state.recordSource) {
    $('recordStatus').textContent = state.recordSource === 'board' ? '正在使用键盘麦克风录音…' : '正在使用电脑麦克风录音…';
  } else if (state.recordingUrl) {
    $('recordStatus').textContent = '这句已有录音，已保存在本机；可以对比或重新录制。';
  } else {
    $('recordStatus').textContent = '录音会按句保存在这台设备上，不需要逐条上传。';
  }
  updatePracticeSteps();
}
function updateButtons() {
  for (const button of actionButtons) {
    button.classList.toggle('active',
      (button.dataset.action === 'loop' && state.looping) ||
      (button.dataset.action === 'speed' && state.slow));
  }
  updatePracticeSteps();
  $('abA').textContent = `开始位置：${state.a === null ? format(segment().start) : format(state.a)}`;
  $('abB').textContent = `结束位置：${state.b === null ? format(segment().end) : format(state.b)}`;
}
function renderLines() {
  const list = $('lineList');
  list.replaceChildren();
  if (!state.mediaFile) return;
  const lines = state.captions.length ? state.captions : [{ ...segment(), text: '整段音频（尚无逐句文本）' }];
  lines.forEach((line, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `line-item${index === state.line ? ' selected' : ''}`;
    button.setAttribute('aria-current', index === state.line ? 'true' : 'false');
    const number = document.createElement('span'); number.className = 'index'; number.textContent = String(index + 1).padStart(2, '0');
    const caption = document.createElement('span'); caption.className = 'caption'; caption.textContent = line.text;
    const flags = document.createElement('span'); flags.className = 'line-flags';
    if (state.recordedLines.has(index)) { const flag = document.createElement('span'); flag.className = 'flag recorded'; flag.textContent = '已录'; flags.append(flag); }
    if (state.marks[index] === 'weak') { const flag = document.createElement('span'); flag.className = 'flag'; flag.textContent = '待复习'; flags.append(flag); }
    if (state.marks[index] === 'mastered') { const flag = document.createElement('span'); flag.className = 'flag recorded'; flag.textContent = '已掌握'; flags.append(flag); }
    button.append(number, caption, flags);
    button.addEventListener('click', () => { countAction('pointer'); selectLine(index); });
    list.append(button);
  });
  $('weakCount').textContent = `${Object.values(state.marks).filter(x => x === 'weak').length} 条待复习`;
}
function renderCurrent() {
  const line = segment();
  const count = state.captions.length || (state.mediaFile ? 1 : 0);
  $('lineIndex').textContent = `第 ${count ? state.line + 1 : 0} 句 / ${count} 句`;
  $('currentText').textContent = state.mediaFile ? line.text || '整段音频（尚无逐句文本）' : '正在载入练习句子…';
  $('currentTranslation').textContent = state.translations[state.line] || '';
  $('lessonName').textContent = state.mediaFile ? `${state.mediaFile.name} · ${count} 句` : '正在准备';
  $('mediaTimeline').hidden = state.sourceMode === 'speech';
  document.querySelector('.advanced-controls').hidden = state.sourceMode === 'speech';
  const progress = count ? ((state.line + 1) / count) * 100 : 0;
  $('lessonProgress').style.width = `${progress}%`;
  $('lessonProgress').parentElement.setAttribute('aria-valuemax', String(Math.max(count, 1)));
  $('lessonProgress').parentElement.setAttribute('aria-valuenow', String(count ? state.line + 1 : 0));
  renderLines(); updateButtons();
}
function loadMarks() {
  try { state.marks = JSON.parse(localStorage.getItem(markKey()) || '{}') || {}; }
  catch { state.marks = {}; }
}
function saveMarks() { localStorage.setItem(markKey(), JSON.stringify(state.marks)); }

function isVideoFile(file) {
  return file.type?.startsWith('video/') || /\.(mp4|webm|ogv|mov|m4v)$/i.test(file.name || '');
}
function switchMedia(kind, src) {
  if (state.mediaUrl?.startsWith('blob:')) URL.revokeObjectURL(state.mediaUrl);
  const nextMedia = kind === 'video' ? videoMedia : audioMedia;
  for (const element of [audioMedia, videoMedia]) {
    element.pause();
    if (element !== nextMedia) { element.removeAttribute('src'); element.load(); }
  }
  state.mediaKind = kind;
  state.media = nextMedia;
  state.mediaUrl = src;
  nextMedia.src = src;
  nextMedia.load();
  videoStage.hidden = kind !== 'video';
  $('seek').value = '0';
}
async function selectLine(index) {
  if (!state.mediaFile) return say('练习材料还在载入，请稍等。', true);
  if (state.recordSource) return say('先结束并保存当前录音，再换句。', true);
  const count = state.captions.length || 1;
  state.line = Math.max(0, Math.min(count - 1, index));
  window.speechSynthesis?.cancel(); state.utterance = null;
  if (state.sourceMode === 'course' && state.courseAudioIds[state.line]) {
    switchMedia('audio', `/api/library/${encodeURIComponent(state.courseAudioIds[state.line])}/audio`);
  }
  state.a = null; state.b = null; state.heard = false; state.compareDone = false;
  state.phase = 'ready';
  $('feedbackPanel').hidden = true;
  const { start } = bounds();
  if (Number.isFinite(start)) state.media.currentTime = Math.min(start, state.media.duration || start);
  renderCurrent();
  await loadCurrentTake();
  say(`已选第 ${state.line + 1} 句。按键开始听原句。`);
}

async function api(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}
function led(stateName) { api('/api/led', { state: stateName }).catch(() => {}); }
async function playSegment() {
  if (!state.mediaFile) return say('练习材料还在载入，请稍等。', true);
  if (state.phase === 'speaking') {
    state.media.pause(); window.speechSynthesis?.cancel(); state.utterance = null;
    state.phase = 'ready'; updateCoach(); return say('已停止示范播放。');
  }
  if (state.sourceMode === 'speech' || state.demoMode === 'speech') {
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance) return say('当前浏览器不支持系统语音朗读；请选择播放材料原音。', true);
    state.media.pause();
    const text = segment().text?.trim();
    if (!text) return say('这一句没有文字，无法朗读；请选择播放材料原音。', true);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US';
    utterance.rate = state.slow ? 0.75 : 1;
    utterance.onend = () => { if (state.utterance === utterance) finishDemo(); };
    utterance.onerror = event => {
      if (state.utterance !== utterance) return;
      state.utterance = null; state.phase = 'ready'; updateCoach();
      say(`系统语音朗读失败（${event.error || '未知错误'}），可改用材料原音。`, true);
    };
    state.utterance = utterance; state.phase = 'speaking'; updateCoach();
    try { synth.cancel(); synth.speak(utterance); say(`正在用系统语音朗读第 ${state.line + 1} 句。`); led('playing'); }
    catch (error) { state.utterance = null; state.phase = 'ready'; updateCoach(); say(`无法朗读：${error.message}`, true); }
    return;
  }
  if (!state.media.paused) { state.media.pause(); return; }
  const { start, end } = bounds();
  if (end <= start) return say('结束位置要晚于开始位置。', true);
  if (state.media.currentTime < start || state.media.currentTime >= end) state.media.currentTime = start;
  try { state.phase = 'speaking'; updateCoach(); await state.media.play(); say(`正在播放第 ${state.line + 1} 句的材料原音。`); led('playing'); }
  catch (error) { say(`无法播放：${error.message}`, true); }
}

function finishDemo() {
  state.utterance = null; state.heard = true; state.phase = 'awaitingRecord';
  led('idle'); updatePracticeSteps();
  say('示范结束。按键开始跟读，说完后再按一次结束录音。');
}
function setPoint(which) {
  if (!state.mediaFile) return;
  const value = state.media.currentTime;
  if (which === 'a') {
    if (state.b !== null && value >= state.b) return say('开始位置要早于结束位置。', true);
    state.a = value;
  } else {
    const start = state.a ?? segment().start;
    if (value <= start) return say('结束位置要晚于开始位置。', true);
    state.b = value;
  }
  updateButtons(); say(`已设置重复片段${which === 'a' ? '开始' : '结束'}：${format(value)}。`);
}

function startRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  state.recognitionText = '';
  if (!Recognition) { state.recognition = null; state.recognitionSupported = false; return; }
  const recognition = new Recognition();
  recognition.lang = 'en-US'; recognition.continuous = true; recognition.interimResults = false;
  recognition.onresult = event => {
    state.recognitionText = [...event.results].map(result => result[0]?.transcript || '').join(' ');
  };
  recognition.onerror = () => {};
  recognition.onend = () => { state.recognition = null; };
  try { recognition.start(); state.recognition = recognition; state.recognitionSupported = true; }
  catch { state.recognition = null; state.recognitionSupported = false; }
}
function stopRecognition() {
  const recognition = state.recognition;
  state.recognition = null;
  if (!recognition) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 700);
    recognition.addEventListener?.('end', () => { clearTimeout(timer); resolve(); }, { once: true });
    try { recognition.stop(); } catch { clearTimeout(timer); resolve(); }
  });
}
function words(value) {
  return String(value || '').toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
}
function wordDifference(target, spoken) {
  const available = [...spoken];
  const missing = [];
  for (const word of target) {
    const at = available.indexOf(word);
    if (at >= 0) available.splice(at, 1); else missing.push(word);
  }
  return { missing, extra: available };
}
function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) binary += String.fromCharCode(...bytes.subarray(index, index + step));
  return btoa(binary);
}
async function transcribeTake() {
  const settings = currentAnalysisSettings();
  if (settings.provider !== 'openai-transcription' || !state.recordingBlob) return '';
  const bytes = new Uint8Array(await state.recordingBlob.arrayBuffer());
  const response = await fetch('/api/speech/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speech: settings, mimeType: state.recordingBlob.type || 'audio/wav', audioBase64: bytesToBase64(bytes) }),
    cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '云端转写失败');
  return String(result.text || '').trim();
}
async function persistAnalysis(result) {
  if (!state.recordingItemId) return;
  try {
    await api('/api/recordings/analysis', { id: state.recordingItemId, ...result });
  } catch { /* The audio remains usable when metadata update is unavailable. */ }
}
async function analyzeTake() {
  const target = segment().text;
  if (!target.trim()) {
    state.phase = 'feedback'; updateCoach();
    showFeedback('<strong>录音已保存。</strong>这份材料只有整段音频，没有逐句文本，暂时无法判断漏词或自动评分。可以先听原音并自行核对；添加字幕或课程文本后即可逐句分析。');
    say('录音已保存在本机。当前材料没有逐句文本，暂不提供自动评分。');
    return false;
  }
  const targetWords = words(target);
  let spokenText = state.recognitionText;
  let analysisProvider = state.recognitionSupported ? '浏览器语音识别' : '';
  if (!spokenText && currentAnalysisSettings().provider === 'openai-transcription') {
    try {
      say('录音已保存，正在请求云端转写并分析。');
      spokenText = await transcribeTake();
      analysisProvider = 'OpenAI 兼容语音识别';
      state.recognitionText = spokenText;
    } catch (error) {
      state.phase = 'feedback'; updateCoach();
      await persistAnalysis({ analysisProvider: '云端转写', analysisResult: 'unavailable', analysisFeedback: error.message });
      showFeedback(`<strong>录音已保存，但暂时无法完成云端转写。</strong>${error.message} 可以检查设置后重试，或改用浏览器语音识别。`);
      say('录音已保存，云端转写失败；请检查识别设置后重试。', true);
      return false;
    }
  }
  const spokenWords = words(spokenText);
  if (!spokenWords.length) {
    state.phase = 'feedback'; updateCoach();
    await persistAnalysis({ analysisProvider: analysisProvider || '未配置识别服务', analysisResult: 'unavailable', analysisFeedback: '没有返回文字识别结果' });
    showFeedback('<strong>AI 反馈：</strong>录音已经保存并完成原声对比，但浏览器没有返回文字识别结果。请再听一遍，重点把每个词说完整，然后按键重练。');
    say('录音已保存。当前设备没有返回文字识别，先按反馈再练一次。');
    return false;
  }
  const { missing, extra } = wordDifference(targetWords, spokenWords);
  const score = Math.max(0, 1 - (missing.length + extra.length) / Math.max(targetWords.length, 1));
  if (score >= 0.82) {
    state.phase = 'passed'; state.marks[state.line] = 'mastered'; saveMarks(); renderLines(); updateCoach();
    await persistAnalysis({ transcript: spokenText, analysisProvider: analysisProvider || '词语对比', analysisResult: 'passed', analysisScore: score, analysisFeedback: '主要内容与原句一致' });
    showFeedback(`<strong>AI 反馈：这一句通过。</strong>识别到 ${spokenWords.length} 个词，主要内容与原句一致。${missing.length ? `可以再注意：${missing.join(', ')}。` : ''}`, true);
    say('这一句练习通过了。按键进入下一句。'); led('mastered');
    return true;
  }
  state.phase = 'feedback'; state.marks[state.line] = 'weak'; saveMarks(); renderLines(); updateCoach();
  const details = [missing.length ? `漏读：${missing.join(', ')}` : '', extra.length ? `多读或替换：${extra.join(', ')}` : ''].filter(Boolean).join('；');
  await persistAnalysis({ transcript: spokenText, analysisProvider: analysisProvider || '词语对比', analysisResult: 'retry', analysisScore: score, analysisFeedback: details || '有些词没有被准确识别' });
  showFeedback(`<strong>AI 反馈：</strong>这句还需要再练。${details || '有些词没有被准确识别'}。先听原句的节奏，再按键重练。`);
  say('AI 已给出反馈。按键重听并再次跟读。'); led('weak');
  return false;
}

function browserRecord() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('当前浏览器不支持麦克风录音');
  state.recordingLine = state.line;
  state.stream = null;
  return navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    state.stream = stream;
    state.chunks = [];
    const recorder = new MediaRecorder(stream);
    state.recorder = recorder;
    recorder.addEventListener('dataavailable', event => { if (event.data.size) state.chunks.push(event.data); });
    recorder.addEventListener('stop', () => {
      const blob = new Blob(state.chunks, { type: recorder.mimeType || 'audio/webm' });
      state.persistPromise = commitTake(state.recordingLine, blob).then(() => say('这句跟读已保存在本机。'))
        .catch(error => say(`录音完成，但本机保存失败：${error.message}`, true));
      state.stream?.getTracks().forEach(track => track.stop());
      state.stream = null;
    }, { once: true });
    recorder.start(); state.recordSource = 'browser'; startRecognition();
  });
}
async function startRecord() {
  if (state.recordSource) return;
  if (!state.mediaFile) return say('练习材料还在载入，请稍等。', true);
  state.media.pause();
  state.compareDone = false;
  try {
    const status = await fetch('/api/status', { cache: 'no-store' }).then(response => response.json());
    if (status.micConnected) {
      state.recordingLine = state.line;
      await api('/api/record/start');
      state.recordSource = 'board';
      say('开始录音。');
    } else {
      await browserRecord();
      say('开始录音。');
    }
    state.phase = 'recording'; led('recording'); updateRecordStatus(); updateCoach();
  } catch (error) { say(`录音没有开始：${error.message}`, true); }
}
async function stopRecord() {
  if (!state.recordSource) return;
  const source = state.recordSource;
  const line = state.recordingLine;
  state.recordSource = null;
  try {
    if (source === 'board') {
      await api('/api/record/stop');
      const response = await fetch(`/api/record/latest.wav?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('没有取回录音文件');
      await commitTake(line, await response.blob(), 'board');
    } else {
      const recorder = state.recorder;
      await stopRecognition();
      if (recorder?.state === 'recording') {
        await new Promise(resolve => { recorder.addEventListener('stop', resolve, { once: true }); recorder.stop(); });
      }
      await state.persistPromise;
    }
    state.phase = 'analyzing'; updateCoach(); say('录音已收到，AI 正在播放对比并分析。');
    await compare();
    await analyzeTake();
    led('idle');
  } catch (error) {
    say(`录音保存失败：${error.message}`, true);
    led('idle');
  } finally {
    state.recorder = null;
    updateRecordStatus();
  }
}
async function compare() {
  if (!state.recordingUrl) return say('先录下这一句，再对比。', true);
  if (state.comparing) return;
  state.comparing = true;
  const originalLoop = state.looping;
  state.looping = false; updateButtons();
  const { start, end } = bounds();
  const recording = new Audio(state.recordingUrl);
  try {
    say('先听原句，接着听你的跟读。');
    if (state.sourceMode === 'speech') {
      const synth = window.speechSynthesis;
      if (!synth || !window.SpeechSynthesisUtterance) throw new Error('当前浏览器不支持系统语音朗读');
      await new Promise((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(segment().text);
        utterance.lang = 'en-US'; utterance.rate = state.slow ? 0.75 : 1;
        utterance.onend = resolve;
        utterance.onerror = event => reject(new Error(event.error || '语音播放失败'));
        synth.cancel(); synth.speak(utterance);
      });
    } else {
      state.media.currentTime = start;
      await state.media.play();
      await new Promise(resolve => {
        const poll = setInterval(() => {
          if (state.media.paused || state.media.currentTime >= end) { clearInterval(poll); state.media.pause(); resolve(); }
        }, 40);
      });
    }
    await recording.play();
    await new Promise(resolve => { recording.onended = resolve; recording.onerror = resolve; });
    state.compareDone = true;
    say('对比完成。可以重录这一句，或继续下一句。');
  } catch (error) { say(`对比播放失败：${error.message}`, true); }
  finally { recording.pause(); state.comparing = false; state.looping = originalLoop; updateButtons(); led('idle'); }
}

function countAction(input) {
  const current = state.benchmark.current;
  if (current) current[input]++;
}
async function action(name, input = 'pointer') {
  countAction(input);
  switch (name) {
    case 'practice':
      if (state.phase === 'speaking') {
        state.media.pause(); window.speechSynthesis?.cancel(); state.utterance = null;
        state.phase = 'ready'; updateCoach(); say('已停止示范播放。'); break;
      }
      if (state.phase === 'analyzing') return;
      if (state.phase === 'recording') { await stopRecord(); break; }
      if (state.phase === 'awaitingRecord') { await startRecord(); break; }
      if (state.phase === 'passed' && state.line < state.captions.length - 1) { await selectLine(state.line + 1); break; }
      await playSegment(); break;
    case 'previous': await selectLine(state.line - 1); break;
    case 'next': await selectLine(state.line + 1); break;
    case 'listen': await playSegment(); break;
    case 'replay': state.media.pause(); state.media.currentTime = bounds().start; await playSegment(); break;
    case 'play': if (state.media.paused) await playSegment(); else state.media.pause(); break;
    case 'setA': setPoint('a'); break;
    case 'setB': setPoint('b'); break;
    case 'clearRange': state.a = null; state.b = null; updateButtons(); say('已恢复重复整句。'); break;
    case 'loop': state.looping = !state.looping; updateButtons(); say(state.looping ? '将重复播放这一句。' : '已停止重复。'); break;
    case 'speed': state.slow = !state.slow; state.media.playbackRate = state.slow ? .75 : 1; updateButtons(); say(state.slow ? '已切换为慢速。' : '已恢复正常速度。'); break;
    case 'record': if (state.recordSource) await stopRecord(); else await startRecord(); break;
    case 'compare': await compare(); break;
    case 'weak': state.marks[state.line] = 'weak'; saveMarks(); renderLines(); led('weak'); say('已加入待复习。'); break;
    case 'master': state.marks[state.line] = 'mastered'; saveMarks(); renderLines(); led('mastered'); say('已标记为掌握。'); break;
  }
}

for (const button of actionButtons) button.addEventListener('click', () => action(button.dataset.action));

function setActiveView(name) {
  document.querySelectorAll('[data-view-panel]').forEach(panel => { panel.hidden = panel.dataset.viewPanel !== name; });
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (name === 'library') $('materialTools').hidden = false;
  if (name === 'library') renderLibrary();
  if (name === 'practice') renderPracticeQueue();
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setActiveView(button.dataset.view)));
$('libraryMount').append($('materialTools'));
$('materialTools').hidden = false;
$('settingsMount').append(...document.querySelectorAll('.practice-side > .secondary-tools'));
$('openMaterials').addEventListener('click', () => setActiveView('library'));
$('practiceQueueItems').addEventListener('click', event => {
  const button = event.target.closest('[data-queue-id]');
  if (button) openLibraryMaterial(button.dataset.queueId, button.dataset.queueKind);
});
async function renderPracticeQueue() {
  const container = $('practiceQueueItems');
  container.replaceChildren();
  try {
    const response = await fetch('/api/library', { cache: 'no-store' });
    if (!response.ok) throw new Error('本机材料库暂不可用');
    const materials = (await response.json()).filter(item =>
      item.materialKind === 'lesson-plan' || (item.bucket !== 'recordings' && item.materialKind !== 'lesson-audio' && item.mimeType?.startsWith('audio/')));
    $('practiceQueueCount').textContent = `${materials.length + 1} 项可练习`;
    const builtIn = document.createElement('button');
    builtIn.type = 'button'; builtIn.textContent = '内置课程 · AI 硬件开发入门英语';
    builtIn.addEventListener('click', () => loadBuiltInLesson());
    container.append(builtIn);
    for (const item of materials.slice(0, 8)) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.queueId = item.id;
      button.dataset.queueKind = item.materialKind === 'lesson-plan' ? 'plan' : 'audio';
      button.textContent = `${item.materialKind === 'lesson-plan' ? '逐句课程' : '原音素材'} · ${item.name.replace(/\.(json|mp3|wav|ogg|m4a)$/i, '')}`;
      container.append(button);
    }
  } catch (error) {
    $('practiceQueueCount').textContent = '内置课程可用';
    container.textContent = `本机材料暂时无法读取：${error.message}`;
  }
}
$('libraryItems').addEventListener('click', event => {
  if (event.target.closest('[data-open-builtin]')) setActiveView('practice');
  const button = event.target.closest('[data-library-id]');
  if (button) openLibraryMaterial(button.dataset.libraryId, button.dataset.libraryKind);
});
async function renderLibrary() {
  const list = $('libraryItems');
  list.replaceChildren();
  const item = document.createElement('article'); item.className = 'library-item';
  const detail = document.createElement('div');
  const title = document.createElement('h3'); title.textContent = 'AI 硬件开发入门英语';
  const description = document.createElement('p'); description.textContent = '内置语音 · 5 句 · 打开即可练习';
  detail.append(title, description);
  const open = document.createElement('button'); open.type = 'button'; open.dataset.openBuiltin = 'true'; open.textContent = '开始练习';
  item.append(detail, open); list.append(item);
  let count = 1;
  try {
    const response = await fetch('/api/library', { cache: 'no-store' });
    if (!response.ok) throw new Error('读取材料库失败');
    const materials = await response.json();
    for (const material of materials) {
      const row = document.createElement('article'); row.className = 'library-item';
      const info = document.createElement('div');
      const name = document.createElement('h3'); name.textContent = material.name;
      const kind = material.materialKind === 'lesson-plan' ? `AI 教学计划 · ${material.generatedAudioCount || 0} 句本机语音` : material.materialKind === 'lesson-audio' ? `第 ${(material.sentenceIndex || 0) + 1} 句 · 已进入对应课程练习` : material.materialKind === 'practice-take' ? `跟读录音 · 第 ${(material.sentenceIndex || 0) + 1} 句 · ${material.device || '本机'}` : material.materialKind === 'source-text' ? '文字来源' : material.materialKind === 'source-image' ? '图片来源' : material.materialKind === 'source-video' ? '视频来源' : material.materialKind === 'source-link' ? '来源链接 · 待解析' : material.type;
      const source = material.sourceProvider ? ` · ${material.sourceProvider} · ${material.creator || ''} · ${material.license ? `CC ${material.license.toUpperCase()}` : ''}` : '';
      const meta = document.createElement('p'); meta.textContent = `${kind}${source} · ${formatBytes(material.sizeBytes)}`;
      info.append(name, meta);
      const actionButton = document.createElement('button'); actionButton.type = 'button'; actionButton.dataset.libraryId = material.id;
      actionButton.dataset.libraryKind = material.materialKind === 'lesson-plan' ? 'plan' : material.materialKind === 'source-link' ? 'link' : material.materialKind === 'source-text' ? 'text' : material.materialKind === 'source-image' ? 'image' : material.materialKind === 'source-video' ? 'video' : 'audio';
      actionButton.textContent = material.materialKind === 'lesson-plan' ? '开始练习' : material.materialKind === 'source-link' ? '查看来源' : material.materialKind === 'source-text' || material.materialKind === 'source-image' ? '用此主题规划' : material.materialKind === 'source-video' ? '打开视频' : '打开并练习';
      if (material.materialKind === 'source-link') {
        const anchor = document.createElement('a'); anchor.href = material.sourceUrl; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.textContent = '查看来源';
        row.append(info, anchor); list.append(row); count++; continue;
      }
      if (material.materialKind === 'practice-take') {
        const player = document.createElement('audio'); player.controls = true; player.preload = 'none'; player.src = `/api/library/${encodeURIComponent(material.id)}/audio`;
        row.append(info, player); list.append(row); count++; continue;
      }
      row.append(info, actionButton); list.append(row); count++;
    }
  } catch { /* Built-in course remains usable without the local library endpoint. */ }
  $('libraryCount').textContent = `${count} 项材料`;
}
function formatBytes(bytes = 0) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
async function openLibraryMaterial(id, kind) {
  try {
    const response = await fetch(`/api/library/${encodeURIComponent(id)}/audio`, { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取这项材料');
    if (kind === 'link') {
      const source = await response.json();
      window.open(source.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (kind === 'text') {
      const source = await response.json();
      $('taskGoal').value = source.title || source.excerpt || '';
      $('taskAvailability').textContent = '已选这份文字来源。点击“搜集并生成整套教学材料”，AI 会据此规划原创练习句。';
      setActiveView('coach'); return;
    }
    if (kind === 'image') {
      const material = (await fetch('/api/library').then(reply => reply.json())).find(item => item.id === id);
      $('taskGoal').value = material?.name?.replace(/\.[^.]+$/, '') || '';
      $('taskAvailability').textContent = '已选这张图片的主题。AI 将用标题和来源信息规划原创英语练习句。';
      setActiveView('coach'); return;
    }
    if (kind === 'video') {
      const blob = await response.blob();
      state.mediaFile = new File([blob], '材料库视频', { type: blob.type || 'video/webm' });
      state.lessonId = `library:${id}`; state.captions = []; state.translations = []; state.line = 0;
      state.sourceMode = 'audio'; state.demoMode = 'media'; state.phase = 'ready'; state.heard = false;
      switchMedia('video', URL.createObjectURL(blob)); loadMarks(); await loadSavedLines(); renderCurrent(); await loadCurrentTake();
      setActiveView('practice'); say('视频已打开；如果已经提取音轨，可从“接下来练什么”打开音轨练习。'); return;
    }
    if (kind === 'plan') {
      let plan = await response.json();
      if (!Array.isArray(plan.sentences) || !plan.sentences.length) throw new Error('课程计划没有可练习的句子');
      let voiceNotice = '';
      if (!Array.isArray(plan.audioIds) || plan.audioIds.length !== plan.sentences.length) {
        try {
          say('正在为这份课程补生成逐句语音…');
          const prepared = await api('/api/coach/prepare-audio', { materialId: id, speech: currentSpeechSettings() });
          plan = prepared.plan;
          renderLibrary();
        } catch (error) { voiceNotice = `本机语音未生成：${error.message}；本次使用系统朗读。`; }
      }
      const lines = plan.sentences.filter(sentence => String(sentence.text || '').trim());
      state.media?.pause(); window.speechSynthesis?.cancel();
      state.mediaFile = { name: plan.title || 'AI 课程', type: 'text/course' };
      state.lessonId = `library:${id}`;
      state.captions = lines.map(sentence => ({ start: 0, end: 0, text: String(sentence.text || '').trim() }));
      state.translations = lines.map(sentence => String(sentence.translation || ''));
      state.line = 0; state.a = null; state.b = null; state.looping = false; state.slow = false;
      state.courseAudioIds = Array.isArray(plan.audioIds) ? plan.audioIds : [];
      state.sourceMode = state.courseAudioIds.length === state.captions.length ? 'course' : 'speech';
      state.demoMode = state.sourceMode === 'course' ? 'media' : 'speech';
      if (state.sourceMode === 'course') switchMedia('audio', `/api/library/${encodeURIComponent(state.courseAudioIds[0])}/audio`);
      state.phase = 'ready'; state.heard = false; state.compareDone = false;
      $('feedbackPanel').hidden = true;
      loadMarks(); await loadSavedLines(); renderCurrent(); await loadCurrentTake();
      setActiveView('practice'); say(`已打开“${plan.title || 'AI 课程'}”，共 ${state.captions.length} 句。按键听示范，再按键跟读。${voiceNotice}`); return;
    }
    const blob = await response.blob();
    state.mediaFile = new File([blob], '材料库音频', { type: blob.type || 'audio/wav' });
    state.lessonId = `library:${id}`; state.captions = []; state.line = 0; state.translations = [];
    const material = (await fetch('/api/library').then(reply => reply.json())).find(item => item.id === id);
    if (material?.transcript) { state.captions = [{ start: 0, end: 0, text: material.transcript }]; state.translations = [material.translation || '']; }
    state.sourceMode = 'audio'; state.demoMode = 'media'; state.phase = 'ready'; state.heard = false; state.compareDone = false;
    $('feedbackPanel').hidden = true;
    switchMedia('audio', URL.createObjectURL(blob)); loadMarks(); await loadSavedLines(); renderCurrent(); await loadCurrentTake();
    setActiveView('practice'); say('已打开材料库音频，可以播放并录下跟读。');
  } catch (error) { $('taskAvailability').textContent = `打开失败：${error.message}`; }
}
renderLibrary();
function readCoachTasks() {
  try { return JSON.parse(localStorage.getItem('easyinput-coach-tasks') || '[]'); }
  catch { return []; }
}
function saveCoachTasks(tasks) { localStorage.setItem('easyinput-coach-tasks', JSON.stringify(tasks)); }
function renderCoachTasks() {
  const tasks = readCoachTasks();
  const container = $('coachTasks'); container.replaceChildren();
  $('taskCount').textContent = `${tasks.length} 项任务`;
  if (!tasks.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '还没有规划任务。'; container.append(empty); return;
  }
  for (const task of tasks) {
    const row = document.createElement('article'); row.className = 'coach-task';
    const detail = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = task.goal;
    const meta = document.createElement('p'); meta.textContent = `${task.type} · ${task.createdAt} · ${task.level} · ${task.minutes} 分钟 · ${task.status}`;
    detail.append(title, meta);
    const status = document.createElement('span'); status.className = 'task-state'; status.textContent = task.status;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'task-remove'; remove.dataset.removeTask = task.id; remove.setAttribute('aria-label', `删除任务：${task.goal}`); remove.textContent = '删除';
    const actions = document.createElement('div'); actions.className = 'task-row-actions'; actions.append(status, remove);
    row.append(detail, actions);
    if (task.stages?.length) {
      const stages = document.createElement('ol'); stages.className = 'task-stage-list';
      task.stages.forEach(stage => {
        const entry = document.createElement('li');
        const name = document.createElement('strong'); name.textContent = stage.name;
        const stageStatus = document.createElement('span'); stageStatus.textContent = stage.status;
        entry.append(name, stageStatus); stages.append(entry);
      });
      row.append(stages);
    }
    if (task.plan?.sentences?.length) {
      const results = document.createElement('div'); results.className = 'coach-task-results';
      const heading = document.createElement('strong'); heading.textContent = `${task.plan.title} · ${task.plan.sentences.length} 句教学材料`;
      const list = document.createElement('ol');
      for (const sentence of task.plan.sentences) {
        const line = document.createElement('li');
        line.textContent = `${sentence.text}${sentence.translation ? ` · ${sentence.translation}` : ''}${sentence.focus ? `（${sentence.focus}）` : ''}`;
        list.append(line);
      }
      results.append(heading, list); row.append(results);
    }
    if (task.sources?.length) {
      const sources = document.createElement('p');
      sources.className = 'task-availability';
      sources.textContent = task.sources.map(source => `${source.provider}：${source.status === 'ok' ? `${source.count} 条` : `失败（${source.error}）`}`).join(' · ');
      row.append(sources);
    }
    if (task.results?.length) {
      const results = document.createElement('div'); results.className = 'coach-task-results';
      const heading = document.createElement('strong'); heading.textContent = `找到 ${task.results.length} 条候选素材`;
      results.append(heading);
      for (const candidate of task.results) {
        const item = document.createElement('div'); item.className = 'audio-candidate';
        const info = document.createElement('div');
        const name = document.createElement('strong'); name.textContent = candidate.title;
        const labels = { text: '文字', audio: '音频', video: '视频', image: '图片' };
        const byline = document.createElement('p'); byline.textContent = `${candidate.provider || 'Openverse'} · ${labels[candidate.type] || candidate.type} · ${candidate.creator || '作者待查'} · ${candidate.license || '许可待查'} ${candidate.licenseVersion || ''}`;
        const excerpt = document.createElement('p'); excerpt.textContent = candidate.excerpt || '';
        const source = document.createElement('a'); source.href = candidate.sourceUrl; source.target = '_blank'; source.rel = 'noreferrer'; source.textContent = '查看来源与许可';
        info.append(name, byline, excerpt, source);
        const importButton = document.createElement('button'); importButton.type = 'button'; importButton.dataset.importCandidate = candidate.candidateId;
        if (candidate.imported) { importButton.textContent = '已导入'; importButton.disabled = true; }
        else if (candidate.canImport) importButton.textContent = candidate.type === 'text' ? '保存文字来源' : candidate.type === 'video' ? '导入视频并提取音轨' : candidate.type === 'image' ? '保存图片来源' : '导入音频';
        else { importButton.textContent = '许可待确认'; importButton.disabled = true; }
        item.append(info, importButton); results.append(item);
      }
      row.append(results);
    }
    container.append(row);
  }
}
async function createCoachTask(type) {
  const goal = $('taskGoal').value.trim();
  if (!goal) { $('taskAvailability').textContent = '先填写学习目标，再创建任务。'; $('taskGoal').focus(); return; }
  if (type === '完整工作流') return runTeachingWorkflow(goal);
  const tasks = readCoachTasks();
  const task = { id: crypto.randomUUID(), type, goal, level: $('taskLevel').value, minutes: Number($('taskDuration').value), createdAt: new Date().toLocaleString(), status: '正在执行' };
  tasks.unshift(task); saveCoachTasks(tasks); renderCoachTasks();
  $('taskAvailability').textContent = type === '课程规划' ? '正在调用设置中选择的模型…' : '正在搜索英文文本、开放许可图像、音频和视频…';
  try {
    if (type === '课程规划') {
      const config = JSON.parse(localStorage.getItem('easyinput-provider-settings') || '{}');
      task.plan = await api('/api/coach/plan', {
        provider: config.provider, model: $('modelName').value || config.model, apiKey: $('modelKey').value,
        goal, level: task.level, minutes: task.minutes,
      });
      task.status = `已生成 ${task.plan.sentences.length} 句课程草案`;
      $('taskAvailability').textContent = '课程计划、逐句翻译和教学重点已生成并保存到任务记录。';
    } else {
      const config = JSON.parse(localStorage.getItem('easyinput-provider-settings') || '{}');
      const search = await api('/api/materials/search-all', { query: goal, provider: config.provider, model: $('modelName').value || config.model, apiKey: $('modelKey').value });
      task.results = search.results;
      task.sources = search.sources; task.englishQuery = search.englishQuery;
      task.status = search.results.length ? `找到 ${search.results.length} 条候选素材` : '公开来源未找到匹配素材';
      $('taskAvailability').textContent = `搜索词：${search.englishQuery}。${search.sources.map(source => `${source.provider} ${source.count} 条`).join('，')}。${search.queryWarning ? ` 搜索词翻译未完成：${search.queryWarning}。` : ''}`;
    }
  } catch (error) {
    task.status = `失败：${error.message}`;
    $('taskAvailability').textContent = `任务失败：${error.message}`;
  }
  saveCoachTasks(tasks); renderCoachTasks();
}
$('planTask').addEventListener('click', () => createCoachTask('课程规划'));
$('collectTask').addEventListener('click', () => createCoachTask('素材搜集'));
$('runWorkflow').addEventListener('click', () => createCoachTask('完整工作流'));
$('saveSourceLink').addEventListener('click', async () => {
  const input = $('sourceLink');
  const url = input.value.trim();
  if (!url) { $('taskAvailability').textContent = '请先粘贴完整的 HTTPS 素材链接。'; input.focus(); return; }
  try {
    const { item } = await api('/api/materials/bookmark', { url });
    input.value = '';
    $('taskAvailability').textContent = `已保存到材料库：${item.sourceProvider} 的${item.sourceType === 'video' ? '视频' : item.sourceType === 'audio' ? '音频' : '网页'}链接。媒体和字幕尚未提取，请在材料库查看来源。`;
    renderLibrary();
  } catch (error) { $('taskAvailability').textContent = `保存链接失败：${error.message}`; }
});
$('copyAgentBrief').addEventListener('click', async () => {
  const goal = $('taskGoal').value.trim() || '普通心理学英语口语';
  const brief = `请围绕“${goal}”搜集适合英语听说练习的公开文字、图片、音频和视频。优先找有明确许可与来源、英语发音清晰、有字幕或可转写的短素材。使用 easyinput-learning-coach MCP 的 search_learning_sources、bookmark_learning_source、import_search_candidate 和 list_learning_materials 工具，把可用素材归档到本机材料库；记录来源、作者、许可、素材类型。不要把仅有链接的 B 站视频说成已下载或已提取音轨。最后给出由浅入深的口语练习建议，并告诉我在 EasyInput 的 AI 教练页运行完整工作流生成逐句语音课程。`;
  try { await navigator.clipboard.writeText(brief); $('agentBridgeStatus').textContent = '任务说明已复制。粘贴到 Codex 或 WorkBuddy 对话中即可。'; }
  catch { $('agentBridgeStatus').textContent = '浏览器未允许复制，请在桌面浏览器中使用此按钮。'; }
});
renderCoachTasks();
$('coachTasks').addEventListener('click', event => {
  const candidateId = event.target.closest('[data-import-candidate]')?.dataset.importCandidate;
  if (candidateId) { importCoachCandidate(candidateId); return; }
  const id = event.target.closest('[data-remove-task]')?.dataset.removeTask;
  if (!id) return;
  saveCoachTasks(readCoachTasks().filter(task => task.id !== id));
  renderCoachTasks();
});
async function importCoachCandidate(candidateId) {
  const tasks = readCoachTasks();
  const candidate = tasks.flatMap(task => task.results || []).find(result => result.candidateId === candidateId);
  if (!candidate) return;
  const button = document.querySelector(`[data-import-candidate="${CSS.escape(candidateId)}"]`);
  if (button) { button.disabled = true; button.textContent = '正在导入…'; }
  try {
    const { item, original, warning } = await api('/api/materials/import', { candidateId });
    candidate.imported = true; candidate.materialId = item.id;
    saveCoachTasks(tasks); renderCoachTasks();
    $('taskAvailability').textContent = `已导入材料库：${original ? `${original.name}；${item.id !== original.id ? `已提取音轨 ${item.name}` : '未提取音轨'}` : item.name}。${warning || ''}`;
    renderPracticeQueue();
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '重试导入'; }
    $('taskAvailability').textContent = `导入失败：${error.message}`;
  }
}
async function runTeachingWorkflow(goal) {
  const tasks = readCoachTasks();
  const task = {
    id: crypto.randomUUID(), type: '完整工作流', goal, level: $('taskLevel').value,
    minutes: Number($('taskDuration').value), createdAt: new Date().toLocaleString(), status: '正在执行',
    stages: ['搜集素材', '整理与归档', '结合进度规划', '生成教学材料', '发布到材料库'].map(name => ({ name, status: '待开始' })),
    results: [], importedMaterials: [],
  };
  tasks.unshift(task); saveCoachTasks(tasks); renderCoachTasks();
  const advance = (index, status) => {
    task.stages[index].status = status;
    saveCoachTasks(tasks); renderCoachTasks();
    $('taskAvailability').textContent = `${task.stages[index].name}：${status}`;
  };
  try {
    advance(0, '正在搜索英文文本、开放许可图像、音频和视频');
    const config = JSON.parse(localStorage.getItem('easyinput-provider-settings') || '{}');
    const search = await api('/api/materials/search-all', { query: goal, provider: config.provider, model: $('modelName').value || config.model, apiKey: $('modelKey').value });
    task.results = search.results;
    task.sources = search.sources; task.englishQuery = search.englishQuery;
    advance(0, `完成，找到 ${search.results.length} 条`);

    const terms = String(search.englishQuery || '').toLowerCase().split(/\W+/).filter(term => term.length > 3);
    const relevant = item => terms.some(term => String(item.title || '').toLowerCase().includes(term));
    const importable = ['text', 'audio', 'image', 'video'].map(type =>
      search.results.find(item => item.type === type && item.canImport && (type === 'text' || relevant(item)) && (type !== 'video' || item.sizeBytes <= 15 * 1024 * 1024)))
      .filter(Boolean);
    advance(1, importable.length ? `正在导入 ${importable.length} 条许可明确的素材` : '没有许可明确的素材，继续生成原创课程');
    for (const candidate of importable) {
      try {
        const { item, original, warning } = await api('/api/materials/import', { candidateId: candidate.candidateId });
        candidate.imported = true; candidate.materialId = item.id;
        candidate.importWarning = warning || '';
        task.importedMaterials.push({ id: item.id, name: item.name, sourceUrl: item.sourceUrl, license: item.license, creator: item.creator });
        if (original && original.id !== item.id) task.importedMaterials.push({ id: original.id, name: original.name, sourceUrl: original.sourceUrl, license: original.license, creator: original.creator });
        saveCoachTasks(tasks); renderCoachTasks();
      } catch (error) {
        candidate.importError = error.message;
      }
    }
    if (importable.length) advance(1, `完成，已归档 ${task.importedMaterials.length} 条`);

    advance(2, '正在结合目标、水平和时长规划');
    task.plan = await api('/api/coach/plan', {
      provider: config.provider, model: $('modelName').value || config.model, apiKey: $('modelKey').value,
      goal, level: task.level, minutes: task.minutes,
      sourceMaterials: [
        ...task.results.filter(item => item.type === 'text').slice(0, 4),
        ...task.results.filter(item => item.type === 'image').slice(0, 2),
        ...task.results.filter(item => item.type === 'video').slice(0, 2),
        ...task.results.filter(item => item.type === 'audio').slice(0, 2),
      ],
    });
    advance(2, `完成，${task.plan.sentences.length} 句`);

    advance(3, '已生成逐句原文、翻译和教学重点，正在生成逐句语音');
    const published = await api('/api/coach/publish', { plan: task.plan, sourceMaterials: task.importedMaterials, speech: currentSpeechSettings() });
    task.materialId = published.item.id;
    task.audioWarning = published.audioWarning || '';
    advance(4, `已保存到材料库：${published.item.name}`);
    task.status = '工作流完成';
    $('taskAvailability').textContent = `完成：${task.plan.title} 已入库，包含 ${task.plan.sentences.length} 句教学材料、${published.audioItems?.length || 0} 条本机语音。${published.audioWarning ? `语音生成提示：${published.audioWarning}` : ''}`;
    await renderPracticeQueue();
    await openLibraryMaterial(task.materialId, 'plan');
  } catch (error) {
    const current = task.stages.find(stage => stage.status.startsWith('正在'));
    if (current) current.status = `失败：${error.message}`;
    task.status = `中断：${error.message}`;
    $('taskAvailability').textContent = `工作流在“${current?.name || '执行'}”阶段中断。已完成阶段和已导入素材已保留，可修正配置后重新运行。`;
  }
  saveCoachTasks(tasks); renderCoachTasks();
}
$('modelProvider').addEventListener('change', () => {
  const endpoints = { openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com/v1', qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1', kimi: 'https://api.moonshot.cn/v1', ollama: 'http://127.0.0.1:11434' };
  $('modelEndpoint').value = endpoints[$('modelProvider').value] || '';
  $('refreshModels').disabled = ['builtin', 'custom'].includes($('modelProvider').value);
  $('modelCatalogStatus').textContent = $('modelProvider').value === 'custom' ? '自定义服务暂不支持自动读取模型目录。' : '填写对应服务商的 API Key 后获取官方当前可用模型。';
  updatePlannerStatus();
});
function updatePlannerStatus() {
  const provider = $('modelProvider').value;
  const labels = { builtin: '本地练习', openai: 'OpenAI 兼容接口', deepseek: 'DeepSeek', qwen: '通义千问', kimi: 'Kimi', ollama: 'Ollama', custom: '自定义接口' };
  const name = labels[provider] || provider;
  if (provider === 'builtin') {
    $('plannerStatus').textContent = '已就绪：本地练习模式，不调用外部教学模型。';
    return;
  }
  const model = $('modelName').value.trim();
  if (!model) {
    $('plannerStatus').textContent = `已选择${name}，还没有选择教学模型。`;
    return;
  }
  if (provider !== 'ollama' && !$('modelKey').value.trim()) {
    $('plannerStatus').textContent = `已选择${name} · ${model}，还缺教学模型 API Key。语音 API 需要在下方单独配置。`;
    return;
  }
  $('plannerStatus').textContent = `已就绪：${name} · ${model}。API Key 只在本次页面会话中使用。`;
}
try {
  const config = JSON.parse(localStorage.getItem('easyinput-provider-settings') || '{}');
  $('modelProvider').value = config.provider || 'builtin';
  $('modelEndpoint').value = config.endpoint || '';
  if (config.model) $('modelName').add(new Option(config.model, config.model, true, true));
  $('modelKey').value = typeof config.apiKey === 'string' ? config.apiKey : '';
  if (config.apiKey) {
    delete config.apiKey;
    localStorage.setItem('easyinput-provider-settings', JSON.stringify(config));
    $('plannerStatus').textContent = '已将旧设置中的 API Key 转为当前页面临时输入；此后不再写入浏览器存储。';
  }
  $('refreshModels').disabled = ['builtin', 'custom'].includes($('modelProvider').value);
} catch { /* Start with local-only settings if browser storage is unavailable. */ }
updatePlannerStatus();
$('modelKey').addEventListener('input', updatePlannerStatus);
$('saveModelSettings').addEventListener('click', () => {
  const config = { provider: $('modelProvider').value, endpoint: $('modelEndpoint').value.trim(), model: $('modelName').value };
  localStorage.setItem('easyinput-provider-settings', JSON.stringify(config));
  updatePlannerStatus();
});
$('clearModelKey').addEventListener('click', () => {
  $('modelKey').value = '';
  const config = JSON.parse(localStorage.getItem('easyinput-provider-settings') || '{}'); config.apiKey = '';
  delete config.apiKey;
  localStorage.setItem('easyinput-provider-settings', JSON.stringify(config));
  $('plannerStatus').textContent = 'API Key 已清除；内置课程仍可练习。';
});
$('refreshModels').addEventListener('click', async () => {
  const button = $('refreshModels');
  button.disabled = true; button.textContent = '正在获取…';
  $('modelCatalogStatus').textContent = '正在向所选厂商的官方模型目录查询。';
  try {
    const result = await api('/api/providers/models', { provider: $('modelProvider').value, apiKey: $('modelKey').value });
    const modelSelect = $('modelName');
    const previouslySelected = modelSelect.value;
    modelSelect.replaceChildren(new Option('请选择模型', ''));
    result.models.forEach(model => modelSelect.add(new Option(model, model)));
    modelSelect.value = result.models.includes(previouslySelected) ? previouslySelected : (result.models[0] || '');
    const saved = JSON.parse(localStorage.getItem('easyinput-provider-settings') || '{}');
    saved.provider = $('modelProvider').value; saved.endpoint = $('modelEndpoint').value.trim(); saved.model = modelSelect.value; delete saved.apiKey;
    localStorage.setItem('easyinput-provider-settings', JSON.stringify(saved));
    const updated = new Date(result.retrievedAt).toLocaleString();
    $('modelCatalogStatus').textContent = result.models.length ? `已从官方目录获取 ${result.models.length} 个模型（${updated}）。` : '官方目录当前没有可用模型。';
  } catch (error) {
    $('modelCatalogStatus').textContent = `获取失败：${error.message}`;
  } finally {
    button.textContent = '获取官方最新模型';
    button.disabled = ['builtin', 'custom'].includes($('modelProvider').value);
  }
});
$('modelName').addEventListener('change', () => {
  const config = JSON.parse(localStorage.getItem('easyinput-provider-settings') || '{}');
  config.provider = $('modelProvider').value; config.endpoint = $('modelEndpoint').value.trim(); config.model = $('modelName').value; delete config.apiKey;
  localStorage.setItem('easyinput-provider-settings', JSON.stringify(config));
  updatePlannerStatus();
});
function currentSpeechSettings() {
  const cloud = ['openai-speech', 'qwen-speech'].includes($('ttsProvider').value);
  return {
    provider: $('ttsProvider').value,
    endpoint: cloud ? $('cloudSpeechEndpoint').value.trim() : $('ttsEndpoint').value.trim(),
    token: cloud ? $('cloudSpeechKey').value : $('ttsToken').value,
    modelId: cloud ? $('cloudSpeechModel').value.trim() : $('ttsModel').value,
    voiceId: cloud ? $('cloudSpeechVoice').value.trim() : $('ttsVoice').value,
  };
}
function currentAnalysisSettings() {
  return {
    provider: $('asrProvider').value,
    endpoint: $('asrEndpoint').value.trim(),
    token: $('asrKey').value,
    modelId: $('asrModel').value.trim() || 'whisper-1',
    language: 'en',
  };
}
function updateAnalysisStatus() {
  const provider = $('asrProvider').value;
  $('asrFields').hidden = provider !== 'openai-transcription';
  if (provider === 'browser') {
    $('asrStatus').textContent = '已就绪：优先使用浏览器语音识别；开发板录音也能保存，但设备需支持浏览器识别时才会有词语反馈。';
    return;
  }
  const missing = [];
  if (!$('asrEndpoint').value.trim()) missing.push('API 地址');
  if (!$('asrKey').value.trim()) missing.push('API Key');
  if (!$('asrModel').value.trim()) missing.push('转写模型');
  $('asrStatus').textContent = missing.length
    ? `云端转写尚未完成：还缺${missing.join('、')}。录音仍会保存到材料库。`
    : '云端转写配置已填写；录音分析时只发送当前这一句。';
}
try {
  const saved = JSON.parse(localStorage.getItem('easyinput-asr-settings') || '{}');
  $('asrProvider').value = saved.provider || 'browser';
  $('asrEndpoint').value = saved.endpoint || '';
  $('asrModel').value = saved.modelId || 'whisper-1';
} catch {}
updateAnalysisStatus();
$('asrProvider').addEventListener('change', updateAnalysisStatus);
$('asrEndpoint').addEventListener('input', updateAnalysisStatus);
$('asrKey').addEventListener('input', updateAnalysisStatus);
$('asrModel').addEventListener('input', updateAnalysisStatus);
$('asrSave').addEventListener('click', () => {
  const settings = currentAnalysisSettings();
  localStorage.setItem('easyinput-asr-settings', JSON.stringify({ provider: settings.provider, endpoint: settings.endpoint, modelId: settings.modelId }));
  updateAnalysisStatus();
  $('asrStatus').textContent += ' API Key 只留在当前页面，不写入浏览器存储。';
});
function updateSpeechStatus() {
  const provider = $('ttsProvider').value;
  if (provider === 'windows') {
    $('ttsStatus').textContent = '已就绪：Windows 本机语音。无需云端 Key，生成的课程音频仍会自动保存到本机材料库。';
    return;
  }
  if (provider === 'yovoice') {
    $('ttsStatus').textContent = '本地 IndexTTS 2.5 仍需 Yovoice 本地 API 运行；当前先使用云端语音完成课程闭环。';
    return;
  }
  const missing = [];
  if (!$('cloudSpeechEndpoint').value.trim()) missing.push('API 地址');
  if (!$('cloudSpeechKey').value.trim()) missing.push('API Key');
  if (!$('cloudSpeechModel').value.trim()) missing.push('语音模型');
  if (!$('cloudSpeechVoice').value.trim()) missing.push('声音');
  $('ttsStatus').textContent = missing.length
    ? `云端语音尚未完成：还缺${missing.join('、')}。填好后先点“测试云端语音”。`
    : '云端语音配置已填写，先点“测试云端语音”确认服务可用，再保存语音选择。';
}
function syncSpeechFields() {
  const provider = $('ttsProvider').value;
  $('yovoiceFields').hidden = provider !== 'yovoice';
  $('cloudSpeechFields').hidden = !['openai-speech', 'qwen-speech'].includes(provider);
  if (provider === 'qwen-speech') {
    if (!$('cloudSpeechEndpoint').value || $('cloudSpeechEndpoint').value === 'https://api.openai.com/v1') $('cloudSpeechEndpoint').value = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
    if (!$('cloudSpeechModel').value || $('cloudSpeechModel').value === 'gpt-4o-mini-tts') $('cloudSpeechModel').value = 'qwen-audio-3.0-tts-flash';
    if (!$('cloudSpeechVoice').value || $('cloudSpeechVoice').value === 'alloy') $('cloudSpeechVoice').value = 'longanhuan_v3.6';
    $('cloudSpeechHint').textContent = '仅适用于百炼 Qwen-Audio-TTS。按你账户所在地域填写官方完整接口地址；音频会下载保存到本机。';
  } else if (provider === 'openai-speech') {
    if (!$('cloudSpeechEndpoint').value || $('cloudSpeechEndpoint').value.includes('dashscope.aliyuncs.com')) $('cloudSpeechEndpoint').value = 'https://api.openai.com/v1';
    if (!$('cloudSpeechModel').value || $('cloudSpeechModel').value.startsWith('qwen-audio')) $('cloudSpeechModel').value = 'gpt-4o-mini-tts';
    if (!$('cloudSpeechVoice').value || $('cloudSpeechVoice').value.startsWith('longan')) $('cloudSpeechVoice').value = 'alloy';
    $('cloudSpeechHint').textContent = '使用 OpenAI 标准 /audio/speech 接口；兼容服务可改地址、模型和声音。先测试一句，确认成功后再生成课程。';
  }
  updateSpeechStatus();
}
try {
  const saved = JSON.parse(localStorage.getItem('easyinput-speech-settings') || '{}');
  $('ttsProvider').value = saved.provider || 'windows';
  $('ttsEndpoint').value = saved.endpoint || 'http://127.0.0.1:8080';
  $('cloudSpeechEndpoint').value = saved.cloudEndpoint || '';
  $('cloudSpeechModel').value = saved.cloudModel || '';
  $('cloudSpeechVoice').value = saved.cloudVoice || '';
  if (saved.modelId) $('ttsModel').add(new Option(saved.modelId, saved.modelId, true, true));
  if (saved.voiceId) $('ttsVoice').add(new Option(saved.voiceName || saved.voiceId, saved.voiceId, true, true));
} catch {}
syncSpeechFields();
$('ttsProvider').addEventListener('change', syncSpeechFields);
$('cloudSpeechKey').addEventListener('input', updateSpeechStatus);
$('cloudSpeechEndpoint').addEventListener('input', updateSpeechStatus);
$('cloudSpeechModel').addEventListener('input', updateSpeechStatus);
$('cloudSpeechVoice').addEventListener('input', updateSpeechStatus);
$('ttsTest').addEventListener('click', async () => {
  const button = $('ttsTest');
  const provider = $('ttsProvider').value;
  if (!['openai-speech', 'qwen-speech'].includes(provider)) {
    $('ttsStatus').textContent = provider === 'windows'
      ? '当前是 Windows 本机语音，不需要云端测试。'
      : '当前是本地 Yovoice；请先连接本地 API，云端测试只适用于云端服务。';
    return;
  }
  button.disabled = true;
  $('ttsStatus').textContent = '正在请求云端合成一句测试语音…';
  try {
    const response = await fetch('/api/speech/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speech: currentSpeechSettings() }),
      cache: 'no-store',
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).error || ''; } catch {}
      throw new Error(detail || `服务返回 ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error('云端没有返回音频');
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    $('ttsStatus').textContent = '云端语音测试成功，已播放测试句。';
  } catch (error) {
    $('ttsStatus').textContent = `云端语音测试失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
});
$('ttsDiscover').addEventListener('click', async () => {
  const button = $('ttsDiscover'); button.disabled = true;
  $('ttsStatus').textContent = '正在连接本机 Yovoice…';
  try {
    const previousModel = $('ttsModel').value, previousVoice = $('ttsVoice').value;
    const catalog = await api('/api/speech/catalog', currentSpeechSettings());
    const models = catalog.models.filter(item => item && (item.id || item.modelId));
    const voices = catalog.voices.filter(item => item && (item.id || item.voiceId));
    $('ttsModel').replaceChildren(new Option('请选择语音模型', ''));
    models.forEach(item => $('ttsModel').add(new Option(item.name || item.displayName || item.id || item.modelId, item.id || item.modelId)));
    $('ttsVoice').replaceChildren(new Option('请选择参考声音', ''));
    voices.forEach(item => $('ttsVoice').add(new Option(item.name || item.id || item.voiceId, item.id || item.voiceId)));
    $('ttsModel').value = models.some(item => (item.id || item.modelId) === previousModel) ? previousModel : (models.find(item => String(item.id || item.modelId).includes('index-2.5'))?.id || models[0]?.id || '');
    $('ttsVoice').value = voices.some(item => (item.id || item.voiceId) === previousVoice) ? previousVoice : (voices[0]?.id || '');
    $('ttsStatus').textContent = `已连接 Yovoice：${models.length} 个模型、${voices.length} 个声音。选好后保存语音选择。`;
  } catch (error) { $('ttsStatus').textContent = `连接失败：${error.message}`; }
  finally { button.disabled = false; }
});
$('ttsSave').addEventListener('click', () => {
  const settings = currentSpeechSettings();
  localStorage.setItem('easyinput-speech-settings', JSON.stringify({
    provider: settings.provider, endpoint: $('ttsEndpoint').value.trim(), modelId: $('ttsModel').value,
    voiceId: $('ttsVoice').value, voiceName: $('ttsVoice').selectedOptions[0]?.textContent || '',
    cloudEndpoint: $('cloudSpeechEndpoint').value.trim(), cloudModel: $('cloudSpeechModel').value.trim(), cloudVoice: $('cloudSpeechVoice').value.trim(),
  }));
  updateSpeechStatus();
  $('ttsStatus').textContent += ' API Key 只留在当前页面，不写入浏览器存储。';
});
async function refreshStorageUsage() {
  try {
    const response = await fetch('/api/library/usage', { cache: 'no-store' });
    const usage = await response.json();
    if (!response.ok) throw new Error(usage.error || '目录读取失败');
    $('storagePath').value = usage.directory;
    $('storageStatus').textContent = `当前本机目录：${usage.directory}，共 ${usage.count} 项、${formatBytes(usage.sizeBytes)}。要迁移，请把上方路径改成新的绝对路径，再点“迁移全部材料”。`;
  } catch (error) { $('storageStatus').textContent = `读取目录失败：${error.message}`; }
}
$('chooseStoragePath').addEventListener('click', refreshStorageUsage);
$('migrateStorage').addEventListener('click', async () => {
  const button = $('migrateStorage'); button.disabled = true;
  $('storageStatus').textContent = '正在逐项复制并校验全部文件…';
  try {
    const result = await api('/api/library/migrate', { destination: $('storagePath').value.trim() });
    $('storageStatus').textContent = `迁移完成：${result.moved} 项已保存到 ${result.directory}。${result.sourceCleanupPending ? '旧目录有未清理文件，请手动检查。' : ''}`;
    renderLibrary(); renderPracticeQueue();
  } catch (error) { $('storageStatus').textContent = `迁移失败：${error.message}`; }
  finally { button.disabled = false; }
});
refreshStorageUsage();
$('closeMaterials').addEventListener('click', () => {
  $('materialTools').hidden = true;
  $('mediaFile').value = '';
});
$('mediaFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  state.mediaFile = file;
  state.lessonId = `file:${file.name}:${file.size}:${file.lastModified}`;
  state.translations = [];
  state.sourceMode = 'audio';
  state.captions = []; state.line = 0; state.a = null; state.b = null; state.looping = false; state.slow = false;
  const kind = isVideoFile(file) ? 'video' : 'audio';
  switchMedia(kind, URL.createObjectURL(file));
  $('mediaName').textContent = file.name;
  $('subtitleFile').value = '';
  $('subtitleName').textContent = 'SRT 文件，用于逐句练习';
  loadMarks(); await loadSavedLines(); renderCurrent(); await loadCurrentTake();
  $('materialTools').hidden = true; $('openMaterials').setAttribute('aria-expanded', 'false');
  say('材料已打开。没有字幕时可以整段练习，也可在“手动截取一小段”中设置重复范围。');
});
$('subtitleFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  const parsed = parseSrt(await file.text());
  if (!parsed.length) return say('这个字幕文件没有可用的时间轴。', true);
  state.captions = parsed.filter(line => !Number.isFinite(state.media.duration) || line.start < state.media.duration);
  state.translations = [];
  state.line = 0; state.a = null; state.b = null; state.heard = false;
  $('subtitleName').textContent = `${file.name} · ${state.captions.length} 句`;
  renderCurrent(); await loadCurrentTake(); say(`字幕已切成 ${state.captions.length} 句。`);
});

function onLoadedMetadata() {
  if (state.media !== this) return;
  $('duration').textContent = format(this.duration);
  renderCurrent();
}
function onTimeUpdate() {
  if (state.media !== this) return;
  $('currentTime').textContent = format(this.currentTime);
  $('seek').value = this.duration ? String(Math.round(this.currentTime / this.duration * 1000)) : '0';
  const { start, end } = bounds();
  if (!state.comparing && this.currentTime >= end - .035 && end > start && !this.paused) {
    if (state.looping) this.currentTime = start;
    else {
      this.pause(); finishDemo();
    }
  }
}
for (const element of [audioMedia, videoMedia]) {
  element.addEventListener('loadedmetadata', onLoadedMetadata);
  element.addEventListener('timeupdate', onTimeUpdate);
  element.addEventListener('pause', () => { if (state.media === element && !state.recordSource) led('idle'); });
  element.addEventListener('ended', () => { if (state.media === element && state.phase === 'speaking' && !state.comparing) finishDemo(); });
}
$('seek').addEventListener('input', event => { if (state.media.duration) state.media.currentTime = Number(event.target.value) / 1000 * state.media.duration; });
document.querySelectorAll('input[name="demoMode"]').forEach(input => input.addEventListener('change', () => {
  if (!input.checked) return;
  state.demoMode = input.value;
  localStorage.setItem('repeater-demo-mode', state.demoMode);
  if (state.phase === 'ready' || state.phase === 'feedback') {
    $('coachInstruction').textContent = state.demoMode === 'speech'
      ? '按一下用系统语音朗读当前句；朗读结束后就轮到你。'
      : '按一下播放材料里的原音；播放结束后就轮到你。';
  }
  say(state.demoMode === 'speech' ? '已选择 AI 朗读（使用本机系统语音）。' : '已选择播放材料原音。');
}));
$('mediaPanel').addEventListener('wheel', event => {
  if (!state.mediaFile || Math.abs(event.deltaY) < 2) return;
  event.preventDefault(); action(event.deltaY < 0 ? 'previous' : 'next', 'keyboard');
}, { passive: false });

const keyActions = ['previous', 'next', 'setA', 'setB', 'practice', 'speed', 'compare', 'weak'];
function hardwareCode(event) {
  const dedicated = event.ctrlKey && event.altKey && event.shiftKey;
  if (dedicated) {
    const number = Number(event.code.replace(/^Digit/, ''));
    if (number >= 1 && number <= 8) return { index: number - 1, dedicated: true };
    if (event.code === 'Digit9') return { action: 'previous', dedicated: true };
    if (event.code === 'Digit0') return { action: 'next', dedicated: true };
    if (event.code === 'KeyQ') return { action: 'loop', dedicated: true };
  }
  const fallback = Number(event.code.replace(/^F/, ''));
  if (!dedicated && /^F[1-8]$/.test(event.code) && fallback) return { index: fallback - 1, dedicated: false };
  return null;
}
window.addEventListener('keydown', event => {
  const key = hardwareCode(event);
  if (key) {
    event.preventDefault();
    if (key.index === 4) {
       if (event.repeat) return;
       action('practice', 'keyboard');
      return;
    }
    if (event.repeat) return;
    action(key.action || keyActions[key.index], 'keyboard'); return;
  }
  if (event.code === 'Space' && !['INPUT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) {
    event.preventDefault(); action('play', 'keyboard');
  }
});
window.addEventListener('keyup', event => {
  const key = hardwareCode(event);
  if (key?.index === 4) event.preventDefault();
});
window.addEventListener('blur', () => {
  if (state.s5Timer) clearTimeout(state.s5Timer);
  state.s5Timer = null;
  if (state.s5Held && state.recordSource) stopRecord();
  state.s5Held = false;
});

async function refreshBoard() {
  try {
    const board = await fetch('/api/status', { cache: 'no-store' }).then(response => response.json());
    state.board = board;
    $('micStatus').textContent = board.micConnected ? '键盘麦克风已连接' : '键盘麦克风未连接';
    $('micStatus').classList.toggle('online', board.micConnected);
    $('micStatus').classList.toggle('offline', !board.micConnected);
    $('ledStatus').textContent = board.ledConnected ? '键盘灯已连接' : '键盘灯未连接';
    $('ledStatus').classList.toggle('online', board.ledConnected);
    $('ledStatus').classList.toggle('offline', !board.ledConnected);
    $('boardHint').textContent = board.micConnected || board.ledConnected
      ? `设备网络已连接：麦克风${board.micConnected ? '可用' : '未连接'}，灯${board.ledConnected ? '可用' : '未连接'}。网页桥端口：麦克风 ${board.micPort}，灯 ${board.ledPort}。`
      : `键盘麦克风暂未连接；网页桥正在监听麦克风 ${board.micPort}。点击“录下我的跟读”可使用电脑麦克风。`;
  } catch { $('boardHint').textContent = '本机录音服务暂不可用；内置音频练习不受影响。'; }
}
setInterval(refreshBoard, 2000); refreshBoard();

function updateBenchmark() {
  const current = state.benchmark.current;
  $('benchmarkStatus').textContent = current
    ? `${current.label}计时中 · ${((Date.now() - current.startedAt) / 1000).toFixed(1)} 秒 · 鼠标 ${current.pointer} 次 · 按键 ${current.keyboard} 次`
    : '尚未开始计时。';
  $('benchmarkResults').replaceChildren(...state.benchmark.results.map(result => {
    const row = document.createElement('div');
    row.textContent = `${result.label}：${result.seconds.toFixed(1)} 秒 · 鼠标 ${result.pointer} 次 · 按键 ${result.keyboard} 次`;
    return row;
  }));
}
function startBenchmark(label) {
  if (state.benchmark.current) return say('先结束当前计时。', true);
  state.benchmark.current = { label, startedAt: Date.now(), pointer: 0, keyboard: 0 };
  updateBenchmark(); say(`${label}开始计时。`);
}
$('softwareRun').addEventListener('click', () => startBenchmark('鼠标组'));
$('hardwareRun').addEventListener('click', () => startBenchmark('键盘组'));
$('endRun').addEventListener('click', () => {
  const current = state.benchmark.current;
  if (!current) return;
  state.benchmark.results.push({ label: current.label, seconds: (Date.now() - current.startedAt) / 1000, pointer: current.pointer, keyboard: current.keyboard });
  state.benchmark.current = null; updateBenchmark(); say('计时结果已保存，可导出。');
});
$('exportButton').addEventListener('click', () => {
  const data = { app: 'EasyInput 听说练习', exportedAt: new Date().toISOString(), lesson: state.lessonId,
    sentenceCount: state.captions.length, recordedLines: [...state.recordedLines], marks: state.marks,
    benchmark: state.benchmark.results, board: state.board,
    note: '导出 JSON 不包含音频录音；录音保留在本机浏览器数据库。' };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'easyinput-listening-practice.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function loadBuiltInLesson() {
  state.mediaFile = { name: 'AI 硬件开发入门英语', type: 'audio/wav' };
  state.lessonId = 'builtin:ai-hardware-english-v1';
  state.translations = translations;
  state.sourceMode = 'audio';
  state.courseAudioIds = []; state.phase = 'ready'; state.heard = false; state.compareDone = false;
  state.captions = [];
  switchMedia('audio', '/demo/five-sentences.wav');
  const response = await fetch('/demo/five-sentences.srt');
  if (!response.ok) throw new Error('内置练习暂时无法载入');
  state.captions = parseSrt(await response.text());
  state.line = 0; state.a = null; state.b = null;
  loadMarks(); await loadSavedLines(); renderCurrent(); await loadCurrentTake(); updateCoach();
  if (!state.captions.length) throw new Error('内置练习字幕格式无效');
}

setInterval(updateBenchmark, 250);
migrateLegacyTakes().then(loadBuiltInLesson).catch(error => say(`内置练习载入失败：${error.message}。刷新页面后重试。`, true));
renderPracticeQueue();
