import type { FastifyReply } from 'fastify'
import type { Request } from '@lib/http/Request.js'
import type { Next } from '@lib/http/Middleware.js'
import { Auth } from '@lib/auth/AuthManager.js'
import { Gate } from '@lib/auth/Gate.js'

export class AuthMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next) {
    Auth.setRequest(request.raw, reply)
    if (!(await Auth.check())) return reply.code(401).send({ message: 'Unauthenticated.' })
    return next()
  }
}

export class GuestMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next) {
    Auth.setRequest(request.raw, reply)
    if (await Auth.check()) return reply.redirect('/')
    return next()
  }
}

export class CanMiddleware {
  async handle(request: Request, _reply: FastifyReply, next: Next, parameter = '') {
    const [ability, subjectParam] = parameter.split(',')
    const subject = subjectParam ? await this.resolveSubject(request, subjectParam) : undefined
    await Gate.authorize(ability, subject, request.user())
    return next()
  }

  private async resolveSubject(request: Request, subjectParam: string) {
    const direct = request.params[subjectParam] ?? request.input(subjectParam)
    if (direct !== undefined) return direct

    const modelName = this.normalizeModelName(subjectParam)
    const candidateId = request.params.id ?? request.input('id')
    if (candidateId === undefined) return undefined

    try {
      const modelModule = await import(new URL(`../../src/app/Models/${modelName}.js`, import.meta.url).href)
      const Model = modelModule.default ?? modelModule[modelName]
      if (typeof Model?.findOrFail === 'function') return await Model.findOrFail(candidateId)
    } catch (error: any) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') throw error
    }

    return candidateId
  }

  private normalizeModelName(name: string) {
    const singular = name.endsWith('s') ? name.slice(0, -1) : name
    return singular.charAt(0).toUpperCase() + singular.slice(1)
  }
}

export class VerifiedMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next) {
    Auth.setRequest(request.raw, reply)
    const user = await Auth.user()
    if (!user) return reply.code(401).send({ message: 'Unauthenticated.' })
    if (!(await Auth.hasVerifiedEmail(user))) return reply.code(403).send({ message: 'Email address is not verified.' })
    return next()
  }
}

export class PasswordConfirmedMiddleware {
  async handle(request: Request, reply: FastifyReply, next: Next) {
    Auth.setRequest(request.raw, reply)
    if (!Auth.passwordConfirmed()) return reply.code(423).send({ message: 'Password confirmation required.' })
    return next()
  }
}
