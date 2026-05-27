import { env, storagePath } from '@lib/index.js'

export default {
  default: env('LOG_CHANNEL', 'stack'),
  deprecations: { channel: env('LOG_DEPRECATIONS_CHANNEL', 'deprecations') },
  channels: {
    stack: { driver: 'stack', channels: ['console', 'file'] },
    console: { driver: 'console', level: env('LOG_LEVEL', 'debug'), pretty: env('APP_ENV') !== 'production' },
    single: { driver: 'single', path: storagePath('logs/maxima.log'), level: 'debug' },
    file: { driver: 'file', path: storagePath('logs/maxima.log'), level: 'info', rotate: true, maxFiles: 30 },
    error: { driver: 'file', path: storagePath('logs/error.log'), level: 'error' },
    daily: { driver: 'daily', path: storagePath('logs/app.log'), days: 14 },
    deprecations: { driver: 'file', path: storagePath('logs/deprecations.log'), level: 'warning' },
    slack: { driver: 'slack', url: env('LOG_SLACK_WEBHOOK_URL'), level: 'critical' },
    syslog: { driver: 'syslog', facility: env('LOG_SYSLOG_FACILITY', 'user'), level: env('LOG_LEVEL', 'debug') },
    errorlog: { driver: 'errorlog', level: env('LOG_LEVEL', 'debug') },
    papertrail: { driver: 'papertrail', host: env('PAPERTRAIL_URL'), port: env('PAPERTRAIL_PORT'), level: env('LOG_LEVEL', 'debug') },
    webhook: { driver: 'webhook', url: env('LOG_WEBHOOK_URL') },
    null: { driver: 'null' }
  }
}
