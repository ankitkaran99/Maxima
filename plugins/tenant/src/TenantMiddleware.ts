import type { FastifyReply } from 'fastify'
import { Request } from '@lib/http/Request.js'
import { Next } from '@lib/http/Middleware.js'
import { TenantManager } from './TenantManager.js'
import { runWithTenant } from './TenantContext.js'
import { config } from '@lib/foundation/helpers.js'

export class TenantMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next) {
    const tenant = await TenantManager.resolveFromRequest(request)
    
    if (!tenant) {
      const abortOnFail = config<boolean>('tenancy.abort_on_fail', true)
      if (abortOnFail) {
        return reply.status(404).send({ error: 'Tenant not found.' })
      }
      return next()
    }

    return runWithTenant(tenant, () => next())
  }
}
