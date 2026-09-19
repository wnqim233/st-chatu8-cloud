/* Persistent FIFO admission shared by both providers. Aladdin Free Public License. */
import { ACTIVE, MAX_ACTIVE_JOBS, queuedJobs } from './jobs.js';

export function createJobQueue(user) {
  let pending;
  async function drain(config) {
    while (true) {
      const jobs = await user.store.jobs();
      const first = queuedJobs(jobs)[0];
      if (!first || jobs.filter(j => ACTIVE.has(j.status)).length >= MAX_ACTIVE_JOBS) return;
      // Rechecks FIFO and capacity under the cross-tab submit lock.
      const result = await user[first.provider || 'wavespeed'].startQueued(first.id, config);
      if (!result) return;
    }
  }
  return {
    tick(config) {
      if (pending) return pending;
      pending = (async () => {
        await drain(config);
        const jobs = await user.store.jobs();
        // Refill on each completion, without waiting for the other slot to finish.
        const results = await Promise.allSettled(jobs.filter(j => ['submitting', 'submitted', 'processing', 'download_failed'].includes(j.status)).map(async job => {
          await user[job.provider || 'wavespeed'].refresh(job.id, config, () => drain(config));
          await drain(config);
        }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        await drain(config);
      })().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
