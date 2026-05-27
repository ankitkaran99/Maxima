import { env } from '@lib/index.js'

export default {
  default: env('BROADCAST_CONNECTION', 'local'),
  middleware: ['web', 'auth'],
  connections: {
    local: {
      driver: 'local'
    },
    pusher: {
      driver: 'pusher',
      key: env('PUSHER_APP_KEY', 'maxima'),
      secret: env('PUSHER_APP_SECRET', env('APP_KEY', 'maxima-secret')),
      app_id: env('PUSHER_APP_ID', 'local'),
      options: {
        host: env('PUSHER_HOST', '127.0.0.1'),
        port: env('PUSHER_PORT', 6001),
        scheme: env('PUSHER_SCHEME', 'http')
      }
    },
    reverb: {
      driver: 'reverb',
      key: env('REVERB_APP_KEY', env('PUSHER_APP_KEY', 'maxima')),
      secret: env('REVERB_APP_SECRET', env('PUSHER_APP_SECRET', env('APP_KEY', 'maxima-secret'))),
      app_id: env('REVERB_APP_ID', env('PUSHER_APP_ID', 'local')),
      options: {
        host: env('REVERB_HOST', '127.0.0.1'),
        port: env('REVERB_PORT', 8080),
        scheme: env('REVERB_SCHEME', 'http')
      }
    },
    log: {
      driver: 'log'
    },
    null: {
      driver: 'null'
    }
  }
}
