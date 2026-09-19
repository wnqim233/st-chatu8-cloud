/* Added by Codex for the workspace owner, 2026-09-19. Aladdin Free Public License; see ../LICENSE. */
import path from 'node:path';
import { UserStore } from './store.mjs';
import { AppError, publicConfig, updateConfig, safeError } from './config.mjs';
import { WaveSpeedService, publicJob } from './wavespeed.mjs';
import { createJobQueue } from '../shared/queue.js';
import { CivitaiService } from './civitai.mjs';

export const info = { id: 'wavespeed-illustrator', name: 'st-chatu8 WaveSpeed / Civitai 后端', description: '为 st-chatu8 提供 WaveSpeed 与 Civitai 异步生图、本地图片保存' };

export function createHandlers({ fetcher = fetch, checkUrl, now } = {}) {
  const users = new Map();
  function session(req) {
    const dirs = req.user?.directories;
    if (!dirs?.root || !dirs?.userImages) throw new AppError('需要有效的酒馆用户会话。', 401);
    const key = path.resolve(dirs.root);
    if (!users.has(key)) {
      const store = new UserStore(dirs);
      const options = { fetcher, ...(checkUrl ? { checkUrl } : {}), ...(now ? { now } : {}) };
      const user = { store, wavespeed: new WaveSpeedService(store, options), civitai: new CivitaiService(store, options) };
      user.queue = createJobQueue(user); users.set(key, user);
    }
    return users.get(key);
  }
  function provider(user, name = 'wavespeed') {
    if (!['wavespeed', 'civitai'].includes(name)) throw new AppError('未知的生图后端。');
    return user[name];
  }
  async function jobProvider(user, id) {
    const job = await user.store.job(id);
    if (!job) throw new AppError('任务不存在。', 404);
    return provider(user, job.provider);
  }
  const route = fn => async (req, res) => {
    let config;
    try {
      const user = session(req);
      config = await user.store.config();
      const result = await fn(req, user, config);
      res.json(result);
    } catch (error) {
      res.status(error.status || 500).json({ error: safeError(error, config) });
    }
  };
  return {
    health: route(async () => ({ ok: true, version: '0.1.0' })),
    configGet: route(async (_req, _user, config) => publicConfig(config)),
    configSave: route(async (req, { store }) => store.exclusive('config', async () => {
      const config = updateConfig(await store.config(), req.body);
      await store.saveConfig(config);
      return publicConfig(config);
    })),
    models: route(async (_req, { wavespeed }, config) => wavespeed.listModels(config)),
    jobs: route(async (_req, { store }) => (await store.jobs()).map(publicJob).reverse()),
    estimate: route(async (req, { civitai }, config) => civitai.estimate(req.body, config)),
    submit: route(async (req, user, config) => publicJob(await provider(user, req.body?.provider).submit(req.body, config))),
    tick: route(async (_req, user, config) => { await user.queue.tick(config); return (await user.store.jobs()).map(publicJob).reverse(); }),
    refresh: route(async (req, user, config) => { await user.queue.tick(config); return publicJob(await (await jobProvider(user, req.params.id)).refresh(req.params.id, config)); }),
    cancel: route(async (req, user) => publicJob(await (await jobProvider(user, req.params.id)).cancel(req.params.id))),
    recover: route(async (req, { wavespeed }) => publicJob(await wavespeed.recover(req.params.id, req.body?.taskId))),
    dismiss: route(async (req, { wavespeed }) => publicJob(await wavespeed.dismiss(req.params.id))),
  };
}

export async function init(router) {
  const handlers = createHandlers();
  router.get('/health', handlers.health);
  router.get('/config', handlers.configGet);
  router.post('/config', handlers.configSave);
  router.get('/models', handlers.models);
  router.post('/civitai/estimate', handlers.estimate);
  router.get('/jobs', handlers.jobs);
  router.post('/jobs', handlers.submit);
  router.post('/jobs/tick', handlers.tick);
  router.post('/jobs/:id/cancel', handlers.cancel);
  router.post('/jobs/:id/refresh', handlers.refresh);
  router.post('/jobs/:id/recover', handlers.recover);
  router.post('/jobs/:id/dismiss', handlers.dismiss);
}
