import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import moment from 'moment'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Schema } from '@lib/database/Schema.js'
import { Model } from '@lib/database/Model.js'
import { SerializableModelRegistry } from '@lib/database/SerializableModelRegistry.js'
import { Factory, FactoryRegistry } from '@lib/database/Factory.js'

// ============================================================================
// ORM Layer Models (from orm.test.ts)
// ============================================================================
class User extends Model {
  static table = 'users'
  static fillable = ['name', 'email', 'active', 'settings']
  static hidden = ['email']
  static casts = { active: 'boolean', settings: 'json' } as const
  declare id: number
  declare name: string
  declare email: string
  declare active: boolean
  declare settings: Record<string, unknown>

  posts() {
    return this.hasMany(Post)
  }

  static scopeNamed(query, name: string) {
    return query.where('name', name)
  }
}

class Post extends Model {
  static table = 'posts'
  static fillable = ['user_id', 'title', 'views']
  declare id: number
  declare user_id: number
  declare title: string
  declare views: number

  user() {
    return this.belongsTo(User)
  }

  defaultUser() {
    return this.belongsTo(User, 'user_id').withDefault({ name: 'Guest' })
  }
}

class Role extends Model {
  static table = 'roles'
  static fillable = ['name']
  declare id: number
  declare name: string
}

class SoftPost extends Model {
  static table = 'soft_posts'
  static fillable = ['title']
  static softDeletes = true
  declare id: number
  declare title: string
}

class Event extends Model {
  static table = 'events'
  static fillable = ['name', 'starts_at']
  static casts = { starts_at: 'date' } as const
  declare id: number
  declare name: string
  declare starts_at: moment.Moment
  declare created_at: moment.Moment
  declare updated_at: moment.Moment
}

class UserFactory extends Factory<typeof User> {
  model = User

  definition() {
    return { name: 'Factory User', email: 'factory@example.com', active: true }
  }
}
FactoryRegistry.register(User, UserFactory)

// ============================================================================
// ORM & Database Extras Models (from database-extras.test.ts)
// ============================================================================
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

class ScopedUser extends Model {
  static table = 'scoped_users'
  static fillable = ['name', 'active']
  static timestamps = false
  declare id: number
  declare name: string
  declare active: boolean
}

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

SerializableModelRegistry.register(EagerUser, 'EagerUser')
SerializableModelRegistry.register(EagerPost, 'EagerPost')
SerializableModelRegistry.register(PivotUser, 'PivotUser')
SerializableModelRegistry.register(PivotRole, 'PivotRole')
SerializableModelRegistry.register(ScopedUser, 'ScopedUser')
SerializableModelRegistry.register(TouchUser, 'TouchUser')
SerializableModelRegistry.register(TouchPost, 'TouchPost')

// ============================================================================
// Custom Casts Models (from custom-casts.test.ts)
// ============================================================================
class UpperCast {
  get(model: any, key: string, value: any) {
    return String(value).toUpperCase()
  }
  set(model: any, key: string, value: any) {
    return String(value).toLowerCase()
  }
}

