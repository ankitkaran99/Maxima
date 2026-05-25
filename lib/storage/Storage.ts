import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { lookup } from 'mime-types'
import { config } from '@lib/foundation/helpers.js'
import { FtpDisk, S3Disk, SftpDisk } from '@lib/storage/Drivers.js'

export type Visibility = 'public' | 'private'

export interface Disk {
  put(path: string, contents: any, options?: Record<string, any>): Promise<void>
  get(path: string): Promise<Buffer>
  exists(path: string): Promise<boolean>
  delete(path: string): Promise<void>
  copy(from: string, to: string): Promise<void>
  move(from: string, to: string): Promise<void>
  size(path: string): Promise<number>
  lastModified(path: string): Promise<Date>
  mimeType(path: string): Promise<string | false>
  files(path?: string): Promise<string[]>
  directories(path?: string): Promise<string[]>
  makeDirectory(path: string): Promise<void>
  deleteDirectory(path: string): Promise<void>
  url(path: string): string
  temporaryUrl(path: string, expiresAt: Date): string | Promise<string>
  readStream(path: string): NodeJS.ReadableStream | Promise<NodeJS.ReadableStream>
  writeStream(path: string, stream: NodeJS.ReadableStream): Promise<void>
  setVisibility(path: string, visibility: Visibility): Promise<void>
  getVisibility(path: string): Promise<Visibility>
}

export class LocalDisk implements Disk {
  constructor(private options: { root: string, url?: string, visibility?: Visibility }) {}

  async put(file: string, contents: any) { await fs.mkdir(path.dirname(this.resolve(file)), { recursive: true }); await fs.writeFile(this.resolve(file), contents) }
  async get(file: string) { return fs.readFile(this.resolve(file)) }
  async exists(file: string) { return fs.access(this.resolve(file)).then(() => true).catch(() => false) }
  async delete(file: string) { await fs.rm(this.resolve(file), { force: true }) }
  async copy(from: string, to: string) { await fs.mkdir(path.dirname(this.resolve(to)), { recursive: true }); await fs.copyFile(this.resolve(from), this.resolve(to)) }
  async move(from: string, to: string) { await this.copy(from, to); await this.delete(from) }
  async size(file: string) { return (await fs.stat(this.resolve(file))).size }
  async lastModified(file: string) { return (await fs.stat(this.resolve(file))).mtime }
  async mimeType(file: string) { return lookup(file) }
  async files(directory = '') { return (await fs.readdir(this.resolve(directory), { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.posix.join(directory, entry.name)) }
  async directories(directory = '') { return (await fs.readdir(this.resolve(directory), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.posix.join(directory, entry.name)) }
  async makeDirectory(directory: string) { await fs.mkdir(this.resolve(directory), { recursive: true }) }
  async deleteDirectory(directory: string) { await fs.rm(this.resolve(directory), { recursive: true, force: true }) }
  url(file: string) { return `${this.options.url ?? ''}/${normalize(file)}` }
  temporaryUrl(file: string, expiresAt: Date) { return `${this.url(file)}?expires=${expiresAt.getTime()}` }
  readStream(file: string) { return fsSync.createReadStream(this.resolve(file)) }
  writeStream(file: string, stream: NodeJS.ReadableStream) {
    return new Promise<void>((resolve, reject) => {
      fsSync.mkdirSync(path.dirname(this.resolve(file)), { recursive: true })
      stream.pipe(fsSync.createWriteStream(this.resolve(file))).on('finish', resolve).on('error', reject)
    })
  }
  async setVisibility(file: string, visibility: Visibility) { await fs.chmod(this.resolve(file), visibility === 'public' ? 0o644 : 0o600) }
  async getVisibility(file: string) { return ((await fs.stat(this.resolve(file))).mode & 0o004) ? 'public' : 'private' }

  private resolve(file: string) {
    const root = path.resolve(this.options.root)
    const target = path.resolve(root, normalize(file))
    if (!target.startsWith(root)) throw new Error('Path traversal attempt blocked.')
    return target
  }
}

export class MemoryDisk implements Disk {
  filesMap = new Map<string, Buffer>()
  async put(file: string, contents: any) { this.filesMap.set(normalize(file), Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents))) }
  async get(file: string) { const value = this.filesMap.get(normalize(file)); if (!value) throw new Error('File missing.'); return value }
  async exists(file: string) { return this.filesMap.has(normalize(file)) }
  async delete(file: string) { this.filesMap.delete(normalize(file)) }
  async copy(from: string, to: string) { await this.put(to, await this.get(from)) }
  async move(from: string, to: string) { await this.copy(from, to); await this.delete(from) }
  async size(file: string) { return (await this.get(file)).length }
  async lastModified() { return new Date() }
  async mimeType(file: string) { return lookup(file) }
  async files(directory = '') { return [...this.filesMap.keys()].filter(file => file.startsWith(directory)) }
  async directories() { return [] }
  async makeDirectory() {}
  async deleteDirectory(directory: string) { for (const file of await this.files(directory)) this.filesMap.delete(file) }
  url(file: string) { return `/storage/${normalize(file)}` }
  temporaryUrl(file: string) { return this.url(file) }
  readStream(file: string) { return fsSync.createReadStream(file) }
  async writeStream(file: string, stream: NodeJS.ReadableStream) {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    await this.put(file, Buffer.concat(chunks))
  }
  async setVisibility() {}
  async getVisibility(): Promise<Visibility> { return 'private' }
}

export class FilesystemManager {
  private disks = new Map<string, Disk>()
  private fakeDisk?: Disk

  disk(name?: string) {
    if (this.fakeDisk) return this.fakeDisk
    name ??= config<string>('filesystems.default', 'local')
    if (!this.disks.has(name)) this.disks.set(name, this.createDisk(name))
    return this.disks.get(name)!
  }

  fake(name = 'local') { this.fakeDisk = new MemoryDisk(); this.disks.set(name, this.fakeDisk) }
  restore() {
    if (this.fakeDisk) {
      for (const [key, disk] of this.disks.entries()) {
        if (disk === this.fakeDisk) this.disks.delete(key)
      }
    }
    this.fakeDisk = undefined
  }
  assertExists(path: string) { return this.disk().exists(path).then(exists => { if (!exists) throw new Error(`Expected file [${path}] to exist.`) }) }
  assertMissing(path: string) { return this.disk().exists(path).then(exists => { if (exists) throw new Error(`Expected file [${path}] to be missing.`) }) }

  private createDisk(name: string) {
    const disk = config<any>(`filesystems.disks.${name}`)
    if (!disk) throw new Error(`Filesystem disk [${name}] is not configured.`)
    if (disk.driver === 'memory') return new MemoryDisk()
    if (disk.driver === 'null') return new MemoryDisk()
    if (disk.driver === 'ftp') return new FtpDisk(disk)
    if (disk.driver === 'ssh' || disk.driver === 'sftp') return new SftpDisk(disk)
    if (disk.driver === 's3') return new S3Disk(disk)
    return new LocalDisk(disk)
  }
}

function normalize(file: string) {
  return file.replaceAll('\\', '/').replace(/^\/+/, '').split('/').filter(part => part && part !== '..').join('/')
}

export const Storage = new Proxy(new FilesystemManager(), {
  get(target, prop: string) {
    if (prop in target) {
      const value = (target as any)[prop]
      return typeof value === 'function' ? value.bind(target) : value
    }
    const value = (target.disk() as any)[prop]
    return typeof value === 'function' ? value.bind(target.disk()) : value
  }
}) as FilesystemManager & Disk
