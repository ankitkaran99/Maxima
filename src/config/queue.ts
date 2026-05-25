import { env } from '@lib/index.js'

export default {
  default: env('QUEUE_CONNECTION', 'default'),
  connections: {
    redis: { redis: { url: env('REDIS_URL', 'redis://127.0.0.1:6379') } }
  },
  failed: { table: 'failed_jobs' }
}
