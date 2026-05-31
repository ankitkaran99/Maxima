import type { FastifyReply } from 'fastify'
import type { Request } from '@lib/http/Request.js'
import type { Next } from '@lib/http/Middleware.js'
import { ImpersonateManager } from './ImpersonateManager.js'

export class ImpersonatingMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next) {
    if (!ImpersonateManager.isImpersonating(request)) {
      return reply.code(403).send({ message: 'Forbidden. Impersonation is not active.' })
    }
    return next()
  }
}

export class BlockImpersonatedMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next) {
    if (ImpersonateManager.isImpersonating(request)) {
      return reply.code(403).send({ message: 'Forbidden. This action cannot be performed while impersonating.' })
    }
    return next()
  }
}
