import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Model } from '@lib/database/Model.js'
import { SerializableModelRegistry } from '@lib/database/SerializableModelRegistry.js'
import moment from 'moment'

// Models for Eager Loading
class EagerUser extends Model {
  static table = 'eager_users'
  static fillable = ['name']
  static timestamps = false
  declare id: number
  declare name: string

  posts() {
    return this.hasMany(EagerPost, 'user_id')
  }
}

class EagerPost extends Model {
  static table = 'eager_posts'
  static fillable = ['user_id', 'title']
  static timestamps = false
  declare id: number
  declare user_id: number
  declare title: string
}

// Models for Pivot testing
class PivotUser extends Model {
  static table = 'pivot_users'
  static fillable = ['name']
  static timestamps = false
  declare id: number
  declare name: string

  roles() {
    return this.belongsToMany(PivotRole, 'user_roles', 'user_id', 'role_id')
  }
}

class PivotRole extends Model {
  static table = 'pivot_roles'
  static fillable = ['name']
  static timestamps = false
  declare id: number
  declare name: string
}

// Models for Scoping
class ScopedUser extends Model {
  static table = 'scoped_users'
  static fillable = ['name', 'active']
  static timestamps = false
  declare id: number
  declare name: string
  declare active: boolean
}

// Models for Touching
class TouchUser extends Model {
  static table = 'touch_users'
  static fillable = ['name']
  declare id: number
  declare name: string
}

class TouchPost extends Model {
  static table = 'touch_posts'
  static fillable = ['user_id', 'title']
  static touches = ['user']
  declare id: number
  declare user_id: number
  declare title: string

  user() {
    return this.belongsTo(TouchUser, 'user_id')
  }
}

// Register models
SerializableModelRegistry.register(EagerUser, 'EagerUser')
SerializableModelRegistry.register(EagerPost, 'EagerPost')
SerializableModelRegistry.register(PivotUser, 'PivotUser')
SerializableModelRegistry.register(PivotRole, 'PivotRole')
SerializableModelRegistry.register(ScopedUser, 'ScopedUser')
SerializableModelRegistry.register(TouchUser, 'TouchUser')
SerializableModelRegistry.register(TouchPost, 'TouchPost')

