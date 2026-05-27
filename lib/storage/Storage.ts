import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { lookup } from 'mime-types'
import { config } from '@lib/foundation/helpers.js'
import { FtpDisk, S3Disk, SftpDisk } from '@lib/storage/Drivers.js'

export type Visibility = 'public' | 'private'

export interface Disk {
  put(path: string, contents: any, options?: Record<string, any>): Promise<void>
  get(path: string): Promise<Buffer>
  exists(path: string): Promise<boolean>
  missing(path: string): Promise<boolean>
  existsAll(paths: string[]): Promise<boolean>
  existsAny(paths: string[]): Promise<boolean>
  missingAll(paths: string[]): Promise<boolean>
  missingAny(paths: string[]): Promise<boolean>
  delete(path: string): Promise<void>
  copy(from: string, to: string): Promise<void>
  move(from: string, to: string): Promise<void>
  size(path: string): Promise<number>
  lastModified(path: string): Promise<Date>
  mimeType(path: string): Promise<string | false>
  files(path?: string): Promise<string[]>
  allFiles(path?: string): Promise<string[]>
  directories(path?: string): Promise<string[]>
  allDirectories(path?: string): Promise<string[]>
  makeDirectory(path: string): Promise<void>
  deleteDirectory(path: string): Promise<void>
  url(path: string): string
  temporaryUrl(path: string, expiresAt: Date): string | Promise<string>
  temporaryUploadUrl(path: string, expiresAt: Date, options?: Record<string, any>): Promise<{ url: string, headers: Record<string, string> }>
  readStream(path: string): NodeJS.ReadableStream | Promise<NodeJS.ReadableStream>
  writeStream(path: string, stream: NodeJS.ReadableStream): Promise<void>
  setVisibility(path: string, visibility: Visibility): Promise<void>
  getVisibility(path: string): Promise<Visibility>
  checksum(path: string, algorithm?: string): Promise<string>
  path?(path: string): string
  response?(path: string, name?: string, headers?: Record<string, string | number | boolean>): Promise<StorageResponse>
  download?(path: string, name?: string, headers?: Record<string, string | number | boolean>): Promise<StorageResponse>
}

export type StorageResponse = {
  body: Buffer | NodeJS.ReadableStream
  headers: Record<string, string | number | boolean>
  statusCode: number
}

export class LocalDisk implements Disk {
  constructor(private options: { root: string, url?: string, visibility?: Visibility, throw?: boolean }) {}

