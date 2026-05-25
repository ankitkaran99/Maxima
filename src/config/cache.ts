import { env, storagePath } from '@lib/index.js'

export default {
  default: env('CACHE_STORE', 'file'),
  stores: {
    file: {
      driver: 'file',
      prefix: env('CACHE_PREFIX', 'maxima_cache'),
      path: storagePath('framework/cache')
    },
    memory: {
      driver: 'memory',
      prefix: env('CACHE_PREFIX', 'maxima_cache')
    }
  }
}