class TestModel extends Model {
  static casts = {
    code: UpperCast
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('Database Layer', () => {
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
    await DB.connection().schema.createTable('items', table => {
      table.increments('id')
      table.string('name')
    })
  })

  afterEach(async () => {
    DB.disableQueryLog()
    DB.flushQueryLog()
    await DB.close()
  })

  it('resolves configured connections and table builders', async () => {
    await DB.table('items').insert({ name: 'first' })

    const item = await DB.connection()('items').where('name', 'first').first()

    expect(item).toMatchObject({ id: 1, name: 'first' })
  })

  it('commits successful transactions', async () => {
    await DB.transaction(async trx => {
      await trx('items').insert({ name: 'committed' })
    })

    await expect(DB.table('items').where('name', 'committed').first()).resolves.toMatchObject({
      name: 'committed'
    })
  })

  it('rolls back failed transactions', async () => {
    await expect(DB.transaction(async trx => {
      await trx('items').insert({ name: 'rolled-back' })
      throw new Error('rollback')
    })).rejects.toThrow('rollback')

    await expect(DB.table('items').where('name', 'rolled-back').first()).resolves.toBeUndefined()
  })

  it('throws for missing configured connections', () => {
    expect(() => DB.connection('missing')).toThrow('Database connection [missing] is not configured.')
  })

  it('supports Laravel-style query builder helpers', async () => {
    await DB.table('items').insert([{ name: 'first' }, { name: 'second' }, { name: 'third' }])

    const value = await DB.table('items').where('name', 'first').value('name')
    const plucked = await DB.table('items').orderBy('id').pluck('name')
    const keyed = await DB.table('items').pluck('name', 'id')
    const chunks: string[][] = []
    await DB.table('items').orderBy('id').chunk(2, rows => { chunks.push(rows.map(row => row.name)) })

    const conditional = await DB.table('items')
      .when(true, query => query.where('name', 'second'))
      .first()

    const cursorValues: string[] = []
    for await (const row of DB.table('items').where('id', '<', 3).cursor()) {
      cursorValues.push(row.name)
    }

    expect(value).toBe('first')
    expect(plucked).toEqual(['first', 'second', 'third'])
    expect(keyed[1]).toBe('first')
    expect(chunks).toEqual([['first', 'second'], ['third']])
    expect(conditional.name).toBe('second')
    expect(cursorValues).toEqual(['first', 'second'])
  })

  it('supports query logging, listeners, and afterCommit callbacks', async () => {
    const queries: string[] = []
    const committed: string[] = []
    const unsubscribe = DB.listen(query => queries.push(query.sql))
    DB.enableQueryLog()

    await DB.transaction(async trx => {
      DB.afterCommit(() => { committed.push('committed') })
      await trx('items').insert({ name: 'logged' })
    })

    unsubscribe()
    expect(queries.some(sql => sql.includes('insert'))).toBe(true)
    expect(DB.getQueryLog().some(query => query.sql.includes('insert'))).toBe(true)
    expect(committed).toEqual(['committed'])
  })

  it('isolates afterCommit callbacks and transaction events concurrently', async () => {
    const listA: string[] = []
    const listB: string[] = []

    const p1 = DB.transaction(async trx => {
      DB.afterCommit(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
        listA.push('A_committed')
      })
      await trx('items').insert({ name: 'A' })
    })

    const p2 = DB.transaction(async trx => {
      DB.afterCommit(async () => {
        listB.push('B_committed')
      })
      await trx('items').insert({ name: 'B' })
    })

    await Promise.all([p1, p2])

    expect(listA).toEqual(['A_committed'])
    expect(listB).toEqual(['B_committed'])
  })

  it('supports schema rename/drop helpers and framework table helpers', async () => {
    await Schema.rename('items', 'renamed_items')
    await Schema.renameColumn('renamed_items', 'name', 'title')
    await Schema.dropColumns('renamed_items', 'title')
    await Schema.createCacheTable('cache_entries')
    await Schema.createSessionTable('session_entries')
    await Schema.createQueueTables('queued_jobs', 'failed_queued_jobs')

    expect(await Schema.hasTable('renamed_items')).toBe(true)
    expect(await Schema.hasColumn('renamed_items', 'title')).toBe(false)
    expect(await Schema.hasTable('cache_entries')).toBe(true)
    expect(await Schema.hasTable('session_entries')).toBe(true)
    expect(await Schema.hasTable('queued_jobs')).toBe(true)
    expect(await Schema.hasTable('failed_queued_jobs')).toBe(true)
  })
})