  async put(file: string, contents: any) { return this.attempt(async () => { await fs.mkdir(path.dirname(this.resolve(file)), { recursive: true }); await fs.writeFile(this.resolve(file), contents) }) }
  async get(file: string) { return this.attempt(() => fs.readFile(this.resolve(file))) }
  async exists(file: string) { return fs.access(this.resolve(file)).then(() => true).catch(() => false) }
  async missing(file: string) { return !(await this.exists(file)) }
  async existsAll(files: string[]) { return (await Promise.all(files.map(file => this.exists(file)))).every(Boolean) }
  async existsAny(files: string[]) { return (await Promise.all(files.map(file => this.exists(file)))).some(Boolean) }
  async missingAll(files: string[]) { return !(await this.existsAny(files)) }
  async missingAny(files: string[]) { return !(await this.existsAll(files)) }
  async delete(file: string) { return this.attempt(() => fs.rm(this.resolve(file), { force: true })) }
  async copy(from: string, to: string) { return this.attempt(async () => { await fs.mkdir(path.dirname(this.resolve(to)), { recursive: true }); await fs.copyFile(this.resolve(from), this.resolve(to)) }) }
  async move(from: string, to: string) { await this.copy(from, to); await this.delete(from) }
  async size(file: string) { return this.attempt(async () => (await fs.stat(this.resolve(file))).size) }
  async lastModified(file: string) { return this.attempt(async () => (await fs.stat(this.resolve(file))).mtime) }
  async mimeType(file: string) { return lookup(file) }
  async files(directory = '') { return this.attempt(async () => (await fs.readdir(this.resolve(directory), { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.posix.join(normalize(directory), entry.name))) }
  async allFiles(directory = '') { return collectLocal(this.resolve(directory), normalize(directory), 'files') }
  async directories(directory = '') { return this.attempt(async () => (await fs.readdir(this.resolve(directory), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.posix.join(normalize(directory), entry.name))) }
  async allDirectories(directory = '') { return collectLocal(this.resolve(directory), normalize(directory), 'directories') }
  async makeDirectory(directory: string) { return this.attempt(() => fs.mkdir(this.resolve(directory), { recursive: true }).then(() => undefined)) }
  async deleteDirectory(directory: string) { return this.attempt(() => fs.rm(this.resolve(directory), { recursive: true, force: true })) }
  url(file: string) { return `${this.options.url ?? ''}/${normalize(file)}` }
  temporaryUrl(file: string, expiresAt: Date) { return withQuery(this.url(file), { expires: String(expiresAt.getTime()), signature: signTemporaryUrl(file, expiresAt) }) }
  async temporaryUploadUrl(file: string, expiresAt: Date) { return { url: this.temporaryUrl(file, expiresAt), headers: {} } }
  readStream(file: string) { return fsSync.createReadStream(this.resolve(file)) }
  writeStream(file: string, stream: NodeJS.ReadableStream) {
    return new Promise<void>((resolve, reject) => {
      fsSync.mkdirSync(path.dirname(this.resolve(file)), { recursive: true })
      stream.pipe(fsSync.createWriteStream(this.resolve(file))).on('finish', resolve).on('error', reject)
    })
  }
  async setVisibility(file: string, visibility: Visibility) { await fs.chmod(this.resolve(file), visibility === 'public' ? 0o644 : 0o600) }
  async getVisibility(file: string) { return ((await fs.stat(this.resolve(file))).mode & 0o004) ? 'public' : 'private' }
  async checksum(file: string, algorithm = 'md5') { return crypto.createHash(algorithm).update(await this.get(file)).digest('hex') }
  path(file: string) { return this.resolve(file) }
  async response(file: string, name = path.basename(file), headers: Record<string, string | number | boolean> = {}) {
    const type = await this.mimeType(file) || 'application/octet-stream'
    return { body: await this.get(file), statusCode: 200, headers: { 'content-type': type, 'content-disposition': contentDisposition('inline', name), ...headers } }
  }
  async download(file: string, name = path.basename(file), headers: Record<string, string | number | boolean> = {}) {
    const type = await this.mimeType(file) || 'application/octet-stream'
    return { body: await this.get(file), statusCode: 200, headers: { 'content-type': type, 'content-disposition': contentDisposition('attachment', name), ...headers } }
  }

  private resolve(file: string) {
    const root = path.resolve(this.options.root)
    const target = path.resolve(root, normalize(file))
    if (!target.startsWith(root)) throw new Error('Path traversal attempt blocked.')
    return target
  }

  private async attempt<T>(callback: () => Promise<T>): Promise<T> {
    try {
      return await callback()
    } catch (error) {
      if (this.options.throw) throw error
      throw error
    }
  }
}

export class MemoryDisk implements Disk {
  filesMap = new Map<string, Buffer>()
  directoriesSet = new Set<string>()
  constructor(private options: { throw?: boolean } = {}) {}
  async put(file: string, contents: any) { this.filesMap.set(normalize(file), Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents))) }
  async get(file: string) { const value = this.filesMap.get(normalize(file)); if (!value) throw new Error('File missing.'); return value }
  async exists(file: string) { return this.filesMap.has(normalize(file)) }
  async missing(file: string) { return !(await this.exists(file)) }
  async existsAll(files: string[]) { return (await Promise.all(files.map(file => this.exists(file)))).every(Boolean) }
  async existsAny(files: string[]) { return (await Promise.all(files.map(file => this.exists(file)))).some(Boolean) }
  async missingAll(files: string[]) { return !(await this.existsAny(files)) }
  async missingAny(files: string[]) { return !(await this.existsAll(files)) }
  async delete(file: string) { this.filesMap.delete(normalize(file)) }
  async copy(from: string, to: string) { await this.put(to, await this.get(from)) }
  async move(from: string, to: string) { await this.copy(from, to); await this.delete(from) }
  async size(file: string) { return (await this.get(file)).length }
  async lastModified() { return new Date() }
  async mimeType(file: string) { return lookup(file) }
  async files(directory = '') { const prefix = normalize(directory); return [...this.filesMap.keys()].filter(file => parentDir(file) === prefix) }
  async allFiles(directory = '') { const prefix = normalize(directory); return [...this.filesMap.keys()].filter(file => !prefix || file === prefix || file.startsWith(`${prefix}/`)) }
  async directories(directory = '') { const prefix = normalize(directory); return [...new Set([...this.filesMap.keys()].map(parentDir).concat([...this.directoriesSet]))].filter(dir => dir && parentDir(dir) === prefix) }
  async allDirectories(directory = '') { const prefix = normalize(directory); return [...new Set([...this.filesMap.keys()].flatMap(file => ancestorDirs(file)).concat([...this.directoriesSet]))].filter(dir => !prefix || dir === prefix || dir.startsWith(`${prefix}/`)) }
  async makeDirectory(directory: string) { this.directoriesSet.add(normalize(directory)) }
  async deleteDirectory(directory: string) {
    const prefix = normalize(directory)
    for (const file of await this.allFiles(directory)) this.filesMap.delete(file)
    for (const dir of [...this.directoriesSet]) if (dir === prefix || dir.startsWith(`${prefix}/`)) this.directoriesSet.delete(dir)
  }
  url(file: string) { return `/storage/${normalize(file)}` }
  temporaryUrl(file: string, expiresAt = new Date(Date.now() + 300000)) { return withQuery(this.url(file), { expires: String(expiresAt.getTime()), signature: signTemporaryUrl(file, expiresAt) }) }
  async temporaryUploadUrl(file: string, expiresAt: Date) { return { url: this.temporaryUrl(file, expiresAt), headers: {} } }
  readStream(file: string) { return fsSync.createReadStream(file) }
  async writeStream(file: string, stream: NodeJS.ReadableStream) {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    await this.put(file, Buffer.concat(chunks))
  }
  async setVisibility() {}
  async getVisibility(): Promise<Visibility> { return 'private' }
  async checksum(file: string, algorithm = 'md5') { return crypto.createHash(algorithm).update(await this.get(file)).digest('hex') }
  async response(file: string, name = path.basename(file), headers: Record<string, string | number | boolean> = {}) {
    const type = await this.mimeType(file) || 'application/octet-stream'
    return { body: await this.get(file), statusCode: 200, headers: { 'content-type': type, 'content-disposition': contentDisposition('inline', name), ...headers } }
  }
  async download(file: string, name = path.basename(file), headers: Record<string, string | number | boolean> = {}) {
    const type = await this.mimeType(file) || 'application/octet-stream'
    return { body: await this.get(file), statusCode: 200, headers: { 'content-type': type, 'content-disposition': contentDisposition('attachment', name), ...headers } }
  }
}

class ScopedDisk implements Disk {
  constructor(private inner: Disk, private prefix: string) {}
  put(file: string, contents: any, options?: Record<string, any>) { return this.inner.put(this.scope(file), contents, options) }
  get(file: string) { return this.inner.get(this.scope(file)) }
  exists(file: string) { return this.inner.exists(this.scope(file)) }
  missing(file: string) { return this.inner.missing(this.scope(file)) }
  existsAll(files: string[]) { return this.inner.existsAll(files.map(file => this.scope(file))) }
  existsAny(files: string[]) { return this.inner.existsAny(files.map(file => this.scope(file))) }
  missingAll(files: string[]) { return this.inner.missingAll(files.map(file => this.scope(file))) }
  missingAny(files: string[]) { return this.inner.missingAny(files.map(file => this.scope(file))) }
  delete(file: string) { return this.inner.delete(this.scope(file)) }
  copy(from: string, to: string) { return this.inner.copy(this.scope(from), this.scope(to)) }
  move(from: string, to: string) { return this.inner.move(this.scope(from), this.scope(to)) }
  size(file: string) { return this.inner.size(this.scope(file)) }
  lastModified(file: string) { return this.inner.lastModified(this.scope(file)) }
  mimeType(file: string) { return this.inner.mimeType(this.scope(file)) }
  async files(directory = '') { return (await this.inner.files(this.scope(directory))).map(file => this.unscope(file)) }
  async allFiles(directory = '') { return (await this.inner.allFiles(this.scope(directory))).map(file => this.unscope(file)) }
  async directories(directory = '') { return (await this.inner.directories(this.scope(directory))).map(file => this.unscope(file)) }
  async allDirectories(directory = '') { return (await this.inner.allDirectories(this.scope(directory))).map(file => this.unscope(file)) }
  makeDirectory(directory: string) { return this.inner.makeDirectory(this.scope(directory)) }
  deleteDirectory(directory: string) { return this.inner.deleteDirectory(this.scope(directory)) }
  url(file: string) { return this.inner.url(this.scope(file)) }
  temporaryUrl(file: string, expiresAt: Date) { return this.inner.temporaryUrl(this.scope(file), expiresAt) }
  temporaryUploadUrl(file: string, expiresAt: Date, options?: Record<string, any>) { return this.inner.temporaryUploadUrl(this.scope(file), expiresAt, options) }
  readStream(file: string) { return this.inner.readStream(this.scope(file)) }
  writeStream(file: string, stream: NodeJS.ReadableStream) { return this.inner.writeStream(this.scope(file), stream) }
  setVisibility(file: string, visibility: Visibility) { return this.inner.setVisibility(this.scope(file), visibility) }
  getVisibility(file: string) { return this.inner.getVisibility(this.scope(file)) }
  checksum(file: string, algorithm?: string) { return this.inner.checksum(this.scope(file), algorithm) }
  path(file: string) { return this.inner.path?.(this.scope(file)) ?? this.scope(file) }
  response(file: string, name?: string, headers?: Record<string, string | number | boolean>) { return this.inner.response!(this.scope(file), name, headers) }
  download(file: string, name?: string, headers?: Record<string, string | number | boolean>) { return this.inner.download!(this.scope(file), name, headers) }
  private scope(file: string) { return normalize(path.posix.join(this.prefix, file)) }
  private unscope(file: string) { const prefix = `${normalize(this.prefix)}/`; return normalize(file).startsWith(prefix) ? normalize(file).slice(prefix.length) : normalize(file) }
}

class ReadOnlyDisk implements Disk {
  constructor(private inner: Disk) {}
  put(): Promise<void> { return Promise.reject(readOnlyError()) }
  get(file: string) { return this.inner.get(file) }
  exists(file: string) { return this.inner.exists(file) }
  missing(file: string) { return this.inner.missing(file) }
  existsAll(files: string[]) { return this.inner.existsAll(files) }
  existsAny(files: string[]) { return this.inner.existsAny(files) }
  missingAll(files: string[]) { return this.inner.missingAll(files) }
  missingAny(files: string[]) { return this.inner.missingAny(files) }
  delete(): Promise<void> { return Promise.reject(readOnlyError()) }
  copy(): Promise<void> { return Promise.reject(readOnlyError()) }
  move(): Promise<void> { return Promise.reject(readOnlyError()) }
  size(file: string) { return this.inner.size(file) }
  lastModified(file: string) { return this.inner.lastModified(file) }
  mimeType(file: string) { return this.inner.mimeType(file) }
  files(directory?: string) { return this.inner.files(directory) }
  allFiles(directory?: string) { return this.inner.allFiles(directory) }
  directories(directory?: string) { return this.inner.directories(directory) }
  allDirectories(directory?: string) { return this.inner.allDirectories(directory) }
  makeDirectory(): Promise<void> { return Promise.reject(readOnlyError()) }
  deleteDirectory(): Promise<void> { return Promise.reject(readOnlyError()) }
  url(file: string) { return this.inner.url(file) }
  temporaryUrl(file: string, expiresAt: Date) { return this.inner.temporaryUrl(file, expiresAt) }
  temporaryUploadUrl(file: string, expiresAt: Date, options?: Record<string, any>) { return this.inner.temporaryUploadUrl(file, expiresAt, options) }
  readStream(file: string) { return this.inner.readStream(file) }
  writeStream(): Promise<void> { return Promise.reject(readOnlyError()) }
  setVisibility(): Promise<void> { return Promise.reject(readOnlyError()) }
  getVisibility(file: string) { return this.inner.getVisibility(file) }
  checksum(file: string, algorithm?: string) { return this.inner.checksum(file, algorithm) }
  path(file: string) { return this.inner.path?.(file) ?? file }
  response(file: string, name?: string, headers?: Record<string, string | number | boolean>) { return this.inner.response!(file, name, headers) }
  download(file: string, name?: string, headers?: Record<string, string | number | boolean>) { return this.inner.download!(file, name, headers) }
}

class ThrowingDisk implements Disk {
  constructor(private inner: Disk, private shouldThrow: boolean) {}
  private async wrap<T>(callback: () => Promise<T>, fallback: T): Promise<T> {
    try { return await callback() } catch (error) { if (this.shouldThrow) throw error; return fallback }
  }
  put(file: string, contents: any, options?: Record<string, any>) { return this.wrap(() => this.inner.put(file, contents, options), undefined) }
  get(file: string) { return this.wrap(() => this.inner.get(file), Buffer.alloc(0)) }
  exists(file: string) { return this.wrap(() => this.inner.exists(file), false) }
  missing(file: string) { return this.wrap(() => this.inner.missing(file), true) }
  existsAll(files: string[]) { return this.wrap(() => this.inner.existsAll(files), false) }
  existsAny(files: string[]) { return this.wrap(() => this.inner.existsAny(files), false) }
  missingAll(files: string[]) { return this.wrap(() => this.inner.missingAll(files), true) }
  missingAny(files: string[]) { return this.wrap(() => this.inner.missingAny(files), true) }
  delete(file: string) { return this.wrap(() => this.inner.delete(file), undefined) }
  copy(from: string, to: string) { return this.wrap(() => this.inner.copy(from, to), undefined) }
  move(from: string, to: string) { return this.wrap(() => this.inner.move(from, to), undefined) }
  size(file: string) { return this.wrap(() => this.inner.size(file), 0) }
  lastModified(file: string) { return this.wrap(() => this.inner.lastModified(file), new Date(0)) }
  mimeType(file: string) { return this.wrap(() => this.inner.mimeType(file), false) }
  files(directory?: string) { return this.wrap(() => this.inner.files(directory), []) }
  allFiles(directory?: string) { return this.wrap(() => this.inner.allFiles(directory), []) }
  directories(directory?: string) { return this.wrap(() => this.inner.directories(directory), []) }
  allDirectories(directory?: string) { return this.wrap(() => this.inner.allDirectories(directory), []) }
  makeDirectory(directory: string) { return this.wrap(() => this.inner.makeDirectory(directory), undefined) }
  deleteDirectory(directory: string) { return this.wrap(() => this.inner.deleteDirectory(directory), undefined) }
  url(file: string) { return this.inner.url(file) }
  temporaryUrl(file: string, expiresAt: Date) { return this.inner.temporaryUrl(file, expiresAt) }
  temporaryUploadUrl(file: string, expiresAt: Date, options?: Record<string, any>) { return this.wrap(() => this.inner.temporaryUploadUrl(file, expiresAt, options), { url: this.url(file), headers: {} }) }
  readStream(file: string) { return this.inner.readStream(file) }
  writeStream(file: string, stream: NodeJS.ReadableStream) { return this.wrap(() => this.inner.writeStream(file, stream), undefined) }
  setVisibility(file: string, visibility: Visibility) { return this.wrap(() => this.inner.setVisibility(file, visibility), undefined) }
  getVisibility(file: string) { return this.wrap(() => this.inner.getVisibility(file), 'private' as Visibility) }
  checksum(file: string, algorithm?: string) { return this.wrap(() => this.inner.checksum(file, algorithm), '') }
  path(file: string) { return this.inner.path?.(file) ?? file }
  response(file: string, name?: string, headers?: Record<string, string | number | boolean>) { return this.wrap(() => this.inner.response!(file, name, headers), { body: Buffer.alloc(0), statusCode: 404, headers: {} }) }
  download(file: string, name?: string, headers?: Record<string, string | number | boolean>) { return this.wrap(() => this.inner.download!(file, name, headers), { body: Buffer.alloc(0), statusCode: 404, headers: {} }) }
}

export class FilesystemManager {
  private disks = new Map<string, Disk>()
  private fakeDisks = new Map<string, Disk>()

