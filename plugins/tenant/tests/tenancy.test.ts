import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { DB } from '@lib/database/DB.js'
import { Storage } from '@lib/storage/Storage.js'
import { Request } from '@lib/http/Request.js'
import { TenantManager, runWithTenant, currentTenant, TenantServiceProvider, TenantMigrateCommand, TenantSeedCommand } from '@plugins/tenant/src/index.js'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('Multi-Tenant Plugin', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let app: Application
  let tempStorageRoot: string

  beforeEach(async () => {
    await DB.close()
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-tenancy-'))
    process.env.MAXIMA_BASE_PATH = tempStorageRoot
    
    app = new Application(tempStorageRoot)
    setApplication(app)

    // Reset TenantManager cache
    TenantManager.reset()

    // Register our TenantServiceProvider
    await app.register(TenantServiceProvider)

    // Set configuration for databases
    app.config.set('database.default', 'sqlite')
    app.config.set('database.connections.sqlite', {
      client: 'sqlite3',
      connection: { filename: path.join(tempStorageRoot, 'central.sqlite') },
      useNullAsDefault: true
    })

    // Set filesystems config
    app.config.set('filesystems.default', 'local')
    app.config.set('filesystems.disks.local', {
      driver: 'local',
      root: path.join(tempStorageRoot, 'storage/app'),
      visibility: 'private'
    })
    app.config.set('filesystems.disks.public', {
      driver: 'local',
      root: path.join(tempStorageRoot, 'storage/app/public'),
      url: 'http://localhost/storage',
      visibility: 'public'
    })
    app.config.set('filesystems.disks.s3', {
      driver: 's3',
      key: 'test',
      secret: 'test',
      region: 'us-east-1',
      bucket: 'test-bucket',
      visibility: 'private'
    })

    // Set default tenancy settings
    app.config.set('tenancy', {
      identification: 'subdomain',
      central_domains: ['localhost', '127.0.0.1'],
      abort_on_fail: true,
      tenants: [
        {
          id: 'tenant-a',
          subdomain: 'tenant-a',
          domain: 'tenant-a.com',
          data: { name: 'Tenant A Co' }
        },
        {
          id: 'tenant-b',
          subdomain: 'tenant-b',
          domain: 'tenant-b.com',
          database: {
            client: 'sqlite3',
            connection: { filename: path.join(tempStorageRoot, 'tenant-b-custom.sqlite') }
          },
          storage: {
            disks: {
              local: {
                driver: 'local',
                root: path.join(tempStorageRoot, 'custom-storage-b')
              }
            }
          },
          data: { name: 'Tenant B Co' }
        }
      ]
    })
  })

  afterEach(async () => {
    await DB.close()
    if (originalBasePath) {
      process.env.MAXIMA_BASE_PATH = originalBasePath
    } else {
      delete process.env.MAXIMA_BASE_PATH
    }
    await fs.rm(tempStorageRoot, { recursive: true, force: true })
  })

  it('resolves tenants by subdomain, domain, header and cookie', async () => {
    // 1. Subdomain resolution
    const mockRequest1 = {
      hostname: () => 'tenant-a.localhost:3000',
      header: () => undefined,
      cookies: () => ({})
    } as unknown as Request
    
    let tenant = await TenantManager.resolveFromRequest(mockRequest1)
    expect(tenant).toBeDefined()
    expect(tenant?.id).toBe('tenant-a')
    expect(tenant?.get('name')).toBe('Tenant A Co')

    // 2. Domain resolution
    app.config.set('tenancy.identification', 'domain')
    const mockRequest2 = {
      hostname: () => 'tenant-b.com',
      header: () => undefined,
      cookies: () => ({})
    } as unknown as Request
    
    tenant = await TenantManager.resolveFromRequest(mockRequest2)
    expect(tenant).toBeDefined()
    expect(tenant?.id).toBe('tenant-b')

    // 3. Header resolution
    app.config.set('tenancy.identification', 'header')
    const mockRequest3 = {
      hostname: () => 'localhost',
      header: (name: string) => name === 'x-tenant-id' ? 'tenant-a' : undefined,
      cookies: () => ({})
    } as unknown as Request
    
    tenant = await TenantManager.resolveFromRequest(mockRequest3)
    expect(tenant).toBeDefined()
    expect(tenant?.id).toBe('tenant-a')

    // 4. Cookie resolution
    app.config.set('tenancy.identification', 'cookie')
    const mockRequest4 = {
      hostname: () => 'localhost',
      header: () => undefined,
      cookies: () => ({ tenant_id: 'tenant-b' })
    } as unknown as Request
    
    tenant = await TenantManager.resolveFromRequest(mockRequest4)
    expect(tenant).toBeDefined()
    expect(tenant?.id).toBe('tenant-b')
  })

  it('scopes execution context to the resolved tenant', async () => {
    const tenant = await TenantManager.resolveById('tenant-a')
    expect(tenant).toBeDefined()

    await runWithTenant(tenant!, async () => {
      expect(currentTenant()).toBeDefined()
      expect(currentTenant()?.id).toBe('tenant-a')
    })

    expect(currentTenant()).toBeUndefined()
  })

  it('dynamically switches database connection and isolates schema/data', async () => {
    const tenantA = await TenantManager.resolveById('tenant-a')
    const tenantB = await TenantManager.resolveById('tenant-b')

    // Create tables and verify isolation
    await runWithTenant(tenantA!, async () => {
      const conn = DB.connection()
      await conn.schema.createTable('users', table => {
        table.increments('id')
        table.string('name')
      })
      await DB.table('users').insert({ name: 'User in A' })
      
      // Verify database file is created inside tenant storage
      const tenantADbFile = path.join(tempStorageRoot, 'storage', 'tenants', 'tenant-a', 'database.sqlite')
      expect(fsSync.existsSync(tenantADbFile)).toBe(true)
    })

    await runWithTenant(tenantB!, async () => {
      const conn = DB.connection()
      await conn.schema.createTable('users', table => {
        table.increments('id')
        table.string('name')
      })
      await DB.table('users').insert({ name: 'User in B' })

      // Tenant B has overridden DB filename
      const tenantBDbFile = path.join(tempStorageRoot, 'tenant-b-custom.sqlite')
      expect(fsSync.existsSync(tenantBDbFile)).toBe(true)
    })

    // Verify independent queries
    await runWithTenant(tenantA!, async () => {
      const users = await DB.table('users').select()
      expect(users.length).toBe(1)
      expect(users[0].name).toBe('User in A')
    })

    await runWithTenant(tenantB!, async () => {
      const users = await DB.table('users').select()
      expect(users.length).toBe(1)
      expect(users[0].name).toBe('User in B')
    })
  })

  it('dynamically switches and scopes storage/filesystems', async () => {
    const tenantA = await TenantManager.resolveById('tenant-a')
    const tenantB = await TenantManager.resolveById('tenant-b')

    // Test local disk writing
    await runWithTenant(tenantA!, async () => {
      console.log('DISK LOCAL ROOT:', Storage.disk('local').path(''))
      console.log('DISK LOCAL TEST FILE:', Storage.disk('local').path('test.txt'))
      await Storage.disk('local').put('test.txt', 'tenant A file')
      const filePath = path.join(tempStorageRoot, 'storage', 'tenants', 'tenant-a', 'app', 'test.txt')
      expect(fsSync.existsSync(filePath)).toBe(true)
      expect(await fs.readFile(filePath, 'utf8')).toBe('tenant A file')

      // Check public URL
      const publicUrl = Storage.disk('public').url('image.png')
      expect(publicUrl).toBe('http://localhost/storage/tenants/tenant-a/image.png')
    })

    await runWithTenant(tenantB!, async () => {
      console.log('DISK LOCAL ROOT B:', Storage.disk('local').path(''))
      console.log('DISK LOCAL TEST FILE B:', Storage.disk('local').path('test.txt'))
      // Tenant B has overridden storage root
      await Storage.disk('local').put('test.txt', 'tenant B file')
      const filePath = path.join(tempStorageRoot, 'custom-storage-b', 'test.txt')
      expect(fsSync.existsSync(filePath)).toBe(true)
      expect(await fs.readFile(filePath, 'utf8')).toBe('tenant B file')
    })

    // Test remote driver (s3) wrapping with ScopedDisk
    await runWithTenant(tenantA!, async () => {
      const diskConfig = app.config.get('filesystems.disks.tenant_tenant-a_s3') as any
      expect(diskConfig).toBeDefined()
      expect(diskConfig.driver).toBe('scoped')
      expect(diskConfig.disk).toBe('s3')
      expect(diskConfig.prefix).toBe('tenants/tenant-a')
    })
  })

  it('runs tenant database migrations and seeds', async () => {
    // 1. Create a migration file
    const migrationsDir = path.join(tempStorageRoot, 'database', 'migrations')
    await fs.mkdir(migrationsDir, { recursive: true })
    const migrationFile = path.join(migrationsDir, '20260531120000_create_posts_table.ts')
    await fs.writeFile(migrationFile, `
export async function up(knex) {
  await knex.schema.createTable('posts', table => {
    table.increments('id')
    table.string('title')
  })
}
export async function down(knex) {
  await knex.schema.dropTable('posts')
}
`)

    // 2. Create a seeder file
    const seedersDir = path.join(tempStorageRoot, 'database', 'seeders')
    await fs.mkdir(seedersDir, { recursive: true })
    const seederFile = path.join(seedersDir, 'posts_seeder.ts')
    await fs.writeFile(seederFile, `
export async function seed(knex) {
  await knex('posts').insert({ title: 'Seed Post' })
}
`)

    // 3. Run TenantMigrateCommand
    const migrateCmd = new TenantMigrateCommand()
    await migrateCmd.handle({ path: migrationsDir })

    // Verify migrations ran on both tenant databases
    const tenantA = await TenantManager.resolveById('tenant-a')
    const tenantB = await TenantManager.resolveById('tenant-b')

    await runWithTenant(tenantA!, async () => {
      expect(await DB.connection().schema.hasTable('posts')).toBe(true)
    })
    await runWithTenant(tenantB!, async () => {
      expect(await DB.connection().schema.hasTable('posts')).toBe(true)
    })

    // 4. Run TenantSeedCommand
    const seedCmd = new TenantSeedCommand()
    await seedCmd.handle({ class: 'posts_seeder' })

    // Verify seeds were inserted into both databases
    await runWithTenant(tenantA!, async () => {
      const posts = await DB.table('posts').select()
      expect(posts.length).toBe(1)
      expect(posts[0].title).toBe('Seed Post')
    })
    await runWithTenant(tenantB!, async () => {
      const posts = await DB.table('posts').select()
      expect(posts.length).toBe(1)
      expect(posts[0].title).toBe('Seed Post')
    })
  })
})
