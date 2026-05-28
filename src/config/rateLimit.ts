import { env } from '@lib/index.js'

export default {
  global: { enabled: env('RATE_LIMIT_ENABLED', true), max: env('RATE_LIMIT_MAX', 60), timeWindow: env('RATE_LIMIT_WINDOW', '1 minute') },
  limiters: {
    api: { max: 60, timeWindow: '1 minute' },
    login: { max: 5, timeWindow: '1 minute' }
  }
}
