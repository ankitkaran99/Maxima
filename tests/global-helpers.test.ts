import { describe, expect, it, beforeEach } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'

describe('Global Helpers', () => {
  beforeEach(async () => {
    const app = new Application(process.cwd())
    setApplication(app)
    await app.bootstrap()
    app.config.set('app.url', 'http://localhost-test')
    app.config.set('cache.default', 'memory')
    app.config.set('cache.stores.memory', { driver: 'memory', prefix: 'test' })
  })

  it('exposes helpers globally without manual imports', () => {
    // Check config helper
    expect((global as any).config).toBeDefined()
    expect((global as any).config('app.url')).toBe('http://localhost-test')

    // Check env helper
    expect((global as any).env).toBeDefined()
    
    // Check url helper
    expect((global as any).url).toBeDefined()
    expect((global as any).url('/users', { search: 'query' })).toBe('http://localhost-test/users?search=query')

    // Check path helpers
    expect((global as any).storage_path).toBeDefined()
    expect((global as any).storage_path('logs/maxima.log').replace(/\\/g, '/')).toContain('/storage/logs/maxima.log')

    expect((global as any).public_path).toBeDefined()
    expect((global as any).public_path('assets/app.js').replace(/\\/g, '/')).toContain('/public/assets/app.js')

    // Check cache helper
    expect((global as any).cache).toBeDefined()
  })
})
