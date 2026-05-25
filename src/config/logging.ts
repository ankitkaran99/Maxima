import { env, storagePath } from '@lib/index.js'

export default {
  default: env('LOG_CHANNEL', 'stack'),
  channels: {
    stack: { driver: 'stack', channels: ['console', 'file'] },
    console: { driver: 'console', level: env('LOG_LEVEL', 'debug'), pretty: env('APP_ENV') !== 'production' },
    file: { driver: 'file', path: storagePath('logs/maxima.log'), level: 'info', rotate: true, maxFiles: 30 },
    error: { driver: 'file', path: storagePath('logs/error.log'), level: 'error' },
    daily: { driver: 'daily', path: storagePath('logs/app.log'), days: 14 },
    webhook: { driver: 'webhook', url: env('LOG_WEBHOOK_URL') },
    null: { driver: 'null' }
  }
}
