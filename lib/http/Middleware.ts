import type { FastifyReply } from 'fastify'
import type { Request } from '@lib/http/Request.js'

export type Next = () => Promise<void>
export type MiddlewareHandler = (request: Request, reply: FastifyReply, next: Next) => Promise<void | unknown>
export type MiddlewareClass = { handle: MiddlewareHandler }

export class MiddlewarePipeline {
  constructor(private middleware: MiddlewareHandler[]) {}

  async run(request: Request, reply: FastifyReply) {
    let index = -1
    let completed = false
    const dispatch = async (position: number): Promise<void> => {
      if (position <= index) throw new Error('next() called multiple times in middleware pipeline.')
      index = position
      const layer = this.middleware[position]
      if (!layer) {
        completed = true
        return
      }
      await layer(request, reply, () => dispatch(position + 1))
    }
    await dispatch(0)
    return completed
  }
}
