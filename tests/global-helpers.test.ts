import { describe, expect, it, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { basePath, configPath, databasePath, storagePath, publicPath } from '@lib/support/paths.js'
import * as Maxima from '@lib/index.js'

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

  describe('Path Helpers Consistency', () => {
    it('resolves framework paths inside src/ when nested src configuration exists', async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-path-nested-'))
      const srcDir = path.join(tempRoot, 'src')
      await fs.mkdir(path.join(srcDir, 'config'), { recursive: true })

      const originalBasePath = process.env.MAXIMA_BASE_PATH
      try {
        process.env.MAXIMA_BASE_PATH = tempRoot

        expect(basePath()).toBe(srcDir)
        expect(configPath('app.ts')).toBe(path.join(srcDir, 'config', 'app.ts'))
        expect(databasePath('database.sqlite')).toBe(path.join(srcDir, 'database', 'database.sqlite'))
        expect(storagePath('logs/maxima.log')).toBe(path.join(tempRoot, 'storage', 'logs', 'maxima.log'))
        expect(publicPath('assets')).toBe(path.join(tempRoot, 'public', 'assets'))
      } finally {
        process.env.MAXIMA_BASE_PATH = originalBasePath
        await fs.rm(tempRoot, { recursive: true, force: true })
      }
    })

    it('resolves framework paths in the root when flat configuration exists', async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-path-flat-'))
      await fs.mkdir(path.join(tempRoot, 'config'), { recursive: true })

      const originalBasePath = process.env.MAXIMA_BASE_PATH
      try {
        process.env.MAXIMA_BASE_PATH = tempRoot

        expect(basePath()).toBe(tempRoot)
        expect(configPath('app.ts')).toBe(path.join(tempRoot, 'config', 'app.ts'))
        expect(databasePath('database.sqlite')).toBe(path.join(tempRoot, 'database', 'database.sqlite'))
        expect(storagePath('logs/maxima.log')).toBe(path.join(tempRoot, 'storage', 'logs', 'maxima.log'))
        expect(publicPath('assets')).toBe(path.join(tempRoot, 'public', 'assets'))
      } finally {
        process.env.MAXIMA_BASE_PATH = originalBasePath
        await fs.rm(tempRoot, { recursive: true, force: true })
      }
    })
  })

  it('exports public framework utilities from the package barrel', () => {
    expect(Maxima.RateLimiter).toBeDefined()
    expect(Maxima.Limit.perMinute(1).max).toBe(1)
    expect(Maxima.ViewFactory).toBeDefined()
    expect(Maxima.ValidationException).toBeDefined()
    expect(Maxima.QueueWorker).toBeDefined()
    expect(Maxima.HasApiTokens).toBeDefined()
    expect(Maxima.PersonalAccessToken).toBeDefined()
    expect(Maxima.CookieMiddleware).toBeDefined()
    expect(Maxima.ThrottleMiddleware).toBeDefined()
    expect(Maxima.MiddlewarePipeline).toBeDefined()
  })
})
