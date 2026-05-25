import { env } from '@lib/index.js'
import PostPolicy from '@app/Policies/PostPolicy.js'

export default {
  defaults: {
    guard: 'session',
    provider: 'users'
  },
  guards: {
    session: { driver: 'session', provider: 'users' },
    token: { driver: 'token', provider: 'users' }
  },
  providers: {
    users: {
      driver: class {
        async retrieveById(id) {
          const { User } = await import('@app/Models/User.js')
          return User.find(id)
        }
        async retrieveByCredentials(credentials) {
          const { User } = await import('@app/Models/User.js')
          return User.where('email', credentials.email).first()
        }
      }
    }
  },
  remember: {
    cookie: 'maxima_remember_session',
    table: 'remember_tokens',
    lifetimeDays: 30
  },
  passwords: {
    table: 'password_reset_tokens',
    expires: 60
  },
  verification: {
    table: 'email_verifications',
    expires: 60
  },
  passwordTimeout: 10800,
  jwt: {
    enabled: false,
    secret: env('AUTH_JWT_SECRET', env('APP_KEY', 'maxima-secret')),
    issuer: env('AUTH_JWT_ISSUER', 'maxima'),
    audience: env('AUTH_JWT_AUDIENCE', 'maxima-api'),
    ttl: 3600
  },
  policies: {
    Post: PostPolicy
  }
}
