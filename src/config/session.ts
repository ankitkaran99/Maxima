import { env } from '@lib/index.js'

export default {
  driver: env('SESSION_DRIVER', 'cookie'),
  lifetime: env('SESSION_LIFETIME', 120),
  cookie: {
    name: env('SESSION_COOKIE', 'maxima_session'),
    httpOnly: true,
    secure: env('SESSION_SECURE_COOKIE', false),
    signed: true,
    encrypted: true,
    sameSite: 'lax',
    path: '/'
  },
  stores: {
    memory: {},
    redis: { connection: env('REDIS_URL') },
    database: { table: 'sessions' }
  }
}
