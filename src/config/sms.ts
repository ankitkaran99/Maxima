import { env } from '@lib/index.js'

export default {
  default: env('SMS_DRIVER', 'http'),
  from: env('SMS_FROM', 'Maxima'),
  channels: {
    console: { driver: 'console' },
    log: { driver: 'log' },
    http: {
      driver: 'http',
      url: env('SMS_URL'),
      headers: env('SMS_AUTH_TOKEN') ? { authorization: `Bearer ${env('SMS_AUTH_TOKEN')}` } : {}
    },
    null: { driver: 'null' }
  }
}
