import { env } from '@lib/index.js'

export default {
  default: env('MAIL_MAILER', 'smtp'),
  mailers: {
    smtp: {
      transport: 'smtp',
      host: env('MAIL_HOST'),
      port: env('MAIL_PORT', 587),
      secure: env('MAIL_SECURE', false),
      auth: { user: env('MAIL_USERNAME'), pass: env('MAIL_PASSWORD') }
    },
    sendmail: { transport: 'sendmail', path: env('MAIL_SENDMAIL_PATH', '/usr/sbin/sendmail') },
    log: { transport: 'log' },
    array: { transport: 'array' }
  },
  from: {
    address: env('MAIL_FROM_ADDRESS', 'hello@example.com'),
    name: env('MAIL_FROM_NAME', env('APP_NAME', 'Maxima'))
  }
}
