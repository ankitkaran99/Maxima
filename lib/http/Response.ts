import type { FastifyReply } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { lookup as lookupMimeType } from 'mime-types'
import { ViewFactory } from '@lib/view/ViewFactory.js'
import { app, route as routeUrl } from '@lib/foundation/helpers.js'
import { Route, type ControllerAction } from '@lib/http/Route.js'
import { encodeCookie } from '@lib/session/Session.js'
import { config } from '@lib/foundation/helpers.js'

export class Response {
  [key: string]: any

  private static macros = new Map<string, Function>()

  constructor(private reply: FastifyReply) {
    return new Proxy(this, {
      get(target, property, receiver) {
        if (typeof property === 'string' && Response.macros.has(property)) {
          return (...args: unknown[]) => Response.macros.get(property)!.apply(receiver, args)
        }

        return Reflect.get(target, property, receiver)
      }
    })
  }

  static macro(name: string, callback: Function) {
    this.macros.set(name, callback)
  }

  static hasMacro(name: string) {
    return this.macros.has(name)
  }

  static flushMacros() {
    this.macros.clear()
  }

  json(data: unknown, status = 200) {
    return this.reply.code(status).send(data)
  }

  noContent(status = 204) {
    return this.reply.code(status).send()
  }

  async redirect(to: string, status = 302) {
    await commitReplySession(this.reply)
    return this.reply.redirect(to, status)
  }

  back(status = 302, fallback = '/') {
    const headers = this.reply.request?.headers ?? {}
    const location = headers.referer ?? headers.referrer ?? fallback
    return this.redirect(Array.isArray(location) ? location[0] : String(location), status)
  }

  route(name: string, params: Record<string, string | number> = {}, status = 302) {
    return this.redirect(routeUrl(name, params), status)
  }

  action(action: ControllerAction, params: Record<string, string | number> = {}, status = 302) {
    const definition = Route.all().find(route => matchesAction(route.action, action))
    if (!definition) throw new Error(`Route action [${describeAction(action)}] is not defined.`)
    return this.redirect(routePath(definition.path, params), status)
  }

  async view(template: string, data: Record<string, unknown> = {}, status = 200) {
    const viewFactory = await app<any>(ViewFactory)
    return this.reply.type('text/html').code(status).send(await viewFactory.render(template, data))
  }

  stream(source: StreamSource, status = 200, headers: Record<string, string | number | boolean> = {}) {
    applyHeaders(this.reply, headers)
    return this.reply.code(status).send(resolveStreamSource(source))
  }

  streamDownload(source: StreamSource, name: string, headers: Record<string, string | number | boolean> = {}, status = 200) {
    return this.stream(source, status, {
      'content-type': 'application/octet-stream',
      'content-disposition': contentDisposition('attachment', name),
      ...headers
    })
  }

  file(filePath: string, headers: Record<string, string | number | boolean> = {}, status = 200) {
    return this.fileResponse(filePath, path.basename(filePath), 'inline', headers, status)
  }

  download(filePath: string, name = path.basename(filePath), headers: Record<string, string | number | boolean> = {}) {
    return this.fileResponse(filePath, name, 'attachment', headers)
  }

  async storage(path: string, disk?: string, name = path.split(/[\\/]/).pop() ?? 'file', headers: Record<string, string | number | boolean> = {}) {
    const { Storage } = await import('@lib/storage/Storage.js')
    const response = await Storage.disk(disk).response(path, name, headers)
    applyHeaders(this.reply, response.headers)
    return this.reply.code(response.statusCode).send(response.body)
  }

  async storageDownload(path: string, disk?: string, name = path.split(/[\\/]/).pop() ?? 'file', headers: Record<string, string | number | boolean> = {}) {
    const { Storage } = await import('@lib/storage/Storage.js')
    const response = await Storage.disk(disk).download(path, name, headers)
    applyHeaders(this.reply, response.headers)
    return this.reply.code(response.statusCode).send(response.body)
  }

