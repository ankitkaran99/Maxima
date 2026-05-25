import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Cache } from '@lib/cache/Cache.js'

beforeEach(() => {
  const app = new Application(process.cwd())
  setApplication(app)
  app.config.set('cache', {
    default: 'memory',
    stores: {
      memory: { driver: 'memory', prefix: 'maxima_cache' }
    }
  })
  Cache.restore()
})

afterEach(() => {
  Cache.restore()
  vi.useRealTimers()
})

describe('Cache', () => {
  it('stores values, remembers them, and expires ttl entries', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-23T10:00:00.000Z'))

    await Cache.put('user:1', { name: 'Ava' }, 60)
    expect(await Cache.get('user:1')).toEqual({ name: 'Ava' })

    await Cache.remember('settings', 60, () => ({ theme: 'dark' }))
    expect(await Cache.get('settings')).toEqual({ theme: 'dark' })

    vi.setSystemTime(new Date('2026-05-23T10:02:01.000Z'))
    expect(await Cache.get('user:1')).toBeUndefined()
  })

  it('supports tags and invalidation hooks', async () => {
    const invalidated: string[] = []
    const unsubscribe = Cache.onInvalidated(({ key, reason }) => {
      invalidated.push(`${reason}:${key}`)
    })

    const tagged = Cache.tags('posts', 'featured')
    await tagged.put('latest', 'hello')

    expect(await tagged.get('latest')).toBe('hello')
    tagged.flush()
    expect(await tagged.get('latest')).toBeUndefined()
    expect(invalidated.some(entry => entry.startsWith('flushed:'))).toBe(true)

    unsubscribe()
  })

  it('provides locks and assertions', async () => {
    const lock = Cache.lock('reports')
    expect(await lock.get()).toBe(true)
    expect(await Cache.lock('reports').get()).toBe(false)
    expect(await lock.release()).toBe(true)
    expect(await Cache.lock('reports').get()).toBe(true)


    await Cache.put('alpha', 1)
    expect(() => Cache.assertHas('alpha', 1)).not.toThrow()
    expect(() => Cache.assertMissing('alpha')).toThrow()
  })
})