  disk(name?: string) {
    name ??= config<string>('filesystems.default', 'local')
    if (this.fakeDisks.has(name)) return this.fakeDisks.get(name)!
    if (this.fakeDisks.size) return [...this.fakeDisks.values()][0]
    if (!this.disks.has(name)) this.disks.set(name, this.createDisk(name))
    return this.disks.get(name)!
  }

  cloud() { return this.disk(config<string>('filesystems.cloud', 's3')) }
  build(options: Record<string, any>) { return this.createDiskFromConfig(options, 'on-demand') }
  fake(name = 'local') { const disk = new MemoryDisk(); this.fakeDisks.set(name, disk); this.disks.set(name, disk); return disk }
  restore() {
    for (const [key, disk] of this.disks.entries()) {
      if ([...this.fakeDisks.values()].includes(disk)) this.disks.delete(key)
    }
    this.fakeDisks.clear()
  }
  assertExists(path: string | string[]) { const paths = Array.isArray(path) ? path : [path]; return this.disk().existsAll(paths).then(exists => { if (!exists) throw new Error(`Expected file [${paths.join(', ')}] to exist.`) }) }
  assertMissing(path: string | string[]) { const paths = Array.isArray(path) ? path : [path]; return this.disk().missingAll(paths).then(missing => { if (!missing) throw new Error(`Expected file [${paths.join(', ')}] to be missing.`) }) }
  assertDirectoryEmpty(directory: string) { return this.disk().allFiles(directory).then(files => { if (files.length) throw new Error(`Expected directory [${directory}] to be empty.`) }) }
  assertCount(directory: string, count: number) { return this.disk().allFiles(directory).then(files => { if (files.length !== count) throw new Error(`Expected directory [${directory}] to contain [${count}] files, found [${files.length}].`) }) }

