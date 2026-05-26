import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCliCommand } from '@lib/cli/runCliCommand.js'
import { Event } from '@lib/events/Event.js'
import { Application } from '@lib/foundation/Application.js'
import {
  pluralize,
  setApplication,
  setFallbackLocale,
  setLocale,
  stringable,
  trans,
  transChoice,
  usePluralizer,
  withLocale
} from '@lib/foundation/helpers.js'
import { TranslationMissing, TranslatorInstance } from '@lib/translation/Translator.js'

class Money {
  constructor(public amount: number) {}
}

describe('Localization', () => {
  const originalBasePath = process.env.MAXIMA_BASE_PATH
  let root = ''
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxima-localization-'))
    process.env.MAXIMA_BASE_PATH = root
    const app = new Application(root)
    setApplication(app)
    app.config.set('app.locale', 'en')
    app.config.set('app.fallback_locale', 'en')
    setLocale('en')
    setFallbackLocale('en')
    usePluralizer('english')
    TranslatorInstance.forgetLoaded()
    Event.restore()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    logSpy.mockRestore()
    Event.restore()
    process.env.MAXIMA_BASE_PATH = originalBasePath
    await fs.rm(root, { recursive: true, force: true })
  })

  it('loads JSON group files, JS object group files, and root JSON keys with precedence', async () => {
    await fs.mkdir(path.join(root, 'resources', 'lang', 'en'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'lang', 'en', 'messages.json'), JSON.stringify({
      welcome: 'Group welcome :name',
      nested: { greeting: 'Hello :Name' }
    }))
    await fs.writeFile(path.join(root, 'resources', 'lang', 'en', 'admin.js'), `
      export default {
        dashboard: {
          title: 'Admin Dashboard'
        }
      }
    `)
    await fs.writeFile(path.join(root, 'resources', 'lang', 'en.json'), JSON.stringify({
      'messages.welcome': 'Root welcome :name'
    }))

    await expect(trans('messages.welcome', { name: 'ada' })).resolves.toBe('Root welcome ada')
    await expect(trans('messages.nested.greeting', { name: 'ada' })).resolves.toBe('Hello Ada')
    await expect(trans('admin.dashboard.title')).resolves.toBe('Admin Dashboard')
  })

  it('loads vendor namespace translations', async () => {
    await fs.mkdir(path.join(root, 'resources', 'lang', 'vendor', 'acme', 'en'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'lang', 'vendor', 'acme', 'en', 'messages.json'), JSON.stringify({
      shipped: 'Package shipped'
    }))

    await expect(trans('acme::messages.shipped')).resolves.toBe('Package shipped')
  })

  it('handles replacement casing and stringable replacements', async () => {
    await fs.mkdir(path.join(root, 'resources', 'lang', 'en'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'lang', 'en', 'messages.json'), JSON.stringify({
      receipt: ':Name paid :AMOUNT via :method'
    }))
    stringable(Money, money => `$${money.amount.toFixed(2)}`)

    await expect(trans('messages.receipt', {
      name: 'ada',
      amount: new Money(12.5),
      method: 'card'
    })).resolves.toBe('Ada paid $12.50 via card')
  })

  it('dispatches missing key events', async () => {
    const missing: TranslationMissing[] = []
    Event.listen(TranslationMissing, event => missing.push(event))

    await expect(trans('messages.absent')).resolves.toBe('messages.absent')

    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ key: 'messages.absent', locale: 'en', fallbackLocale: 'en' })
  })

  it('scopes locale at runtime and falls back to the configured fallback locale', async () => {
    await fs.mkdir(path.join(root, 'resources', 'lang', 'en'), { recursive: true })
    await fs.mkdir(path.join(root, 'resources', 'lang', 'fr'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'lang', 'en', 'messages.json'), JSON.stringify({
      welcome: 'Hello',
      fallback: 'Fallback'
    }))
    await fs.writeFile(path.join(root, 'resources', 'lang', 'fr', 'messages.json'), JSON.stringify({
      welcome: 'Bonjour'
    }))

    await expect(withLocale('fr', () => trans('messages.welcome'))).resolves.toBe('Bonjour')
    await expect(withLocale('fr', () => trans('messages.fallback'))).resolves.toBe('Fallback')
    await expect(trans('messages.welcome')).resolves.toBe('Hello')
  })

  it('supports ICU plural rules and pluralizer language selection', async () => {
    await fs.mkdir(path.join(root, 'resources', 'lang', 'en'), { recursive: true })
    await fs.writeFile(path.join(root, 'resources', 'lang', 'en', 'messages.json'), JSON.stringify({
      files: '{count, plural, =0 {No files} one {One file} other {# files}}'
    }))

    await expect(transChoice('messages.files', 0)).resolves.toBe('No files')
    await expect(transChoice('messages.files', 1)).resolves.toBe('One file')
    await expect(transChoice('messages.files', 5)).resolves.toBe('5 files')

    usePluralizer('spanish')
    expect(pluralize('papel')).toBe('papeles')
  })

  it('publishes default language files', async () => {
    await runCliCommand(['lang:publish'])

    expect(fsSync.existsSync(path.join(root, 'src', 'resources', 'lang', 'en', 'validation.json'))).toBe(true)
    expect(fsSync.existsSync(path.join(root, 'src', 'resources', 'lang', 'en', 'messages.json'))).toBe(true)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Language files published'))
  })
})