describe('ORM Layer', () => {
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
    await schema.dropTableIfExists('role_user')
    await schema.dropTableIfExists('soft_posts')
    await schema.dropTableIfExists('roles')
    await schema.dropTableIfExists('posts')
    await schema.dropTableIfExists('users')
    await schema.createTable('users', table => {
      table.increments('id')
      table.string('name')
      table.string('email')
      table.boolean('active')
      table.text('settings')
      table.timestamps()
    })
    await schema.createTable('posts', table => {
      table.increments('id')
      table.integer('user_id')
      table.string('title')
      table.integer('views')
      table.timestamps()
    })
    await schema.createTable('roles', table => {
      table.increments('id')
      table.string('name')
      table.timestamps()
    })
    await schema.createTable('role_user', table => {
      table.integer('user_id')
      table.integer('role_id')
    })
    await schema.createTable('soft_posts', table => {
      table.increments('id')
      table.string('title')
      table.timestamp('deleted_at')
      table.timestamps()
    })
    await schema.createTable('events', table => {
      table.increments('id')
      table.string('name')
      table.timestamp('starts_at')
      table.timestamps()
    })
  })

  afterEach(async () => {
    await DB.close()
  })

  it('creates, finds, updates, deletes, and casts models', async () => {
    const user = await User.create({
      name: 'Ada',
      email: 'ada@example.com',
      active: 1,
      settings: '{"theme":"dark"}',
      ignored: 'nope'
    })

    expect(user.id).toBe(1)
    expect(user.active).toBe(true)
    expect(user.settings).toEqual({ theme: 'dark' })
    expect((user as any).ignored).toBeUndefined()

    const found = await User.findOrFail(user.id)
    expect(found.exists).toBe(true)
    expect(found.id).toBe(1)

    await found.update({ name: 'Ada Lovelace' })
    expect((await User.find(user.id))?.name).toBe('Ada Lovelace')

    await found.delete()
    expect(await User.find(user.id)).toBeNull()
  })

  it('serializes hidden and visible attributes', async () => {
    const user = await User.create({ name: 'Grace', email: 'grace@example.com' })

    expect(user.toJSON()).not.toHaveProperty('email')

    class VisibleUser extends User {
      static visible = ['name']
    }

    const visible = VisibleUser.hydrate(user.attributes())
    expect(visible.toJSON()).toEqual({ name: 'Grace' })
  })

  it('queries with where, first, get, and paginate', async () => {
    await User.create({ name: 'A', email: 'a@example.com' })
    await User.create({ name: 'B', email: 'b@example.com' })

    expect(((await User.where('name', 'A').first()) as User | null)?.email).toBe('a@example.com')
    expect(await User.where('name', 'like', '%').get()).toHaveLength(2)

    const page = await User.paginate(1, 1)
    expect(page.total).toBe(2)
    expect(page.data).toHaveLength(1)

    expect(((await User.scope('named', 'B').first()) as User | null)?.email).toBe('b@example.com')
  })

  it('applies accessors and mutators', () => {
    class Person extends Model {
      static fillable = ['name']
      static mutators = {
        name: (value: string) => value.trim()
      }
      static accessors = {
        name: (value: string) => value.toUpperCase()
      }
      declare name: string
    }

    const person = new Person({ name: '  ada  ' })

    expect(person.name).toBe('ada')
    expect(person.attributes()).toEqual({ name: 'ADA' })
  })

  it('loads hasMany, belongsTo, belongsToMany, and eager relationships', async () => {
    const user = await User.create({ name: 'Taylor', email: 'taylor@example.com' })
    const post = await Post.create({ user_id: user.id, title: 'First' })
    const role = await Role.create({ name: 'admin' })
    await DB.table('role_user').insert({ user_id: user.id, role_id: role.id })

    expect(await user.posts().get()).toHaveLength(1)
    expect(((await post.user().first()) as User | null)?.name).toBe('Taylor')
    expect(await user.belongsToMany(Role, 'role_user', 'user_id', 'role_id').get()).toHaveLength(1)

    const loaded = await User.with('posts').find(user.id)
    expect(loaded?.posts).toHaveLength(1)
  })

  it('supports soft deletes and model events', async () => {
    const events: string[] = []
    class EventPost extends SoftPost {}
    EventPost.on('creating', () => { events.push('creating') })
    EventPost.on('created', () => { events.push('created') })
    EventPost.on('deleted', () => { events.push('deleted') })

    const post = await EventPost.create({ title: 'Soft' })
    await post.delete()

    expect(events).toEqual(expect.arrayContaining(['creating', 'created', 'deleted']))
    expect(await EventPost.find(post.id)).toBeNull()
    expect(await DB.table('soft_posts').where('id', post.id).first()).toHaveProperty('deleted_at')
  })

  it('supports advanced soft delete queries and restore', async () => {
    const post = await SoftPost.create({ title: 'A' })
    await post.delete()

    expect(await SoftPost.find(post.id)).toBeNull()
    
    const withTrashed = await SoftPost.query().withTrashed().where('id', post.id).first()
    expect(withTrashed?.id).toBe(post.id)

    const onlyTrashed = await SoftPost.query().onlyTrashed().where('id', post.id).first()
    expect(onlyTrashed?.id).toBe(post.id)

    await withTrashed?.restore()
    expect(await SoftPost.find(post.id)).not.toBeNull()
  })

  it('supports advanced factory features like count, state, and magic model.factory() helper', async () => {
    // Test magic factory lookup
    const user = await User.factory().create({ name: 'Taylor' })
    expect(user.name).toBe('Taylor')
    expect(user.exists).toBe(true)

    // Test factory count
    const users = await User.factory(3).create()
    expect(users).toHaveLength(3)
    expect(users[0].exists).toBe(true)

    // Test factory state
    const inactiveFactory = new UserFactory().state({ active: false })
    const inactiveUser = await inactiveFactory.create()
    expect(inactiveUser.active).toBe(false)
  })

  it('supports factories and serializable model registry', async () => {
    const factory = new UserFactory()
    const made = factory.make({ name: 'Made' })
    const created = await factory.create({ name: 'Created' })

    SerializableModelRegistry.register(User, 'UserModel')

    expect(made.exists).toBe(false)
    expect(created.exists).toBe(true)
    expect(SerializableModelRegistry.resolve('UserModel')).toBe(User)
  })

  it('casts date attributes with moment and persists timestamps', async () => {
    const event = await Event.create({ name: 'Launch', starts_at: '2026-05-23T10:00:00Z' })

    expect(moment.isMoment(event.starts_at)).toBe(true)
    expect(event.starts_at.toISOString()).toBe('2026-05-23T10:00:00.000Z')
    expect(moment.isMoment(event.created_at)).toBe(true)
    expect(moment.isMoment(event.updated_at)).toBe(true)
  })

  it('supports richer model lifecycle and persistence helpers', async () => {
    class ApiUser extends User {
      static routeKeyName = 'email'
      static appends = ['label']
      static accessors = {
        label: (_value: any, model: User) => `${model.name}<${model.email}>`
      }
    }

    const created = await User.firstOrCreate({ email: 'new@example.com' }, { name: 'New', active: true })
    const existing = await User.updateOrCreate({ email: 'new@example.com' }, { name: 'Updated' })
    const fresh = await created.fresh()

    expect(existing.id).toBe(created.id)
    expect(fresh?.name).toBe('Updated')

    existing.name = 'Dirty'
    expect(existing.isDirty('name')).toBe(true)
    await existing.save()
    expect(existing.wasChanged('name')).toBe(true)
    expect(existing.getChanges()).toHaveProperty('name', 'Dirty')

    const replicated = existing.replicate()
    expect(replicated.exists).toBe(false)
    expect(replicated.id).toBeUndefined()

    await existing.refresh()
    expect(existing.name).toBe('Dirty')

    const firstOrNew = await User.firstOrNew({ email: 'unsaved@example.com' }, { name: 'Unsaved' })
    expect(firstOrNew.exists).toBe(false)

    const ids = (await User.findMany([created.id])).modelKeys()
    expect(ids).toEqual([created.id])

    await expect(User.where('email', 'missing@example.com').firstOrFail()).rejects.toThrow('User was not found')
    await expect(User.where('email', 'new@example.com').sole()).resolves.toHaveProperty('id', created.id)

    const apiUser = ApiUser.hydrate(existing.attributes())
    expect(apiUser.getRouteKey()).toBe('new@example.com')
    expect(apiUser.toJSON()).toHaveProperty('label', 'Dirty<new@example.com>')
    expect(Model.newUniqueId()).toMatch(/^[0-9a-f-]{36}$/)
    expect(Model.newUlid()).toHaveLength(26)

    const events: string[] = []
    class QuietUser extends User {}
    QuietUser.on('created', () => { events.push('created') })
    await QuietUser.withoutEvents(() => QuietUser.create({ name: 'Quiet', email: 'quiet@example.com' }))
    expect(events).toEqual([])
  })

  it('supports relationship query helpers and one-of-many relationships', async () => {
    const ada = await User.create({ name: 'Ada', email: 'ada@example.com' })
    const grace = await User.create({ name: 'Grace', email: 'grace@example.com' })
    await Post.create({ user_id: ada.id, title: 'Low', views: 2 })
    await Post.create({ user_id: ada.id, title: 'High', views: 7 })

    const withPosts = await User.query().whereHas('posts').get()
    expect(withPosts.modelKeys()).toEqual([ada.id])
    expect(await User.query().doesntHave('posts').first()).toHaveProperty('id', grace.id)
    expect(await User.query().whereRelation('posts', 'title', 'High').first()).toHaveProperty('id', ada.id)

    const aggregated = await User.query().where('id', ada.id).withCount('posts').withExists('posts').withSum('posts', 'views').withAggregate('posts', 'views', 'max').firstOrFail()
    expect((aggregated as any).posts_count).toBe(2)
    expect((aggregated as any).posts_exists).toBe(true)
    expect((aggregated as any).posts_sum_views).toBe(9)
    expect((aggregated as any).posts_max_views).toBe(7)

    const latest = await ada.hasMany(Post).latestOfMany('views').first()
    const oldest = await ada.hasMany(Post).oldestOfMany('views').first()
    expect(latest?.title).toBe('High')
    expect(oldest?.title).toBe('Low')

    const orphan = new Post({ title: 'Orphan' })
    expect((await orphan.defaultUser().first())?.name).toBe('Guest')
  })

  it('supports model-aware collections', async () => {
    const one = await User.create({ name: 'One', email: 'one@example.com' })
    const two = await User.create({ name: 'Two', email: 'two@example.com' })
    await Post.create({ user_id: one.id, title: 'Post', views: 1 })

    const users = await User.get()
    expect(users.modelKeys()).toEqual([one.id, two.id])
    await users.loadMissing('posts')
    expect(users[0].posts).toHaveLength(1)

    const [matched, unmatched] = users.partition(user => user.name === 'One')
    expect(matched.modelKeys()).toEqual([one.id])
    expect(unmatched.modelKeys()).toEqual([two.id])

    expect(await users.only([one.id]).toQuery().first()).toHaveProperty('id', one.id)
    expect(await users.except([one.id]).fresh()).toHaveLength(1)

    class VisibleCollectionUser extends User {}
    const visibleUsers = new VisibleCollectionUser.collection([VisibleCollectionUser.hydrate(one.attributes())])
    expect(visibleUsers.makeVisible('email')[0].toJSON()).toHaveProperty('email')
    expect(visibleUsers.makeHidden('name')[0].toJSON()).not.toHaveProperty('name')
  })

  it('supports array, object, formatted date, and encrypted casts', async () => {
    class CastUser extends Model {
      static table = 'users'
      static fillable = ['name', 'email', 'settings']
      static casts = { settings: 'array', email: 'encrypted', created_at: 'date:YYYY-MM-DD' } as const
    }

    const user = await CastUser.create({ name: 'Cast', email: 'secret@example.com', settings: ['a', 'b'] })
    const raw = await DB.table('users').where('id', user.id).first()
    expect(raw.email).not.toBe('secret@example.com')

    const found = await CastUser.findOrFail(user.id)
    expect(found.email).toBe('secret@example.com')
    expect(found.settings).toEqual(['a', 'b'])
    expect(moment.isMoment(found.created_at)).toBe(true)
  })
})

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

describe('Custom Model Casts', () => {
  it('runs custom getter and setter casts', () => {
    // Getter cast on hydration/instantiation
    const model = new TestModel({ code: 'abc' })
    expect((model as any).code).toBe('ABC')

    // Setter cast on serialization
    const persistable = model.persistableAttributes()
    expect(persistable.code).toBe('abc')
  })
})
