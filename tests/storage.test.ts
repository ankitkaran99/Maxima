import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { HttpKernel } from '@lib/http/Kernel.js'
import { Response } from '@lib/http/Response.js'
import { Route } from '@lib/http/Route.js'
import { Storage } from '@lib/storage/Storage.js'

describe('Storage Core', () => {
  beforeEach(() => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('filesystems.default', 'local')
    app.config.set('filesystems.disks.ftp', {
      driver: 'ftp',
      host: 'ftp.example.com',
      port: 21,
      root: 'remote'
    })
    app.config.set('filesystems.disks.ssh', {
      driver: 'ssh',
      host: 'sftp.example.com',
      port: 22,
      root: 'remote'
    })
    app.config.set('filesystems.disks.s3', {
      driver: 's3',
      bucket: 'maxima-test',
      region: 'us-east-1',
      key: 'key',
      secret: 'secret'
    })
    Storage.restore()
  })

  afterEach(() => {
    Storage.restore()
  })

  it('can fake disks', async () => {
    Storage.fake('public')
    await Storage.put('avatars/1.txt', 'ok')
    expect(await Storage.exists('avatars/1.txt')).toBe(true)
  })

  it('resolves ftp, ssh, and s3 adapters', async () => {
    expect(Storage.disk('ftp').url('avatars/1.txt')).toBe('ftp://ftp.example.com:21/remote/avatars/1.txt')
    expect(Storage.disk('ssh').url('avatars/1.txt')).toBe('sftp://sftp.example.com:22/remote/avatars/1.txt')

    const s3 = Storage.disk('s3')
    expect(s3.url('avatars/1.txt')).toBe('https://maxima-test.s3.us-east-1.amazonaws.com/avatars/1.txt')
    await expect(s3.temporaryUrl('avatars/1.txt', new Date(Date.now() + 60_000))).resolves.toContain('X-Amz-Signature')
  })
})

describe('Storage Parity', () => {
  let root = ''
  let app: Application

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-storage-parity-'))
    app = new Application(root)
    setApplication(app)
    app.config.set('middleware.global', [])
    app.config.set('security.helmet', false)
    app.config.set('filesystems.default', 'local')
    app.config.set('filesystems.cloud', 'memory')
    app.config.set('filesystems.disks.local', {
      driver: 'local',
      root: path.join(root, 'storage', 'app'),
      url: 'https://cdn.example.com/storage',
      visibility: 'private',
      throw: true
    })
    app.config.set('filesystems.disks.quiet', {
      driver: 'local',
      root: path.join(root, 'storage', 'quiet'),
      throw: false
    })
    app.config.set('filesystems.disks.scoped', {
      driver: 'scoped',
      disk: 'local',
      prefix: 'tenant-a'
    })
    app.config.set('filesystems.disks.readonly', {
      driver: 'scoped',
      disk: 'local',
      prefix: 'readonly',
      readOnly: true
    })
    app.config.set('filesystems.disks.memory', { driver: 'memory' })
    Storage.restore()
  })

  afterEach(async () => {
    Route.clear()
    Storage.restore()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('supports scoped and read-only disks', async () => {
    await Storage.disk('scoped').put('docs/a.txt', 'scoped')

    expect(await Storage.disk('local').exists('tenant-a/docs/a.txt')).toBe(true)
    expect(await Storage.disk('scoped').get('docs/a.txt')).toEqual(Buffer.from('scoped'))
    await expect(Storage.disk('readonly').put('blocked.txt', 'nope')).rejects.toThrow('read-only')
  })

  it('supports throw semantics, recursive listings, checksums, bulk helpers, and temporary upload URLs', async () => {
    await Storage.put('reports/2026/jan.txt', 'jan')
    await Storage.put('reports/2026/feb.txt', 'feb')
    await Storage.makeDirectory('reports/archive')

    expect(await Storage.existsAll(['reports/2026/jan.txt', 'reports/2026/feb.txt'])).toBe(true)
    expect(await Storage.existsAny(['missing.txt', 'reports/2026/feb.txt'])).toBe(true)
    expect(await Storage.missingAny(['missing.txt', 'reports/2026/feb.txt'])).toBe(true)
    expect(await Storage.files('reports')).toEqual([])
    expect((await Storage.allFiles('reports')).sort()).toEqual(['reports/2026/feb.txt', 'reports/2026/jan.txt'])
    expect((await Storage.allDirectories('reports')).sort()).toEqual(['reports/2026', 'reports/archive'])
    expect(await Storage.checksum('reports/2026/jan.txt')).toBe('fa27ef3ef6570e32a79e74deca7c1bc3')

    const upload = await Storage.temporaryUploadUrl('uploads/incoming.txt', new Date(Date.now() + 60_000))
    expect(upload.url).toContain('signature=')
    expect(upload.headers).toEqual({})

    await expect(Storage.get('missing.txt')).rejects.toThrow()
    await expect(Storage.disk('quiet').get('missing.txt')).resolves.toEqual(Buffer.alloc(0))
  })

  it('builds on-demand disks and resolves the cloud disk', async () => {
    const disk = Storage.build({ driver: 'local', root: path.join(root, 'ondemand'), url: 'https://files.example.com' })
    await disk.put('one.txt', '1')

    expect(disk.url('one.txt')).toBe('https://files.example.com/one.txt')

    await Storage.cloud().put('cloud.txt', 'cloud')
    expect(await Storage.disk('memory').exists('cloud.txt')).toBe(true)
  })

  it('has richer fake assertions', async () => {
    Storage.fake('local')
    await Storage.put('avatars/one.txt', '1')
    await Storage.put('avatars/two.txt', '2')

    await expect(Storage.assertExists(['avatars/one.txt', 'avatars/two.txt'])).resolves.toBeUndefined()
    await expect(Storage.assertMissing('avatars/missing.txt')).resolves.toBeUndefined()
    await expect(Storage.assertCount('avatars', 2)).resolves.toBeUndefined()
    await expect(Storage.assertDirectoryEmpty('empty')).resolves.toBeUndefined()
  })

  it('integrates disk responses with HTTP responses', async () => {
    await Storage.put('public/report.txt', 'download me')
    Route.get('/storage-file', (_request, response: Response) => response.storage('public/report.txt'))
    Route.get('/storage-download', (_request, response: Response) => response.storageDownload('public/report.txt', undefined, 'report.txt'))

    const kernel = new HttpKernel(app)
    await kernel.bootstrap({ loadRoutes: false })

    const inline = await kernel.server.inject({ method: 'GET', url: '/storage-file' })
    const download = await kernel.server.inject({ method: 'GET', url: '/storage-download' })
    await kernel.close()

    expect(inline.body).toBe('download me')
    expect(inline.headers['content-disposition']).toContain('inline')
    expect(download.headers['content-disposition']).toContain('attachment')
  })
})
