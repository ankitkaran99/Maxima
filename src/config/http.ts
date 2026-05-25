import { env } from '@lib/index.js'

export default {
  trustedProxies: env('TRUSTED_PROXIES', '')
}
