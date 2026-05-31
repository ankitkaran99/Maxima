import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'
import { User } from '@app/Models/User.js'
import { BouncerManager } from '../src/BouncerManager.js'
import { BouncerServiceProvider } from '../src/BouncerServiceProvider.js'
import BouncerInstallCommand from '../src/commands/BouncerInstallCommand.js'
import { Gate } from '@lib/auth/Gate.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

describe('Bouncer Permission Plugin', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let app: Application
  let tempStorageRoot: string

  beforeEach(async () => {
    await DB.close()
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-bouncer-'))
    process.env.MAXIMA_BASE_PATH = tempStorageRoot

    app = new Application(tempStorageRoot)
    setApplication(app)

    BouncerManager.reset()

    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })

    // Setup users table
    await DB.connection().schema.createTable('users', table => {
      table.increments('id').primary()
      table.string('name')
      table.string('email').unique()
      table.string('password')
      table.timestamps(true, true)
    })

    // Run the install command to create Bouncer tables
    const installCommand = new BouncerInstallCommand()
    await installCommand.handle({ force: true })

    // Register service provider
    await app.register(BouncerServiceProvider)
    await app.bootProviders()
  })

  afterEach(async () => {
    Gate.clear()
    await DB.close()
    if (originalBasePath) {
      process.env.MAXIMA_BASE_PATH = originalBasePath
    } else {
      delete process.env.MAXIMA_BASE_PATH
    }
    await fs.rm(tempStorageRoot, { recursive: true, force: true })
  })

  describe('Database Installation', () => {
    it('creates all required tables', async () => {
      expect(await Schema.hasTable('roles')).toBe(true)
      expect(await Schema.hasTable('abilities')).toBe(true)
      expect(await Schema.hasTable('user_roles')).toBe(true)
      expect(await Schema.hasTable('role_abilities')).toBe(true)
      expect(await Schema.hasTable('user_abilities')).toBe(true)
    })

    it('can run install command multiple times without force', async () => {
      const installCommand = new BouncerInstallCommand()
      await expect(installCommand.handle({})).resolves.not.toThrow()
    })

    it('can run install command with force to recreate tables', async () => {
      const installCommand = new BouncerInstallCommand()
      await expect(installCommand.handle({ force: true })).resolves.not.toThrow()
      expect(await Schema.hasTable('roles')).toBe(true)
    })
  })

  describe('Role Management', () => {
    it('can assign and retract roles', async () => {
      const user = await User.create({ name: 'Test User', email: 'test@user.com', password: 'password' })

      // Initial check
      expect(await user.isAn('admin')).toBe(false)
      expect(await user.isNotAn('admin')).toBe(true)

      // Assign role
      await user.assign('admin')
      expect(await user.isAn('admin')).toBe(true)
      expect(await user.isA('admin')).toBe(true)
      expect(await user.isNotAn('admin')).toBe(false)
      expect(await user.isNotA('admin')).toBe(false)

      // Retract role
      await user.retract('admin')
      expect(await user.isAn('admin')).toBe(false)
    })
  })

  describe('Ability/Permission Management', () => {
    it('can grant and remove direct abilities', async () => {
      const user = await User.create({ name: 'Test User', email: 'test@user.com', password: 'password' })

      // Initially no access
      expect(await Gate.forUser(user).allows('edit-profile')).toBe(false)

      // Allow
      await user.allow('edit-profile')
      expect(await Gate.forUser(user).allows('edit-profile')).toBe(true)

      // Disallow
      await user.disallow('edit-profile')
      expect(await Gate.forUser(user).allows('edit-profile')).toBe(false)
    })

    it('can grant abilities via roles', async () => {
      const user = await User.create({ name: 'Test User', email: 'test@user.com', password: 'password' })

      expect(await Gate.forUser(user).allows('publish-articles')).toBe(false)

      // Assign role
      await user.assign('editor')

      // Grant ability to role
      await BouncerManager.allow('editor').to('publish-articles')

      expect(await Gate.forUser(user).allows('publish-articles')).toBe(true)

      // Remove ability from role
      await BouncerManager.disallow('editor').to('publish-articles')

      expect(await Gate.forUser(user).allows('publish-articles')).toBe(false)
    })
  })

  describe('Super Admin functionality', () => {
    it('automatically grants all permissions to super admin role by default', async () => {
      const user = await User.create({ name: 'Admin User', email: 'admin@user.com', password: 'password' })
      await user.assign('admin')

      expect(await Gate.forUser(user).allows('any-random-permission')).toBe(true)
    })

    it('respects custom super admin callback', async () => {
      const user = await User.create({ name: 'Super User', email: 'super@user.com', password: 'password' })

      BouncerManager.isSuperAdmin((u) => u.email === 'super@user.com')

      expect(await Gate.forUser(user).allows('some-permission')).toBe(true)

      const ordinaryUser = await User.create({ name: 'Ordinary', email: 'ordinary@user.com', password: 'password' })
      expect(await Gate.forUser(ordinaryUser).allows('some-permission')).toBe(false)
    })
  })

  describe('Gate Integration fallback', () => {
    it('falls back to standard Gate define options if not allowed in Bouncer', async () => {
      const user = await User.create({ name: 'Test User', email: 'test@user.com', password: 'password' })

      // Define standard Gate ability
      Gate.define('view-dashboard', (u) => u.name === 'Test User')

      expect(await Gate.forUser(user).allows('view-dashboard')).toBe(true)

      const user2 = await User.create({ name: 'Another', email: 'another@user.com', password: 'password' })
      expect(await Gate.forUser(user2).allows('view-dashboard')).toBe(false)
    })
  })

  describe('Model-Specific Permissions', () => {
    class Post {
      constructor(public id: number, public user_id: number) {}
    }

    it('can grant and remove abilities on a model class', async () => {
      const user = await User.create({ name: 'Test User', email: 'test@user.com', password: 'password' })
      const post = new Post(1, user.id)

      expect(await Gate.forUser(user).allows('edit', Post)).toBe(false)
      expect(await Gate.forUser(user).allows('edit', post)).toBe(false)

      await BouncerManager.allow(user).to('edit', Post)

      expect(await Gate.forUser(user).allows('edit', Post)).toBe(true)
      expect(await Gate.forUser(user).allows('edit', post)).toBe(true)

      await BouncerManager.disallow(user).to('edit', Post)

      expect(await Gate.forUser(user).allows('edit', Post)).toBe(false)
      expect(await Gate.forUser(user).allows('edit', post)).toBe(false)
    })

    it('can grant and remove abilities on a model instance', async () => {
      const user = await User.create({ name: 'Test User', email: 'test@user.com', password: 'password' })
      const post1 = new Post(1, user.id)
      const post2 = new Post(2, user.id)

      expect(await Gate.forUser(user).allows('edit', post1)).toBe(false)
      expect(await Gate.forUser(user).allows('edit', post2)).toBe(false)

      await BouncerManager.allow(user).to('edit', post1)

      expect(await Gate.forUser(user).allows('edit', post1)).toBe(true)
      expect(await Gate.forUser(user).allows('edit', post2)).toBe(false)

      await BouncerManager.disallow(user).to('edit', post1)

      expect(await Gate.forUser(user).allows('edit', post1)).toBe(false)
    })
  })

  describe('Forbidden Permissions', () => {
    it('can forbid and unforbid permissions directly on user', async () => {
      const user = await User.create({ name: 'Test User', email: 'test@user.com', password: 'password' })

      // Standard gate allows it
      Gate.define('delete-record', () => true)
      expect(await Gate.forUser(user).allows('delete-record')).toBe(true)

      // Bouncer forbids it
      await BouncerManager.forbid(user).to('delete-record')
      expect(await Gate.forUser(user).allows('delete-record')).toBe(false)

      // Unforbid
      await BouncerManager.unforbid(user).to('delete-record')
      expect(await Gate.forUser(user).allows('delete-record')).toBe(true)
    })

    it('can forbid permissions via roles', async () => {
      const user = await User.create({ name: 'Test User', email: 'test@user.com', password: 'password' })
      await user.assign('editor')

      Gate.define('publish', () => true)
      expect(await Gate.forUser(user).allows('publish')).toBe(true)

      await BouncerManager.forbid('editor').to('publish')
      expect(await Gate.forUser(user).allows('publish')).toBe(false)

      await BouncerManager.unforbid('editor').to('publish')
      expect(await Gate.forUser(user).allows('publish')).toBe(true)
    })
  })

  describe('Ownership Permissions', () => {
    class Post {
      constructor(public id: number, public user_id: number) {}
    }

    it('can allow edit only to owned model instance', async () => {
      const user = await User.create({ name: 'Test User', email: 'test@user.com', password: 'password' })
      const otherUser = await User.create({ name: 'Other', email: 'other@user.com', password: 'password' })

      const myPost = new Post(1, user.id)
      const otherPost = new Post(2, otherUser.id)

      await BouncerManager.allow(user).toOwn(Post).to('edit')

      expect(await Gate.forUser(user).allows('edit', myPost)).toBe(true)
      expect(await Gate.forUser(user).allows('edit', otherPost)).toBe(false)
      expect(await Gate.forUser(user).allows('edit', Post)).toBe(false) // cannot edit Post class

      await BouncerManager.disallow(user).toOwn(Post).to('edit')
      expect(await Gate.forUser(user).allows('edit', myPost)).toBe(false)
    })

    it('can forbid editing owned model instance', async () => {
      const user = await User.create({ name: 'Test User', email: 'test@user.com', password: 'password' })
      const myPost = new Post(1, user.id)

      // Setup standard allowed gate or allow first
      await BouncerManager.allow(user).to('edit', Post)
      expect(await Gate.forUser(user).allows('edit', myPost)).toBe(true)

      // Now forbid ownership
      await BouncerManager.forbid(user).toOwn(Post).to('edit')
      expect(await Gate.forUser(user).allows('edit', myPost)).toBe(false)

      // Unforbid
      await BouncerManager.unforbid(user).toOwn(Post).to('edit')
      expect(await Gate.forUser(user).allows('edit', myPost)).toBe(true)
    })
  })
})
