import { describe, expect, it } from 'vitest'
import { Application } from '@lib/foundation/Application.js'
import { hasValidRelativeSignature, hasValidSignature, signedUrl, setApplication } from '@lib/foundation/helpers.js'

describe('Security', () => {
  it('creates and verifies signed URLs', () => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('app.url', 'https://example.test')
    app.config.set('app.key', 'super-secret')

    const url = signedUrl('/verify-email', { id: 15 }, new Date(Date.now() + 60_000))

    expect(hasValidSignature(url)).toBe(true)
    expect(hasValidSignature(url.replace('id=15', 'id=16'))).toBe(false)
  })

  it('validates relative signed URLs and ignored query parameters', () => {
    const app = new Application(process.cwd())
    setApplication(app)
    app.config.set('app.url', 'https://example.test')
    app.config.set('app.key', 'super-secret')

    const url = signedUrl('/download', { id: 15 }, undefined, false)

    expect(url.startsWith('/download?')).toBe(true)
    expect(hasValidRelativeSignature(`${url}&page=2`, ['page'])).toBe(true)
    expect(hasValidSignature(`${url}&id=16`, { absolute: false })).toBe(false)
  })
})
