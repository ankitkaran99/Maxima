import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Model } from '@lib/database/Model.js'
import { Gate } from '@lib/auth/Gate.js'
import { HasApiTokens } from '@lib/auth/HasApiTokens.js'
import { PersonalAccessToken } from '@lib/auth/PersonalAccessToken.js'
import { Auth } from '@lib/auth/AuthManager.js'
import { HttpKernel } from '@lib/http/Kernel.js'

import { SerializableModelRegistry } from '@lib/database/SerializableModelRegistry.js'

class CustomUser extends HasApiTokens {
  static table = 'users'
}
SerializableModelRegistry.register(CustomUser)

class AutoDummyPost extends Model {
  static table = 'posts'
}
SerializableModelRegistry.register(AutoDummyPost)

describe('Authentication & Security Gaps', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let root = ''
  let app: Application

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-auth-gaps-'))
    const srcPath = path.join(root, 'src')
    process.env.MAXIMA_BASE_PATH = srcPath

    app = new Application(srcPath)
    setApplication(app)
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    app.config.set('auth', {
      defaults: {
        guard: 'token',
        provider: 'users'
      },
      guards: {
        token: {
          driver: 'token',
          provider: 'users'
        }
      },
      providers: {
        users: {
          driver: {
            async retrieveById(id: any) {
              return CustomUser.find(id)
            },
            async retrieveByCredentials(creds: any) {
              if (creds.token) {
                // PersonalAccessToken fallback
                return null
              }
              return CustomUser.where('email', creds.email).first()
            }
          }
        }
      }
    })

    // Create DB tables
    await DB.connection().schema.createTable('users', table => {
      table.increments('id')
      table.string('name')
      table.string('email')
      table.timestamps(true, true)
    })

    await DB.connection().schema.createTable('posts', table => {
      table.increments('id')
      table.integer('user_id')
      table.string('title')
      table.timestamps(true, true)
    })

    await DB.connection().schema.createTable('personal_access_tokens', table => {
      table.increments('id')
      table.string('tokenable_type')
      table.integer('tokenable_id')
      table.string('name')
      table.string('token', 64).unique()
      table.text('abilities').nullable()
      table.timestamp('last_used_at').nullable()
      table.timestamp('expires_at').nullable()
      table.timestamps(true, true)
    })

    await fs.mkdir(path.join(srcPath, 'app', 'Policies'), { recursive: true })
    await fs.mkdir(path.join(srcPath, 'config'), { recursive: true })
  })

  afterEach(async () => {
    process.env.MAXIMA_BASE_PATH = originalBasePath
    Gate.clear()
    await DB.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('supports policy auto-discovery from app/Policies directory', async () => {
    // Write dynamic policy class file
    const policyContent = `
      export default class AutoDummyPostPolicy {
        update(user, post) {
          return Number(post.user_id) === Number(user.id)
        }
      }
    `
    await fs.writeFile(path.join(root, 'src', 'app', 'Policies', 'AutoDummyPostPolicy.ts'), policyContent)

    const user = await CustomUser.create({ name: 'Alice', email: 'alice@example.com' })
    const user2 = await CustomUser.create({ name: 'Bob', email: 'bob@example.com' })
    const post = await AutoDummyPost.create({ user_id: user.id, title: 'My Post' })

    const canUpdate = await Gate.forUser(user).allows('update', post)
    const canUpdate2 = await Gate.forUser(user2).allows('update', post)

    expect(canUpdate).toBe(true)
    expect(canUpdate2).toBe(false)
  })

  it('issues personal access tokens with abilities and validates via Auth guard', async () => {
    const user = await CustomUser.create({ name: 'Alice', email: 'alice@example.com' }) as CustomUser
    
    // Create token with abilities
    const tokenResult = await user.createToken('test-device', ['read:posts'])
    expect(tokenResult.plainTextToken).toBeDefined()
    expect(tokenResult.accessToken.token).toBeDefined()

    // Verify tokenable relation
    const tokenable = await tokenResult.accessToken.tokenable().first()
    expect(tokenable.id).toBe(user.id)

    // Verify token retrieval from tokens hasMany relation
    const tokens = await user.tokens().get()
    expect(tokens.length).toBe(1)
    expect(tokens[0].name).toBe('test-device')

    // Mock HTTP request to use token
    const mockRequest = {
      headers: {
        authorization: `Bearer ${tokenResult.plainTextToken}`
      },
      query: {},
      raw: {}
    } as any
    mockRequest.raw.maximaRequest = mockRequest

    Auth.setRequest(mockRequest, {})

    const authenticatedUser = await Auth.user() as CustomUser
    expect(authenticatedUser).toBeDefined()
    expect(authenticatedUser.id).toBe(user.id)
    expect(authenticatedUser.accessToken).toBeDefined()

    // Verify abilities
    expect(authenticatedUser.tokenCan('read:posts')).toBe(true)
    expect(authenticatedUser.tokenCan('write:posts')).toBe(false)

    // Revoke token
    await tokenResult.accessToken.delete()
    const revokedTokens = await user.tokens().get()
    expect(revokedTokens.length).toBe(0)

    // Auth should fail now
    Auth.setRequest({ headers: { authorization: `Bearer ${tokenResult.plainTextToken}` } } as any)
    const failedUser = await Auth.user()
    expect(failedUser).toBeNull()
  })
})
