import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Event } from '@lib/events/Event.js'
import { basePath, resourcePath } from '@lib/support/paths.js'

export type TranslationOptions = Record<string, unknown> & {
  locale?: string
  fallbackLocale?: string
  count?: number
}

export class TranslationMissing {
  constructor(
    public key: string,
    public locale: string,
    public fallbackLocale?: string
  ) {}
}

type StringableHandler = { match: (value: unknown) => boolean, format: (value: unknown) => string }

export class Translator {
  private locale = process.env.APP_LOCALE ?? 'en'
  private fallbackLocale = process.env.APP_FALLBACK_LOCALE ?? 'en'
  private cache = new Map<string, Record<string, unknown>>()
  private stringables: StringableHandler[] = []
  private scopedLocale = new AsyncLocalStorage<string>()
  private pluralizerLanguage = 'english'

  getLocale() {
    return this.scopedLocale.getStore() ?? this.locale
  }

  hasScopedLocale() {
    return this.scopedLocale.getStore() !== undefined
  }

  setLocale(locale: string) {
    this.locale = locale
    return this
  }

  getFallbackLocale() {
    return this.fallbackLocale
  }

  setFallbackLocale(locale: string) {
    this.fallbackLocale = locale
    return this
  }

  withLocale<T>(locale: string, callback: () => T) {
    return this.scopedLocale.run(locale, callback)
  }

  stringable(match: Function | ((value: unknown) => boolean), formatter?: (value: any) => string) {
    if (formatter) {
      this.stringables.push({
        match: value => typeof match === 'function' && value instanceof (match as any),
        format: formatter as (value: unknown) => string
      })
      return this
    }

    this.stringables.push({ match: match as (value: unknown) => boolean, format: value => String(value) })
    return this
  }

  usePluralizer(language: string) {
    this.pluralizerLanguage = language
    return this
  }

