// open-next generates this module during the Cloudflare build step.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- generated artifact may be absent during clean Next type-checks
import { default as handler } from './.open-next/worker.js'
import { consumeBackgroundJobBatch, type BackgroundJob, type BackgroundJobEnv } from './lib/background-jobs'
import { runScheduledPublishScan } from './lib/scheduled-publish/scheduled'

interface ScheduledEventController {
  cron?: string
  scheduledTime?: Date
}

interface ScheduledEventContext {
  waitUntil(promise: Promise<unknown>): void
}

interface QueueMessage<T> {
  body: T
  ack?: () => void
  retry?: () => void
}

interface QueueBatch<T> {
  messages: Array<QueueMessage<T>>
}

const customWorker = {
  fetch: handler.fetch,

  async queue(batch: QueueBatch<BackgroundJob>, env: BackgroundJobEnv) {
    await consumeBackgroundJobBatch(batch, env)
  },

  /**
   * B4-01 (issue #40): per-minute compensation scan, woken by the
   * `[triggers] crons` entry in the Wrangler config (#262). It runs the SAME
   * `runScheduledPublishScan` command covered by the scheduled scan tests
   * (DB-absent skip + D1 fire). Cron only wakes the D1 scan — every fact is
   * decided by the scan kernel.
   */
  scheduled(_controller: ScheduledEventController, env: CloudflareEnv, ctx: ScheduledEventContext) {
    ctx.waitUntil(runScheduledPublishScan(env))
  },
}

export default customWorker

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- generated artifact may be absent during clean Next type-checks
export { DOQueueHandler, DOShardedTagCache } from './.open-next/worker.js'
