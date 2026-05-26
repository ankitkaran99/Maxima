import { Cache } from '@lib/cache/Cache.js'

type Next = () => Promise<void>

export class WithoutOverlapping {
  private expiresAfterSeconds = 3600
  private releaseAfterSeconds = 0

  constructor(private readonly key?: string) {}

  expireAfter(seconds: number) {
    this.expiresAfterSeconds = seconds
    return this
  }

  releaseAfter(seconds: number) {
    this.releaseAfterSeconds = seconds
    return this
  }

  async handle(job: any, next: Next) {
    const key = this.key ?? `${job.constructor.name}:${job.uniqueId?.() ?? JSON.stringify(job)}`
    const lock = Cache.lock(`queue:overlap:${key}`, this.expiresAfterSeconds)
    if (!await lock.get()) {
      if (this.releaseAfterSeconds > 0 && typeof job.release === 'function') await job.release(this.releaseAfterSeconds)
      return
    }

    try {
      await next()
    } finally {
      await lock.release()
    }
  }
}

export class RateLimited {
  constructor(private readonly key: string, private readonly maxAttempts = 60, private readonly decaySeconds = 60) {}

  async handle(job: any, next: Next) {
    const cacheKey = `queue:rate:${this.key}`
    const attempts = Number(await Cache.get(cacheKey) ?? 0)
    if (attempts >= this.maxAttempts) {
      if (typeof job.release === 'function') await job.release(this.decaySeconds)
      return
    }
    await Cache.put(cacheKey, attempts + 1, this.decaySeconds)
    await next()
  }
}

export class ThrottlesExceptions {
  private backoffSeconds = 0

  constructor(private readonly maxExceptions = 10, private readonly decaySeconds = 60, private readonly key?: string) {}

  backoff(seconds: number) {
    this.backoffSeconds = seconds
    return this
  }

  async handle(job: any, next: Next) {
    const cacheKey = `queue:exceptions:${this.key ?? job.constructor.name}`
    const exceptions = Number(await Cache.get(cacheKey) ?? 0)
    if (exceptions >= this.maxExceptions) {
      if (typeof job.release === 'function') await job.release(this.decaySeconds)
      return
    }

    try {
      await next()
      await Cache.forget(cacheKey)
    } catch (error) {
      await Cache.put(cacheKey, exceptions + 1, this.decaySeconds)
      if (this.backoffSeconds > 0 && typeof job.release === 'function') await job.release(this.backoffSeconds)
      throw error
    }
  }
}