  cookie(name: string, value: unknown, options: Record<string, any> = {}) {
    const sessionCookie = config<Record<string, any>>('session.cookie', {})
    const payload = encodeCookie(value, { signed: options.signed ?? sessionCookie.signed, encrypted: options.encrypted ?? sessionCookie.encrypted })
    const cookieOptions = sanitizeCookieOptions(options)
    if (typeof (this.reply as any).setCookie === 'function') {
      ;(this.reply as any).setCookie(name, payload, cookieOptions)
      return this.reply
    }
    const serialized = serializeCookie(name, payload, options)
    const current = (this.reply as any).getHeader?.('Set-Cookie')
    if (!current) {
      ;(this.reply as any).header?.('Set-Cookie', serialized)
    } else {
      ;(this.reply as any).header?.('Set-Cookie', Array.isArray(current) ? [...current, serialized] : [current, serialized])
    }
    return this.reply
  }

  clearCookie(name: string, options: Record<string, any> = {}) {
    if (typeof (this.reply as any).clearCookie === 'function') {
      ;(this.reply as any).clearCookie(name, options)
    } else {
      this.cookie(name, '', { ...options, expires: new Date(0) })
    }
    return this.reply
  }

  withInput(input?: Record<string, unknown>) {
    const payload = input ?? {
      ...((this.reply.request?.params ?? {}) as Record<string, unknown>),
      ...((this.reply.request?.query ?? {}) as Record<string, unknown>),
      ...((this.reply.request?.body ?? {}) as Record<string, unknown>)
    }
    ;(this.reply as any).session?.flash?.('_old_input', payload)
    return this
  }

  withErrors(errors: Record<string, string[]> | Error, bag = 'default') {
    const payload = errors instanceof Error ? { error: [errors.message] } : errors
    ;(this.reply as any).session?.flashErrors?.(payload, bag)
    return this
  }

  validationError(errors: Record<string, string[]>, status = 422) {
    return this.reply.code(status).send({ message: 'Validation failed', errors })
  }

  private fileResponse(
    filePath: string,
    name: string,
    disposition: 'inline' | 'attachment',
    headers: Record<string, string | number | boolean> = {},
    status = 200
  ) {
    const stat = fs.statSync(filePath)
    const type = lookupMimeType(filePath) || 'application/octet-stream'
    const etag = fileEtag(stat)
    const lastModified = stat.mtime.toUTCString()
    const baseHeaders = {
      'accept-ranges': 'bytes',
      'content-type': type,
      'content-disposition': contentDisposition(disposition, name),
      etag,
      'last-modified': lastModified,
      ...headers
    }

    applyHeaders(this.reply, baseHeaders)

    if (isNotModified(this.reply.request?.headers ?? {}, etag, stat.mtime)) {
      return this.reply.code(304).send()
    }

    const ranges = parseRangeHeader(this.reply.request?.headers?.range, stat.size)
    if (ranges === false) {
      this.reply.header('content-range', `bytes */${stat.size}`)
      return this.reply.code(416).send()
    }

    if (ranges?.length === 1) {
      const [range] = ranges
      const length = range.end - range.start + 1
      this.reply.header('content-length', length)
      this.reply.header('content-range', `bytes ${range.start}-${range.end}/${stat.size}`)
      return this.reply.code(206).send(fs.createReadStream(filePath, range))
    }

    if (ranges && ranges.length > 1) {
      const boundary = `maxima-${Date.now().toString(16)}`
      const body = multipartByteRanges(filePath, ranges, boundary, type, stat.size)
      this.reply.header('content-type', `multipart/byteranges; boundary=${boundary}`)
      this.reply.header('content-length', body.length)
      return this.reply.code(206).send(body)
    }

    this.reply.header('content-length', stat.size)
    return this.reply.code(status).send(fs.createReadStream(filePath))
  }
}

