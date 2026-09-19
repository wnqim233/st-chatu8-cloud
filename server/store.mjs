/* Added by Codex for the workspace owner, 2026-09-19. Aladdin Free Public License; see ../LICENSE. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, AppError } from './config.mjs';

export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw new AppError('插件数据文件无法读取，请检查服务端文件，原文件未被覆盖。', 500);
  }
}

export class UserStore {
  constructor(directories) {
    this.root = path.join(directories.root, '.wavespeed-illustrator');
    this.imageDir = path.join(directories.userImages, 'wavespeed-illustrator');
    this.locks = new Map();
  }
  async config() { return { ...structuredClone(DEFAULT_CONFIG), ...await readJson(path.join(this.root, 'config.json'), {}) }; }
  async saveConfig(config) { await atomicJson(path.join(this.root, 'config.json'), config); }
  async jobs() { return readJson(path.join(this.root, 'jobs.json'), []); }
  async job(id) { return (await this.jobs()).find(j => j.id === id); }
  async saveJob(job) {
    return this.exclusive('journal', async () => {
      const jobs = await this.jobs();
      const index = jobs.findIndex(j => j.id === job.id);
      if (index >= 0) jobs[index] = job; else jobs.push(job);
      // Retain every unfinished job; cap only terminal history.
      const terminal = new Set(jobs.filter(j => ['completed', 'failed'].includes(j.status)).slice(-200).map(j => j.id));
      await atomicJson(path.join(this.root, 'jobs.json'), jobs.filter(j => !['completed', 'failed'].includes(j.status) || terminal.has(j.id)));
      return job;
    });
  }
  async exclusive(key, operation) {
    const before = this.locks.get(key) || Promise.resolve();
    const next = before.catch(() => {}).then(operation);
    this.locks.set(key, next);
    try { return await next; }
    finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
}
