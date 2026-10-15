import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';

const indexName = 'library.json';
const allowedBuckets = new Set(['recordings', 'materials', 'generated-audio']);
const cleanPart = value => String(value || 'untitled').normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'untitled';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export class MaterialLibrary {
  constructor(directory) {
    this.directory = resolve(directory);
    this.migration = null;
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    try { await this.readIndex(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.writeIndex({ version: 1, items: [] });
    }
    return this;
  }

  indexPath(directory = this.directory) { return join(directory, indexName); }
  async readIndex(directory = this.directory) { return JSON.parse(await readFile(this.indexPath(directory), 'utf8')); }
  async writeIndex(value, directory = this.directory) {
    const target = this.indexPath(directory);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await rename(temporary, target);
  }

  async list(filters = {}) {
    const index = await this.readIndex();
    return index.items.filter(item => (!filters.type || item.type === filters.type) && (!filters.lessonId || item.lessonId === filters.lessonId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addFile({ bucket, group = 'general', name, mimeType, bytes, metadata = {} }) {
    if (!allowedBuckets.has(bucket)) throw new Error('不支持的材料类型');
    const id = randomUUID();
    const originalExt = extname(basename(name || 'audio.wav')).toLowerCase().replace(/[^.a-z0-9]/g, '');
    const extension = originalExt && originalExt.length <= 12 ? originalExt : (mimeType === 'audio/wav' ? '.wav' : '.bin');
    const relativePath = [bucket, cleanPart(group), `${id}${extension}`].join('/');
    const fullPath = join(this.directory, ...relativePath.split('/'));
    await mkdir(join(fullPath, '..'), { recursive: true });
    const data = Buffer.from(bytes);
    await writeFile(fullPath, data, { flag: 'wx' });
    const index = await this.readIndex();
    const item = { id, name: String(name || `练习录音${extension}`), type: bucket === 'recordings' ? '跟读录音' : bucket === 'generated-audio' ? 'AI 语音' : '练习材料', bucket, group, relativePath, mimeType: mimeType || 'application/octet-stream', sizeBytes: data.length, sha256: digest(data), createdAt: new Date().toISOString(), ...metadata };
    index.items.push(item);
    try { await this.writeIndex(index); }
    catch (error) { await rm(fullPath, { force: true }); throw error; }
    return item;
  }

  async getFile(id) {
    const item = (await this.readIndex()).items.find(value => value.id === id);
    if (!item) return null;
    const bytes = await readFile(join(this.directory, ...item.relativePath.split('/')));
    return { item, bytes };
  }

  async updateFile(id, bytes, metadata = {}) {
    const index = await this.readIndex();
    const item = index.items.find(value => value.id === id);
    if (!item) throw new Error('材料不存在');
    const path = join(this.directory, ...item.relativePath.split('/'));
    const data = Buffer.from(bytes);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, data);
    try {
      await rename(temporary, path);
      Object.assign(item, metadata, { sizeBytes: data.length, sha256: digest(data) });
      await this.writeIndex(index);
    } finally { await rm(temporary, { force: true }); }
    return item;
  }

  async delete(id) {
    const index = await this.readIndex();
    const at = index.items.findIndex(value => value.id === id);
    if (at < 0) return false;
    const [item] = index.items.splice(at, 1);
    const file = join(this.directory, ...item.relativePath.split('/'));
    await rm(file, { force: true });
    await this.writeIndex(index);
    return true;
  }

  async migrate(destination) {
    if (this.migration) throw new Error('已有目录迁移正在进行');
    const next = resolve(destination);
    if (next === this.directory || next.startsWith(`${this.directory}${sep}`) || this.directory.startsWith(`${next}${sep}`)) throw new Error('新目录不能与当前材料目录相同、位于其中或包含当前目录');
    this.migration = (async () => {
      const old = this.directory;
      const index = await this.readIndex();
      await mkdir(next, { recursive: true });
      const probe = join(next, `.easyinput-write-test-${randomUUID()}`);
      await writeFile(probe, 'ok', { flag: 'wx' }); await rm(probe);
      const sourceFiles = [];
      for (const item of index.items) {
        const from = join(old, ...item.relativePath.split('/'));
        const to = join(next, ...item.relativePath.split('/'));
        const bytes = await readFile(from);
        if (digest(bytes) !== item.sha256) throw new Error(`源文件校验失败：${item.name}`);
        await mkdir(join(to, '..'), { recursive: true });
        await copyFile(from, to);
        const copied = await readFile(to);
        if (digest(copied) !== item.sha256) throw new Error(`迁移后校验失败：${item.name}`);
        sourceFiles.push(from);
      }
      await this.writeIndex(index, next);
      this.directory = next;
      let sourceCleanupPending = false;
      for (const file of [...sourceFiles, this.indexPath(old)]) {
        try { await rm(file, { force: true }); } catch { sourceCleanupPending = true; }
      }
      return { directory: next, moved: index.items.length, sourceCleanupPending };
    })();
    try { return await this.migration; }
    finally { this.migration = null; }
  }

  async usage() {
    const items = await this.list();
    return { directory: this.directory, count: items.length, sizeBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0) };
  }
}
