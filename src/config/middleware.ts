import { AuthMiddleware, CanMiddleware, GuestMiddleware, PasswordConfirmedMiddleware, VerifiedMiddleware } from '@lib/auth/Middleware.js'
import { RequestLoggerMiddleware } from '@lib/logging/RequestLoggerMiddleware.js'
import { CookieMiddleware, CsrfMiddleware, SessionMiddleware, ThrottleMiddleware, SignedMiddleware } from '@lib/http/SecurityMiddleware.js'
import { ShareErrorsFromSessionMiddleware } from '@lib/validation/ValidationMiddleware.js'

export default {
  global: ['logger'],
  groups: {
    web: ['cookies', 'session', 'csrf', 'shareErrorsFromSession'],
    api: ['throttle:api']
  },
  aliases: {
    logger: RequestLoggerMiddleware,
    cookies: CookieMiddleware,
    session: SessionMiddleware,
    csrf: CsrfMiddleware,
    throttle: ThrottleMiddleware,
    signed: SignedMiddleware,
    auth: AuthMiddleware,
    guest: GuestMiddleware,
    can: CanMiddleware,
    verified: VerifiedMiddleware,
    passwordConfirmed: PasswordConfirmedMiddleware,
    shareErrorsFromSession: ShareErrorsFromSessionMiddleware
  }
}
