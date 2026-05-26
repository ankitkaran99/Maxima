import crypto from 'node:crypto'
import { config } from '@lib/foundation/helpers.js'

export type OAuthProviderConfig = {
  clientId: string
  clientSecret: string
  redirect: string
  authorizeUrl: string
  tokenUrl: string
  userUrl: string
  scopes?: string[]
}

export class OAuthManager {
  private statelessMode = false

  driver(name: string) {
    const provider = config<OAuthProviderConfig>(`services.${name}`)
    if (!provider) throw new Error(`OAuth provider [${name}] is not configured.`)
    return new OAuthProvider(name, provider, this.statelessMode)
  }

  stateless() {
    this.statelessMode = true
    return this
  }
}

export class OAuthProvider {
  constructor(private name: string, private provider: OAuthProviderConfig, private statelessMode = false) {}

  redirect(state = crypto.randomBytes(16).toString('hex')) {
    const url = new URL(this.provider.authorizeUrl)
    url.searchParams.set('client_id', this.provider.clientId)
    url.searchParams.set('redirect_uri', this.provider.redirect)
    url.searchParams.set('response_type', 'code')
    if (this.provider.scopes?.length) url.searchParams.set('scope', this.provider.scopes.join(' '))
    if (!this.statelessMode) url.searchParams.set('state', state)
    return url.toString()
  }

  async user(code: string) {
    const tokenResponse = await fetch(this.provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.provider.clientId,
        client_secret: this.provider.clientSecret,
        redirect_uri: this.provider.redirect,
        code
      })
    })
    const token = await tokenResponse.json() as Record<string, any>
    const accessToken = token.access_token
    const userResponse = await fetch(this.provider.userUrl, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
    })
    const user = await userResponse.json() as Record<string, any>
    return { provider: this.name, token, user }
  }
}

export const OAuth = new OAuthManager()
