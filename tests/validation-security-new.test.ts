import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { Application } from '@lib/foundation/Application.js'
import { setApplication, signedUrl } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'
import { schema } from '@lib/validation/schema.js'
import { Validator } from '@lib/validation/Validator.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Route } from '@lib/http/Route.js'
import supertest from 'supertest'

describe('Validation & Security Gaps', () => {
  let app: Application
  let kernel: HttpKernel

  beforeEach(async () => {
    await DB.close()
    Route.clear()

    app = new Application(path.join(process.cwd(), 'src'))
    setApplication(app)

    await app.bootstrap()

    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    app.config.set('app.key', 'test-app-key-123456')
    app.config.set('app.url', 'http://127.0.0.1:3000')

    app.config.set('logging', {
      default: 'console',
      channels: {
        console: { driver: 'null' }
      }
    })

    await Schema.create('users', table => {
      table.increments('id')
      table.string('email').unique()
    })

    await DB.table('users').insert({ email: 'test@example.com' })

    kernel = new HttpKernel(app)
  })

  afterEach(async () => {
    await DB.close()
    Route.clear()
  })

  describe('Database Validation Rules (exists, unique)', () => {
    it('exists rule validates presence in database', async () => {
      const rules = {
        email: schema.string().exists('users', 'email')
      }

      // Valid existing email
      const data1 = await Validator.validate({ email: 'test@example.com' }, rules)
      expect(data1.email).toBe('test@example.com')

      // Non-existing email should throw
      await expect(
        Validator.validate({ email: 'missing@example.com' }, rules)
      ).rejects.toThrow()
    })

    it('unique rule validates absence in database', async () => {
      const rules = {
        email: schema.string().unique('users', 'email')
      }

      // Non-existing email (unique)
      const data1 = await Validator.validate({ email: 'new@example.com' }, rules)
      expect(data1.email).toBe('new@example.com')

      // Existing email should throw
      await expect(
        Validator.validate({ email: 'test@example.com' }, rules)
      ).rejects.toThrow()
    })
  })

  describe('Signed URL Middleware', () => {
    it('allows valid signatures and rejects invalid/expired ones', async () => {
      Route.get('/profile', (req) => {
        return { status: 'authorized', user_id: req.input('user_id') }
      }).middleware('signed')

      await kernel.bootstrap()

      const server = kernel.getFastify().server

      // Generate a valid signed URL
      const validUrlStr = signedUrl('/profile', { user_id: '42' })
      const validPath = new URL(validUrlStr).pathname + new URL(validUrlStr).search

      // Request with valid signature
      const res1 = await supertest(server).get(validPath)
      expect(res1.status).toBe(200)
      expect(res1.body).toEqual({ status: 'authorized', user_id: '42' })

      // Request with tempered parameter
      const tamperedPath = validPath.replace('user_id=42', 'user_id=99')
      const res2 = await supertest(server).get(tamperedPath)
      expect(res2.status).toBe(403)
      expect(res2.body.message).toContain('Invalid or expired signature')

      // Request with missing signature
      const res3 = await supertest(server).get('/profile?user_id=42')
      expect(res3.status).toBe(403)
      expect(res3.body.message).toContain('Invalid or expired signature')

      // Request with expired signature
      const expiredUrlStr = signedUrl('/profile', { user_id: '42' }, new Date(Date.now() - 10000))
      const expiredPath = new URL(expiredUrlStr).pathname + new URL(expiredUrlStr).search
      const res4 = await supertest(server).get(expiredPath)
      expect(res4.status).toBe(403)
      expect(res4.body.message).toContain('Invalid or expired signature')
    })
  })
})
