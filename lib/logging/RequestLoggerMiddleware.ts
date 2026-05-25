import { ulid } from 'ulid'
import type { FastifyReply } from 'fastify'
import type { Request } from '@lib/http/Request.js'
import type { Next } from '@lib/http/Middleware.js'
import { Log } from '@lib/logging/LogManager.js'

export class RequestLoggerMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next) {
    const start = performance.now()
    const requestId = String(request.headers['x-request-id'] ?? ulid())
    ;(request.raw as any).requestId = requestId
    ;(request.raw as any).log = Log.withContext({ requestId, ip: typeof request.ip === 'function' ? request.ip() : request.ip })

    await Log.runWithContext({ requestId }, async () => {
      request.log?.info('Incoming request', { method: request.raw.method, url: request.raw.url, userAgent: request.headers['user-agent'] })
      await next()
      request.log?.info('Request completed', { statusCode: reply.statusCode, durationMs: Math.round(performance.now() - start) })
    })
  }
}
