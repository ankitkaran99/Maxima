import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { buffer as streamToBuffer } from 'node:stream/consumers'
import * as ftp from 'basic-ftp'
import SftpClient from 'ssh2-sftp-client'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { lookup } from 'mime-types'
import type { Disk, Visibility } from '@lib/storage/Storage.js'

export class FtpDisk implements Disk {
  constructor(private options: { host?: string, port?: number, user?: string, password?: string, secure?: boolean | 'implicit', url?: string, root?: string, visibility?: Visibility }) {}

  async put(file: string, contents: any) {
    await this.withClient(client => client.uploadFrom(toReadable(contents as any) as any, this.remote(file)))
  }

  async get(file: string) {
    const temp = this.tempFile()
    try {
      await this.withClient(client => client.downloadTo(temp, this.remote(file)))
      return fs.readFile(temp)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }

  async exists(file: string) {
    try {
      await this.size(file)
      return true
    } catch {
      return false
    }
  }

  async delete(file: string) { await this.withClient(client => client.remove(this.remote(file))) }
  async copy(from: string, to: string) { await this.put(to, await this.get(from)) }
  async move(from: string, to: string) { await this.withClient(client => client.rename(this.remote(from), this.remote(to))) }
  async size(file: string) { return this.withClient<any>(client => client.size(this.remote(file)) as any) as Promise<number> }
  async lastModified(file: string) { return this.withClient<any>(client => client.lastMod(this.remote(file)) as any) as Promise<Date> }
  async mimeType(file: string) { return lookup(file) }
  async files(directory = '') { return this.list(directory, entry => entry.isFile).then(entries => entries.map(entry => entry.path)) }
  async directories(directory = '') { return this.list(directory, entry => entry.isDirectory).then(entries => entries.map(entry => entry.path)) }
  async makeDirectory(directory: string) { await this.withClient(client => client.ensureDir(this.remote(directory))) }
  async deleteDirectory(directory: string) { await this.withClient(client => client.removeDir(this.remote(directory))) }
  url(file: string) { return joinUrl(this.options.url ?? ftpBaseUrl(this.options), this.remote(file)) }
  temporaryUrl(file: string, expiresAt: Date) { return `${this.url(file)}?expires=${expiresAt.getTime()}` }
  async readStream(file: string) { return Readable.from([await this.get(file)]) }
  async writeStream(file: string, stream: NodeJS.ReadableStream) { await this.put(file, stream) }
  async setVisibility(file: string, visibility: Visibility) {
    await this.withClient(async client => {
      try {
        await client.send(`SITE CHMOD ${visibility === 'public' ? '644' : '600'} ${this.remote(file)}`)
      } catch {}
    })
  }
  async getVisibility(): Promise<Visibility> { return this.options.visibility ?? 'private' }

  private async withClient<T>(callback: (client: ftp.Client) => Promise<T>) {
    const client = new ftp.Client()
    try {
      await client.access({
        host: this.options.host,
        port: this.options.port,
        user: this.options.user,
        password: this.options.password,
        secure: this.options.secure
      })
      return await callback(client)
    } finally {
      client.close()
    }
  }

  private remote(file: string) {
    return normalize(path.posix.join(this.options.root ?? '', file))
  }

  private tempFile() {
    return path.join(os.tmpdir(), `maxima-ftp-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  }

  private async list(directory: string, predicate: (entry: any) => boolean) {
    const entries = await this.withClient<any>(client => client.list(this.remote(directory)) as any)
    return entries.filter(predicate).map(entry => ({ path: path.posix.join(directory, entry.name), entry }))
  }
}

export class SftpDisk implements Disk {
  constructor(private options: { host?: string, port?: number, username?: string, password?: string, privateKey?: string, passphrase?: string, url?: string, root?: string, visibility?: Visibility }) {}

  async put(file: string, contents: any) { await this.withClient(client => client.put(contents, this.remote(file))) }
  async get(file: string) {
    const value = await this.withClient(client => client.get(this.remote(file)))
    if (Buffer.isBuffer(value)) return value
    if (typeof value === 'string') return Buffer.from(value)
    if (isReadable(value)) return streamToBuffer(value)
    return Buffer.from(String(value))
  }
  async exists(file: string) { return Boolean(await this.withClient(client => client.exists(this.remote(file)))) }
  async delete(file: string) { await this.withClient(client => client.delete(this.remote(file))) }
  async copy(from: string, to: string) { await this.put(to, await this.get(from)) }
  async move(from: string, to: string) { await this.withClient(client => client.rename(this.remote(from), this.remote(to))) }
  async size(file: string) { return (await this.withClient<any>(client => client.stat(this.remote(file)) as any) as any).size }
  async lastModified(file: string) { return new Date((await this.withClient<any>(client => client.stat(this.remote(file)) as any) as any).modifyTime) }
  async mimeType(file: string) { return lookup(file) }
  async files(directory = '') {
    return this.list(directory, entry => entry.type === '-').then(entries => entries.map(entry => entry.path))
  }
  async directories(directory = '') {
    return this.list(directory, entry => entry.type === 'd').then(entries => entries.map(entry => entry.path))
  }
  async makeDirectory(directory: string) { await this.withClient(client => client.mkdir(this.remote(directory), true)) }
  async deleteDirectory(directory: string) { await this.withClient(client => client.rmdir(this.remote(directory), true)) }
  url(file: string) { return joinUrl(this.options.url ?? sftpBaseUrl(this.options), this.remote(file)) }
  temporaryUrl(file: string, expiresAt: Date) { return `${this.url(file)}?expires=${expiresAt.getTime()}` }
  async readStream(file: string) { return Readable.from([await this.get(file)]) }
  async writeStream(file: string, stream: NodeJS.ReadableStream) { await this.put(file, stream) }
  async setVisibility(file: string, visibility: Visibility) {
    await this.withClient(client => client.chmod(this.remote(file), visibility === 'public' ? 0o644 : 0o600))
  }
  async getVisibility(file: string): Promise<Visibility> {
    const mode = (await this.withClient(client => client.stat(this.remote(file)) as any) as any).mode
    return (mode & 0o004) ? 'public' : 'private'
  }

  private async withClient<T>(callback: (client: SftpClient) => Promise<T>) {
    const client = new SftpClient()
    await client.connect({
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      password: this.options.password,
      privateKey: this.options.privateKey,
      passphrase: this.options.passphrase
    } as any)
    try {
      return await callback(client)
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  private remote(file: string) {
    return normalize(path.posix.join(this.options.root ?? '', file))
  }

  private async list(directory: string, predicate: (entry: any) => boolean) {
    const entries = await this.withClient<any>(client => client.list(this.remote(directory)) as any)
    return entries.filter(predicate).map((entry: any) => ({ path: path.posix.join(directory, entry.name), entry }))
  }
}

export class S3Disk implements Disk {
  private s3Client?: S3Client

  constructor(private options: { bucket?: string, region?: string, key?: string, secret?: string, endpoint?: string, usePathStyleEndpoint?: boolean, url?: string, visibility?: Visibility }) {}

  async put(file: string, contents: any, options: Record<string, any> = {}) {
    await this.client().send(new PutObjectCommand({
      Bucket: this.bucket(),
      Key: this.remote(file),
      Body: contents,
      ContentType: options.contentType ?? options.ContentType,
      Metadata: options.metadata
    }))
  }

  async get(file: string) {
    const response = await this.client().send(new GetObjectCommand({
      Bucket: this.bucket(),
      Key: this.remote(file)
    }))
    return bodyToBuffer(response.Body)
  }

  async exists(file: string) {
    try {
      await this.client().send(new HeadObjectCommand({
        Bucket: this.bucket(),
        Key: this.remote(file)
      }))
      return true
    } catch {
      return false
    }
  }

  async delete(file: string) {
    await this.client().send(new DeleteObjectCommand({
      Bucket: this.bucket(),
      Key: this.remote(file)
    }))
  }

  async copy(from: string, to: string) {
    await this.client().send(new CopyObjectCommand({
      Bucket: this.bucket(),
      CopySource: `${this.bucket()}/${encodeKey(this.remote(from))}`,
      Key: this.remote(to)
    }))
  }

  async move(from: string, to: string) {
    await this.copy(from, to)
    await this.delete(from)
  }

  async size(file: string) {
    const head = await this.client().send(new HeadObjectCommand({
      Bucket: this.bucket(),
      Key: this.remote(file)
    }))
    return head.ContentLength ?? 0
  }

  async lastModified(file: string) {
    const head = await this.client().send(new HeadObjectCommand({
      Bucket: this.bucket(),
      Key: this.remote(file)
    }))
    return head.LastModified ?? new Date()
  }

  async mimeType(file: string) {
    const head = await this.client().send(new HeadObjectCommand({
      Bucket: this.bucket(),
      Key: this.remote(file)
    }))
    return head.ContentType ?? lookup(file)
  }

  async files(directory = '') {
    const response = await this.client().send(new ListObjectsV2Command({
      Bucket: this.bucket(),
      Prefix: prefix(directory)
    }))
    return (response.Contents ?? [])
      .map(item => item.Key)
      .filter((key): key is string => !!key)
      .filter(key => !key.endsWith('/'))
      .map(key => normalize(key))
  }

  async directories(directory = '') {
    const response = await this.client().send(new ListObjectsV2Command({
      Bucket: this.bucket(),
      Prefix: prefix(directory),
      Delimiter: '/'
    }))
    return (response.CommonPrefixes ?? [])
      .map(item => item.Prefix)
      .filter((key): key is string => !!key)
      .map(key => normalize(key))
  }

  async makeDirectory() {}

  async deleteDirectory(directory: string) {
    const keys = await this.files(directory)
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client().send(new DeleteObjectsCommand({
        Bucket: this.bucket(),
        Delete: {
          Objects: keys.slice(i, i + 1000).map(Key => ({ Key }))
        }
      }))
    }
  }

  url(file: string) {
    const base = this.options.url ?? s3BaseUrl(this.options)
    return joinUrl(base, this.remote(file))
  }

  async temporaryUrl(file: string, expiresAt: Date) {
    return getSignedUrl(this.client(), new GetObjectCommand({
      Bucket: this.bucket(),
      Key: this.remote(file)
    }), {
      expiresIn: Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000))
    })
  }

  async readStream(file: string) {
    const response = await this.client().send(new GetObjectCommand({
      Bucket: this.bucket(),
      Key: this.remote(file)
    }))
    return bufferToReadable(await bodyToBuffer(response.Body))
  }

  async writeStream(file: string, stream: NodeJS.ReadableStream) {
    await this.put(file, stream)
  }

  async setVisibility() {}

  async getVisibility(): Promise<Visibility> {
    return this.options.visibility ?? 'private'
  }

  private clientInstance() {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        region: this.options.region,
        endpoint: this.options.endpoint,
        forcePathStyle: this.options.usePathStyleEndpoint,
        credentials: this.options.key && this.options.secret ? {
          accessKeyId: this.options.key,
          secretAccessKey: this.options.secret
        } : undefined
      })
    }
    return this.s3Client
  }

  private client() {
    return this.clientInstance()
  }

  private bucket() {
    if (!this.options.bucket) throw new Error('S3 bucket is not configured.')
    return this.options.bucket
  }

  private remote(file: string) {
    return normalize(path.posix.join('', file))
  }
}

function ftpBaseUrl(options: { host?: string, port?: number, secure?: boolean | 'implicit' }) {
  const protocol = options.secure ? 'ftps' : 'ftp'
  const host = options.host ?? 'localhost'
  return `${protocol}://${host}${options.port ? `:${options.port}` : ''}`
}

function sftpBaseUrl(options: { host?: string, port?: number }) {
  const host = options.host ?? 'localhost'
  return `sftp://${host}${options.port ? `:${options.port}` : ''}`
}

function s3BaseUrl(options: { bucket?: string, region?: string, endpoint?: string, usePathStyleEndpoint?: boolean }) {
  if (options.endpoint) {
    return options.usePathStyleEndpoint && options.bucket
      ? `${options.endpoint.replace(/\/+$/, '')}/${options.bucket}`
      : options.endpoint.replace(/\/+$/, '')
  }
  return options.bucket && options.region
    ? `https://${options.bucket}.s3.${options.region}.amazonaws.com`
    : 'https://s3.amazonaws.com'
}

function joinUrl(base: string, file: string) {
  return `${base.replace(/\/+$/, '')}/${normalize(file)}`
}

function encodeKey(key: string) {
  return key.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

function prefix(directory: string) {
  const normalized = normalize(directory)
  return normalized ? `${normalized.replace(/\/+$/, '')}/` : ''
}

function normalize(file: string) {
  return file.replaceAll('\\', '/').replace(/^\/+/, '').split('/').filter(part => part && part !== '..').join('/')
}

function toReadable(contents: any) {
  if (isReadable(contents)) return contents
  if (Buffer.isBuffer(contents)) return Readable.from([contents])
  if (contents instanceof Uint8Array) return Readable.from([Buffer.from(contents)])
  return Readable.from([Buffer.from(String(contents))])
}

function bufferToReadable(buffer: Buffer) {
  return Readable.from([buffer])
}

function isReadable(value: any): value is NodeJS.ReadableStream {
  return value && typeof value.pipe === 'function'
}

async function bodyToBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body)
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  if (isReadable(body)) return streamToBuffer(body as any)
  if (typeof body.getReader === 'function' && typeof Readable.fromWeb === 'function') {
    return streamToBuffer(Readable.fromWeb(body as any))
  }
  return Buffer.from(String(body))
}