  private createDisk(name: string) {
    const disk = config<any>(`filesystems.disks.${name}`)
    if (!disk) throw new Error(`Filesystem disk [${name}] is not configured.`)
    return this.createDiskFromConfig(disk, name)
  }

  private createDiskFromConfig(disk: Record<string, any>, name: string): Disk {
    let resolved: Disk
    if (disk.driver === 'scoped') {
      const base = disk.disk ? this.disk(disk.disk) : this.createDiskFromConfig(disk.inner ?? { driver: 'local', root: disk.root }, `${name}-inner`)
      resolved = new ScopedDisk(base, disk.prefix ?? '')
    } else if (disk.driver === 'memory' || disk.driver === 'null') resolved = new MemoryDisk(disk)
    else if (disk.driver === 'ftp') resolved = new FtpDisk(disk) as any
    else if (disk.driver === 'ssh' || disk.driver === 'sftp') resolved = new SftpDisk(disk) as any
    else if (disk.driver === 's3') resolved = new S3Disk(disk) as any
    else resolved = new LocalDisk(disk as any)

    if (disk.readOnly || disk.readonly || disk['read-only']) resolved = new ReadOnlyDisk(resolved)
    if (disk.throw !== undefined) resolved = new ThrowingDisk(resolved, Boolean(disk.throw))
    return resolved
  }
}

function normalize(file: string) {
  return file.replaceAll('\\', '/').replace(/^\/+/, '').split('/').filter(part => part && part !== '..').join('/')
}

async function collectLocal(root: string, base: string, type: 'files' | 'directories'): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const results: string[] = []
  for (const entry of entries) {
    const relative = path.posix.join(base, entry.name)
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (type === 'directories') results.push(relative)
      results.push(...await collectLocal(absolute, relative, type))
    } else if (entry.isFile() && type === 'files') {
      results.push(relative)
    }
  }
  return results
}

function parentDir(file: string) {
  const dir = path.posix.dirname(normalize(file))
  return dir === '.' ? '' : dir
}

function ancestorDirs(file: string) {
  const parts = normalize(file).split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

function signTemporaryUrl(file: string, expiresAt: Date) {
  return crypto.createHmac('sha256', String(config('app.key', 'maxima-secret'))).update(`${normalize(file)}|${expiresAt.getTime()}`).digest('hex')
}

function withQuery(url: string, params: Record<string, string>) {
  const parsed = new URL(url, 'http://localhost')
  for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value)
  if (url.startsWith('/')) return `${parsed.pathname}${parsed.search}`
  return parsed.toString()
}

function contentDisposition(disposition: 'inline' | 'attachment', filename: string) {
  return `${disposition}; filename="${filename.replace(/["\\\r\n]/g, '_')}"`
}

function readOnlyError() {
  return new Error('Filesystem disk is read-only.')
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
