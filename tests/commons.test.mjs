import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { downloadCommonsMedia, extractVideoAudio, searchCommonsMedia } from '../lib/commons.mjs';

test('Commons search preserves media type, attribution and import limits', async () => {
  const fetchImpl = async url => {
    const type = new URL(url).searchParams.get('gsrsearch').split('filetype:')[1];
    return Response.json({ query: { pages: { 1: { title: `File:Psychology.${type === 'image' ? 'png' : type === 'video' ? 'webm' : 'ogg'}`, imageinfo: [{
      url: `https://upload.wikimedia.org/test/psychology.${type}`, mime: type === 'audio' ? 'application/ogg' : `${type}/${type === 'image' ? 'png' : 'webm'}`,
      size: type === 'video' ? 31 * 1024 * 1024 : 1024,
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Psychology',
      extmetadata: { LicenseShortName: { value: 'CC BY 4.0' }, Artist: { value: '<b>Teacher</b>' } },
    }] } } } });
  };
  const found = await searchCommonsMedia('psychology', { fetchImpl });
  assert.deepEqual(found.map(item => item.type).sort(), ['audio', 'image', 'video']);
  assert.equal(found.find(item => item.type === 'video').canImport, false);
  assert.equal(found.find(item => item.type === 'audio').canImport, true);
  assert.equal(found[0].creator, 'Teacher');
  await assert.rejects(downloadCommonsMedia('https://127.0.0.1/private.webm'), /不属于 Wikimedia Commons/);
});

test('a licensed video audio track can be extracted as a playable WAV', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easyinput-ffmpeg-test-'));
  const video = join(directory, 'sample.webm');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=1', '-shortest', '-c:v', 'libvpx', '-c:a', 'libopus', video], { windowsHide: true });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`fixture ffmpeg exit ${code}`)));
    });
    const bytes = await readFile(video);
    const downloaded = await downloadCommonsMedia('https://upload.wikimedia.org/sample.webm', { fetchImpl: async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }) });
    const audio = await extractVideoAudio(downloaded);
    assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
    assert.ok(audio.length > 1000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
