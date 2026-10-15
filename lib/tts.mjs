import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'generate-tts.ps1');

export async function generateLessonSpeech(sentences) {
  if (process.platform !== 'win32') throw new Error('当前系统没有配置本机英语语音合成');
  const lines = sentences.map(line => String(line.text || '').trim());
  if (!lines.length || lines.length > 30 || lines.some(line => !line || line.length > 500)) throw new Error('课程句子不符合语音生成要求');
  const temporary = await mkdtemp(join(tmpdir(), 'easyinput-tts-'));
  try {
    const input = join(temporary, 'sentences.json');
    await writeFile(input, JSON.stringify(lines), 'utf8');
    await new Promise((resolve, reject) => {
      const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script, input, temporary], { windowsHide: true, timeout: 120000 });
      let errorText = '';
      child.stderr.on('data', chunk => { errorText += chunk.toString().slice(0, 1000); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`本机语音生成失败：${errorText.trim() || `退出码 ${code}`}`)));
    });
    return Promise.all(lines.map((_, index) => readFile(join(temporary, `${index}.wav`))));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