function serializeCookie(name: string, value: string, options: Record<string, any>) {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.expires) parts.push(`Expires=${new Date(options.expires).toUTCString()}`)
  if (options.maxAge) parts.push(`Max-Age=${Math.floor(Number(options.maxAge))}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite) parts.push(`SameSite=${String(options.sameSite).charAt(0).toUpperCase()}${String(options.sameSite).slice(1)}`)
  return parts.join('; ')
}

function sanitizeCookieOptions(options: Record<string, any>) {
  const { signed, encrypted, ...rest } = options
  return rest
}

type StreamSource = Readable | NodeJS.ReadableStream | AsyncIterable<unknown> | Iterable<unknown> | ((stream: PassThrough) => unknown | Promise<unknown>)

function resolveStreamSource(source: StreamSource) {
  if (typeof source !== 'function') return source

  const stream = new PassThrough()
  Promise.resolve(source(stream))
    .then(() => {
      if (!stream.destroyed && !stream.writableEnded) stream.end()
    })
    .catch(error => stream.destroy(error))
  return stream
}

function applyHeaders(reply: FastifyReply, headers: Record<string, string | number | boolean>) {
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value)
  }
}

function contentDisposition(disposition: 'inline' | 'attachment', filename: string) {
  const safeName = filename.replace(/["\\\r\n]/g, '_')
  return `${disposition}; filename="${safeName}"`
}

function matchesAction(candidate: ControllerAction, expected: ControllerAction) {
  if (typeof expected === 'string') return candidate === expected
  if (!Array.isArray(expected)) return candidate === expected
  return Array.isArray(candidate) && candidate[0] === expected[0] && candidate[1] === expected[1]
}

function describeAction(action: ControllerAction) {
  if (typeof action === 'string') return action
  if (Array.isArray(action)) return `${action[0]?.name ?? 'anonymous'}.${action[1]}`
  return action.name || 'anonymous'
}

function routePath(pathTemplate: string, params: Record<string, string | number>) {
  const used = new Set<string>()
  let resolved = pathTemplate
  for (const [key, value] of Object.entries(params)) {
    if (!resolved.includes(`:${key}`)) continue
    resolved = resolved.replace(`:${key}`, encodeURIComponent(String(value)))
    used.add(key)
  }

  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (!used.has(key)) query.set(key, String(value))
  }
  const queryString = query.toString()
  return queryString ? `${resolved}?${queryString}` : resolved
}

function fileEtag(stat: fs.Stats) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
}

function isNotModified(headers: Record<string, any>, etag: string, mtime: Date) {
  const ifNoneMatch = firstHeaderValue(headers['if-none-match'])
  if (ifNoneMatch && ifNoneMatch.split(',').map(value => value.trim()).includes(etag)) return true

  const ifModifiedSince = firstHeaderValue(headers['if-modified-since'])
  if (!ifModifiedSince) return false
  const since = Date.parse(ifModifiedSince)
  return !Number.isNaN(since) && Math.floor(mtime.getTime() / 1000) <= Math.floor(since / 1000)
}

type ByteRange = { start: number, end: number }

function parseRangeHeader(value: string | string[] | undefined, size: number): ByteRange[] | false | undefined {
  const header = firstHeaderValue(value)
  if (!header) return undefined
  if (!header.startsWith('bytes=')) return false

  const ranges: ByteRange[] = []
  for (const part of header.slice('bytes='.length).split(',')) {
    const match = part.trim().match(/^(\d*)-(\d*)$/)
    if (!match) return false

    let start = match[1] === '' ? undefined : Number(match[1])
    let end = match[2] === '' ? undefined : Number(match[2])

    if (start === undefined && end === undefined) return false
    if (start === undefined) {
      const suffixLength = end!
      if (suffixLength <= 0) return false
      start = Math.max(size - suffixLength, 0)
      end = size - 1
    } else {
      end ??= size - 1
    }

    if (start < 0 || end < start || start >= size) return false
    ranges.push({ start, end: Math.min(end, size - 1) })
  }

  return ranges.length ? ranges : false
}

function multipartByteRanges(filePath: string, ranges: ByteRange[], boundary: string, contentType: string, size: number) {
  const file = fs.readFileSync(filePath)
  const chunks: Buffer[] = []
  for (const range of ranges) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Type: ${contentType}\r\n` +
      `Content-Range: bytes ${range.start}-${range.end}/${size}\r\n\r\n`
    ))
    chunks.push(file.subarray(range.start, range.end + 1))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

async function commitReplySession(reply: FastifyReply) {
  const session = (reply as any).session ?? (reply.request as any)?.session
  if (typeof session?.commit === 'function') await session.commit(reply)
}
