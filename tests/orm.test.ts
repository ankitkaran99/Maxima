import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import moment from 'moment'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Factory, FactoryRegistry } from '@lib/database/Factory.js'
import { Model } from '@lib/database/Model.js'
import { SerializableModelRegistry } from '@lib/database/SerializableModelRegistry.js'

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

describe('ORM Layer', () => {
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
