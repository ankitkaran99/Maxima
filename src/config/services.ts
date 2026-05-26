import { env } from '@lib/index.js'

export default {
  github: {
    clientId: env('GITHUB_CLIENT_ID', ''),
    clientSecret: env('GITHUB_CLIENT_SECRET', ''),
    redirect: env('GITHUB_REDIRECT_URI', 'http://127.0.0.1:3000/auth/github/callback'),
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email']
  }
}
