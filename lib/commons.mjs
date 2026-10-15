import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const allowedLicense = /^(?:public domain|cc0|cc by(?:-sa)?(?: \d(?:\.\d)?)?)$/i;
const clean = value => String(value || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();

export async function searchCommonsMedia(query, { fetchImpl = fetch, limit = 5 } = {}) {
  const term = String(query || '').trim().slice(0, 120);
  if (!term) return [];
  const types = ['audio', 'video', 'image'];
  const searches = await Promise.allSettled(types.map(async type => {
    const url = new URL('https://commons.wikimedia.org/w/api.php');
    Object.entries({ action: 'query', generator: 'search', gsrsearch: `${term} filetype:${type}`, gsrnamespace: '6', gsrlimit: String(Math.min(20, Math.max(1, limit))), prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', format: 'json' })
      .forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetchImpl(url, { headers: { 'User-Agent': 'EasyInputRepeater/0.1 (local language learning)', Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`Wikimedia Commons ${type} 搜索失败（HTTP ${response.status}）`);
    const payload = await response.json();
    return Object.values(payload.query?.pages || {}).map(page => {
      const info = page.imageinfo?.[0] || {};
      const meta = info.extmetadata || {};
      const license = clean(meta.LicenseShortName?.value);
      const sizeBytes = Number(info.size) || 0;
      const mediaUrl = String(info.url || '');
      const mimeType = String(info.mime || '');
      const title = String(page.title || '').replace(/^File:/, '').slice(0, 240);
      return {
        title, type, provider: 'Wikimedia Commons', creator: clean(meta.Artist?.value).slice(0, 140),
        license, licenseUrl: String(meta.LicenseUrl?.value || ''),
        sourceUrl: String(info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || '')}`),
        mediaUrl, mimeType, sizeBytes,
        excerpt: `${title} · ${type} · ${license}`,
        canImport: allowedLicense.test(license) && sizeBytes > 0 && sizeBytes <= 30 * 1024 * 1024 && mediaUrl.startsWith('https://upload.wikimedia.org/'),
      };
    }).filter(item => item.mediaUrl);
  }));
  const failure = searches.find(result => result.status === 'rejected');
  if (searches.every(result => result.status === 'rejected')) throw failure.reason;
  return searches.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

export async function downloadCommonsMedia(mediaUrl, { fetchImpl = fetch, maxBytes = 30 * 1024 * 1024 } = {}) {
  const url = new URL(mediaUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'upload.wikimedia.org') throw new Error('媒体地址不属于 Wikimedia Commons 文件服务');
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`媒体下载失败（HTTP ${response.status}）`);
  const declared = Number(response.headers.get('content-length')) || 0;
  if (declared > maxBytes) throw new Error('文件超过 30 MB 导入上限');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('文件超过 30 MB 导入上限');
    chunks.push(chunk);
  }
  if (!size) throw new Error('媒体文件为空');
  return Buffer.concat(chunks);
}

export async function extractVideoAudio(bytes) {
  const temporary = await mkdtemp(join(tmpdir(), 'easyinput-video-'));
  const input = join(temporary, 'source.video');
  const output = join(temporary, 'audio.wav');
  try {
    await writeFile(input, bytes);
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ['-nostdin', '-loglevel', 'error', '-y', '-i', input, '-vn', '-t', '300', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], { windowsHide: true, timeout: 90000 });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString().slice(0, 400); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`视频音轨提取失败：${stderr.trim() || `退出码 ${code}`}`)));
    });
    return await readFile(output);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
