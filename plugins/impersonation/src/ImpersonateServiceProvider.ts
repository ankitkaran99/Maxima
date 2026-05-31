import { ServiceProvider } from '@lib/container/Container.js'
import { Request } from '@lib/http/Request.js'
import { Route } from '@lib/http/Route.js'
import { ImpersonateManager } from './ImpersonateManager.js'
import { ImpersonatingMiddleware, BlockImpersonatedMiddleware } from './ImpersonateMiddleware.js'

declare module '@lib/http/Request.js' {
  interface Request {
    isImpersonating(): boolean
    impersonator(): Promise<any | null>
    impersonatorId(): any | null
  }
}

export class ImpersonateServiceProvider extends ServiceProvider {
  register() {
    // 1. Bind to app
    this.app.singleton('impersonate', () => ImpersonateManager)

    // 2. Set default configuration
    const configRepo = (this.app as any).config
    if (!configRepo.has('impersonate')) {
      configRepo.set('impersonate', {
        guard: 'session',
        session_key: 'impersonator_user_id',
        routes: {
          enabled: true,
          take_path: '/impersonate/take',
          leave_path: '/impersonate/leave',
          middleware: ['web', 'auth']
        }
      })
    }

    // 3. Register request macros
    Request.macro('isImpersonating', function(this: Request) {
      return ImpersonateManager.isImpersonating(this)
    })

    Request.macro('impersonator', function(this: Request) {
      return ImpersonateManager.impersonator(this)
    })

    Request.macro('impersonatorId', function(this: Request) {
      const sessionKey = configRepo.get('impersonate.session_key', 'impersonator_user_id')
      return this.session?.get(sessionKey) ?? null
    })
  }

  boot() {
    // Register middleware aliases
    const aliases = (this.app as any).config.get('middleware.aliases') as any
    if (aliases) {
      if (!aliases.impersonating) {
        aliases.impersonating = ImpersonatingMiddleware
      }
      if (!aliases.block_impersonated) {
        aliases.block_impersonated = BlockImpersonatedMiddleware
      }
    }

    // Register built-in routes
    const config = (this.app as any).config.get('impersonate') || {}
    if (config.routes?.enabled ?? true) {
      const middleware = config.routes?.middleware ?? ['web', 'auth']
      const takePath = config.routes?.take_path ?? '/impersonate/take'
      const leavePath = config.routes?.leave_path ?? '/impersonate/leave'

      Route.group({ middleware }, () => {
        Route.post(takePath, async (request: Request) => {
          const targetId = request.input<string | number>('id')
          if (!targetId) {
            request.reply.code(422)
            return { message: 'Target user ID is required.' }
          }

          const guard = config.guard ?? 'session'
          const { Auth } = await import('@lib/auth/AuthManager.js')
          const up = Auth.providerForGuard(guard)
          const impersonated = await up.retrieveById(targetId)
          if (!impersonated) {
            request.reply.code(404)
            return { message: 'Target user not found.' }
          }

          const impersonator = await request.user()
          if (!impersonator) {
            request.reply.code(401)
            return { message: 'Unauthenticated.' }
          }

          const allowed = await ImpersonateManager.checkTake(impersonator, impersonated, request)
          if (!allowed) {
            request.reply.code(403)
            return { message: 'Impersonation unauthorized.' }
          }

          await ImpersonateManager.take(request, impersonator, impersonated, guard)
          return { message: `Now impersonating user ${impersonated.id}.`, impersonating: true }
        })

        Route.post(leavePath, async (request: Request) => {
          if (!ImpersonateManager.isImpersonating(request)) {
            request.reply.code(400)
            return { message: 'Not impersonating.' }
          }

          const guard = config.guard ?? 'session'
          await ImpersonateManager.leave(request, guard)
          return { message: 'Impersonation stopped.', impersonating: false }
        })
      })
    }
  }
}
