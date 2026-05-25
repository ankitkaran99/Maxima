import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { setApplication } from '@lib/foundation/helpers.js'
import { Storage } from '@lib/storage/Storage.js'

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

describe('Storage', () => {
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
