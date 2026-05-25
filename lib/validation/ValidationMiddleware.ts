import type { FastifyReply } from 'fastify'
import type { Request } from '@lib/http/Request.js'
import type { Next } from '@lib/http/Middleware.js'
import { ValidationException } from '@lib/validation/ValidationException.js'

export class ShareErrorsFromSessionMiddleware {
  async handle(request: Request, _reply: FastifyReply, next: Next) {
    if (typeof request.session?.errorBags === 'function') {
      request.setErrorBags(request.session.errorBags())
    } else {
      request.setErrors(request.session?.get?.('_errors') ?? {})
    }
    return next()
  }
}

export class ValidationMiddleware {
  constructor(private rules: Record<string, any> = {}) {}

  async handle(request: Request, _reply: FastifyReply, next: Next) {
    try {
      await request.validate(this.rules)
      return next()
    } catch (error) {
      if (error instanceof ValidationException) request.setErrors(error.errors)
      throw error
    }
  }
}
