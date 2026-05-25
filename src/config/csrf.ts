import { env } from '@lib/index.js'

export default {
  enabled: true,
  except: ['/webhooks/*'],
  cookie: {
    name: 'XSRF-TOKEN',
    sameSite: 'lax',
    secure: env('APP_ENV') === 'production'
  }
}