  pluralize(word: string, count = 2) {
    if (count === 1) return word
    const lower = word.toLowerCase()
    if (this.pluralizerLanguage === 'spanish') {
      if (/[aeiou]$/i.test(word)) return `${word}s`
      return `${word}es`
    }
    if (lower.endsWith('y') && !/[aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`
    if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`
    return `${word}s`
  }

  async get(key: string, options: TranslationOptions = {}) {
    const locale = String(options.locale ?? this.getLocale())
    const fallbackLocale = String(options.fallbackLocale ?? this.getFallbackLocale())
    const locales = [...new Set([locale, fallbackLocale].filter(Boolean))]

    for (const candidate of locales) {
      const value = await this.lookup(candidate, key)
      if (value !== undefined) return this.replace(String(value), options)
    }

    Event.dispatch(new TranslationMissing(key, locale, fallbackLocale))
    return key
  }

  async choice(key: string, count: number, options: TranslationOptions = {}) {
    const values = { ...options, count }
    const locale = String(values.locale ?? this.getLocale())
    const fallbackLocale = String(values.fallbackLocale ?? this.getFallbackLocale())
    const locales = [...new Set([locale, fallbackLocale].filter(Boolean))]

    for (const candidate of locales) {
      const value = await this.lookup(candidate, key)
      if (value !== undefined) return this.replace(this.choose(String(value), count, candidate), values)
    }

    Event.dispatch(new TranslationMissing(key, locale, fallbackLocale))
    return key
  }

  forgetLoaded() {
    this.cache.clear()
  }

  private async lookup(locale: string, key: string) {
    const rootValue = await this.lookupRootJson(locale, key)
    if (rootValue !== undefined) return rootValue

    const { namespace, group, segments } = this.parseKey(key)
    if (!group) return undefined
    const messages = await this.loadGroup(locale, group, namespace)
    if (!messages) return undefined
    if (!segments.length) return messages[group] ?? messages[key]
    return this.getNestedValue(messages, segments) ?? messages[key]
  }

  private parseKey(key: string) {
    const namespaceSplit = key.split('::')
    const namespace = namespaceSplit.length > 1 ? namespaceSplit[0] : undefined
    const namespacedKey = namespaceSplit.length > 1 ? namespaceSplit.slice(1).join('::') : key
    const [group, ...segments] = namespacedKey.split('.')
    return { namespace, group, segments }
  }

  private async lookupRootJson(locale: string, key: string) {
    for (const root of this.langRoots()) {
      const file = path.join(root, locale, `${locale}.json`)
      const flatFile = path.join(root, `${locale}.json`)
      for (const candidate of [file, flatFile]) {
        const messages = await this.loadFile(candidate)
        if (messages && Object.prototype.hasOwnProperty.call(messages, key)) return messages[key]
      }
    }
    return undefined
  }

  private async loadGroup(locale: string, group: string, namespace?: string) {
    for (const file of this.groupFileCandidates(locale, group, namespace)) {
      const messages = await this.loadFile(file)
      if (messages) return messages
    }
    return undefined
  }

  private groupFileCandidates(locale: string, group: string, namespace?: string) {
    const files: string[] = []
    for (const root of this.langRoots()) {
      const base = namespace ? path.join(root, 'vendor', namespace, locale) : path.join(root, locale)
      for (const extension of ['json', 'js', 'ts']) files.push(path.join(base, `${group}.${extension}`))
    }
    return files
  }

  private async loadFile(file: string) {
    if (!fsSync.existsSync(file)) return undefined
    const stat = await fs.stat(file)
    const cacheKey = `${file}:${stat.mtimeMs}`
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)

    let value: Record<string, unknown> | undefined
    try {
      if (file.endsWith('.json')) {
        value = JSON.parse(await fs.readFile(file, 'utf8'))
      } else if (file.endsWith('.js') || file.endsWith('.ts')) {
        const mod = await import(`${pathToFileURL(file).href}?t=${stat.mtimeMs}`)
        value = mod.default ?? mod.messages ?? mod.translations
      }
    } catch {
      value = undefined
    }

    if (value && typeof value === 'object') this.cache.set(cacheKey, value)
    return value
  }

  private langRoots() {
    return [...new Set([
      path.join(basePath(), 'resources', 'lang'),
      path.join(basePath(), 'src', 'resources', 'lang'),
      resourcePath('lang'),
      path.resolve(process.cwd(), 'src', 'resources', 'lang'),
      path.resolve(process.cwd(), 'resources', 'lang')
    ])]
  }

  private getNestedValue(source: Record<string, unknown>, segments: string[]) {
    let current: unknown = source
    for (const segment of segments) {
      if (!current || typeof current !== 'object' || !(segment in current)) return undefined
      current = (current as Record<string, unknown>)[segment]
    }
    return typeof current === 'string' || typeof current === 'number' ? current : undefined
  }

  private replace(message: string, options: Record<string, unknown>) {
    return Object.entries(options).reduce((output, [key, value]) => {
      if (['locale', 'fallbackLocale'].includes(key)) return output
      const formatted = this.formatReplacement(value)
      return output
        .replaceAll(`:${key.toUpperCase()}`, formatted.toUpperCase())
        .replaceAll(`:${capitalize(key)}`, capitalize(formatted))
        .replaceAll(`:${key}`, formatted)
        .replaceAll(`{{ ${key} }}`, formatted)
        .replaceAll(`{{${key}}}`, formatted)
    }, message)
  }

  private formatReplacement(value: unknown) {
    for (const handler of this.stringables) {
      if (handler.match(value)) return handler.format(value)
    }
    return String(value ?? '')
  }

  private choose(message: string, count: number, locale: string) {
    const icu = this.chooseIcu(message, count, locale)
    if (icu !== undefined) return icu

    const segments = message.split('|').map(segment => segment.trim())
    if (segments.length === 1) return message

    for (const segment of segments) {
      const exact = segment.match(/^\{(-?\d+)\}\s*(.*)$/)
      if (exact && Number(exact[1]) === count) return exact[2]

      const range = segment.match(/^\[(-?\d+|\*),\s*(-?\d+|\*)]\s*(.*)$/)
      if (range) {
        const min = range[1] === '*' ? -Infinity : Number(range[1])
        const max = range[2] === '*' ? Infinity : Number(range[2])
        if (count >= min && count <= max) return range[3]
      }
    }

    return count === 1 ? segments[0] : segments[segments.length - 1]
  }

  private chooseIcu(message: string, count: number, locale: string) {
    const match = message.match(/^\s*\{\s*\w+\s*,\s*plural\s*,([\s\S]+)\}\s*$/)
    if (!match) return undefined
    const cases = new Map<string, string>()
    const casePattern = /(=\-?\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g
    for (const item of match[1].matchAll(casePattern)) cases.set(item[1], item[2])
    const exact = cases.get(`=${count}`)
    if (exact !== undefined) return exact.replaceAll('#', String(count))
    const category = new Intl.PluralRules(locale).select(count)
    return (cases.get(category) ?? cases.get('other') ?? '').replaceAll('#', String(count))
  }
}

function capitalize(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value
}

export const TranslatorInstance = new Translator()