describe('ORM & Database Extras', () => {
  beforeEach(async () => {
    await DB.close()
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })

    const schema = DB.connection().schema

    // Drop tables if they exist
    await schema.dropTableIfExists('eager_posts')
    await schema.dropTableIfExists('eager_users')
    await schema.dropTableIfExists('user_roles')
    await schema.dropTableIfExists('pivot_users')
    await schema.dropTableIfExists('pivot_roles')
    await schema.dropTableIfExists('scoped_users')
    await schema.dropTableIfExists('touch_posts')
    await schema.dropTableIfExists('touch_users')

    // Setup Eager tables
    await schema.createTable('eager_users', table => {
      table.increments('id')
      table.string('name')
    })
    await schema.createTable('eager_posts', table => {
      table.increments('id')
      table.integer('user_id')
      table.string('title')
    })

    // Setup Pivot tables
    await schema.createTable('pivot_users', table => {
      table.increments('id')
      table.string('name')
    })
    await schema.createTable('pivot_roles', table => {
      table.increments('id')
      table.string('name')
    })
    await schema.createTable('user_roles', table => {
      table.integer('user_id')
      table.integer('role_id')
      table.string('meta').nullable()
    })

    // Setup Scoped tables
    await schema.createTable('scoped_users', table => {
      table.increments('id')
      table.string('name')
      table.boolean('active')
    })

    // Setup Touch tables
    await schema.createTable('touch_users', table => {
      table.increments('id')
      table.string('name')
      table.timestamps(true, true)
    })
    await schema.createTable('touch_posts', table => {
      table.increments('id')
      table.integer('user_id')
      table.string('title')
      table.timestamps(true, true)
    })
  })

  afterEach(async () => {
    await DB.close()
  })

  it('supports bulk eager loading (N+1 prevention)', async () => {
    const user1 = await EagerUser.create({ name: 'Alice' })
    const user2 = await EagerUser.create({ name: 'Bob' })

    await EagerPost.create({ user_id: user1.id, title: 'Post A1' })
    await EagerPost.create({ user_id: user1.id, title: 'Post A2' })
    await EagerPost.create({ user_id: user2.id, title: 'Post B1' })

    // Load users with posts
    const users = await EagerUser.with('posts').get()
    expect(users).toHaveLength(2)

    const resolvedUser1 = users.find(u => u.id === user1.id)!
    const resolvedUser2 = users.find(u => u.id === user2.id)!

    expect(resolvedUser1.posts).toHaveLength(2)
    expect(resolvedUser1.posts.map((p: any) => p.title)).toContain('Post A1')
    expect(resolvedUser2.posts).toHaveLength(1)
    expect(resolvedUser2.posts[0].title).toBe('Post B1')
  })

  it('supports eager loading constraints', async () => {
    const user = await EagerUser.create({ name: 'Alice' })
    await EagerPost.create({ user_id: user.id, title: 'Standard Post' })
    await EagerPost.create({ user_id: user.id, title: 'Special Post' })

    // Load with query constraint callback
    const users = await EagerUser.with({
      posts: (q) => q.where('title', 'Special Post')
    }).get()

    expect(users[0].posts).toHaveLength(1)
    expect(users[0].posts[0].title).toBe('Special Post')
  })

  it('supports lazy eager loading', async () => {
    const user = await EagerUser.create({ name: 'Alice' })
    await EagerPost.create({ user_id: user.id, title: 'Lazy Post' })

    // Instantiated model without posts
    const model = await EagerUser.find(user.id)
    expect(typeof (model as any).posts).toBe('function')

    // Lazy load relation on instance
    await model!.load('posts')
    expect((model as any).posts).toHaveLength(1)
    expect((model as any).posts[0].title).toBe('Lazy Post')

    // Lazy load relation on collection
    const models = [await EagerUser.find(user.id)!]
    await EagerUser.load(models as any, 'posts')
    expect(models[0].posts).toHaveLength(1)
  })

  it('handles pivot sync, attach, detach, and toggle operations', async () => {
    const user = await PivotUser.create({ name: 'User A' })
    const role1 = await PivotRole.create({ name: 'Admin' })
    const role2 = await PivotRole.create({ name: 'Editor' })

    // 1. Attach
    await user.roles().attach(role1.id, { meta: 'primary' })
    let userRoles = await user.roles().get()
    expect(userRoles).toHaveLength(1)
    expect(userRoles[0].name).toBe('Admin')
    expect((userRoles[0] as any)._pivot_foreign_id).toBe(user.id)

    // 2. Toggle (detaches role1, attaches role2)
    await user.roles().toggle([role1.id, role2.id])
    userRoles = await user.roles().get()
    expect(userRoles).toHaveLength(1)
    expect(userRoles[0].name).toBe('Editor')

    // 3. Sync (detaches role2, attaches role1)
    await user.roles().sync([role1.id])
    userRoles = await user.roles().get()
    expect(userRoles).toHaveLength(1)
    expect(userRoles[0].name).toBe('Admin')

    // 4. Detach
    await user.roles().detach(role1.id)
    userRoles = await user.roles().get()
    expect(userRoles).toHaveLength(0)
  })

  it('supports global scopes and removing them', async () => {
    // Register active scope
    ScopedUser.addGlobalScope('active', (q) => q.where('active', 1))

    await ScopedUser.create({ name: 'Active User', active: true })
    await ScopedUser.create({ name: 'Inactive User', active: false })

    // Query with global scope active
    let users = await ScopedUser.get()
    expect(users).toHaveLength(1)
    expect(users[0].name).toBe('Active User')

    // Query bypass global scope
    users = await ScopedUser.query().withoutGlobalScope('active').get()
    expect(users).toHaveLength(2)

    // Query bypass all global scopes
    users = await ScopedUser.query().withoutGlobalScopes().get()
    expect(users).toHaveLength(2)
  })

  it('touches parent timestamps on save and delete', async () => {
    const user = await TouchUser.create({ name: 'Parent User' })
    const originalTime = moment((user as any).updated_at)

    // Delay slightly so that moment() is different
    await new Promise(resolve => setTimeout(resolve, 50))

    // Create child post (which triggers touches parent)
    const post = await TouchPost.create({ user_id: user.id, title: 'Child Post' })

    const updatedUser = await TouchUser.find(user.id)
    const updatedTime = moment((updatedUser as any).updated_at)
    expect(updatedTime.isAfter(originalTime)).toBe(true)

    // Delay and delete child (touches parent again)
    await new Promise(resolve => setTimeout(resolve, 50))
    await post.delete()

    const finalUser = await TouchUser.find(user.id)
    expect(moment((finalUser as any).updated_at).isAfter(updatedTime)).toBe(true)
  })
})
