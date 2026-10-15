function timeSeconds(value) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
  if (!match) return null;
  const [, h, m, s, ms] = match.map(Number);
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s + ms / 1000;
}

export function parseSrt(text) {
  if (typeof text !== 'string') return [];
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
  const lines = [];
  for (const block of blocks) {
    const parts = block.split('\n').map(x => x.trim()).filter(Boolean);
    const timeIndex = parts.findIndex(x => x.includes('-->'));
    if (timeIndex < 0) continue;
    const timestamps = parts[timeIndex].split(/\s*-->\s*/);
    if (timestamps.length !== 2) continue;
    const start = timeSeconds(timestamps[0]);
    const end = timeSeconds(timestamps[1].split(/\s+/)[0]);
    const caption = parts.slice(timeIndex + 1).join(' ').replace(/<[^>]*>/g, '').trim();
    if (start === null || end === null || end <= start || !caption) continue;
    lines.push({ start, end, text: caption });
  }
  return lines.sort((a, b) => a.start - b.start || a.end - b.end);
}
