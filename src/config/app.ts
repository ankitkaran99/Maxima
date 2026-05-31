import { env } from '@lib/index.js'
import { FrameworkServiceProvider } from '@lib/providers/FrameworkServiceProvider.js'
import { AppServiceProvider } from '@app/Providers/AppServiceProvider.js'
import { TenantServiceProvider } from '@plugins/tenant/src/index.js'

export default {
  name: env('APP_NAME', 'Maxima'),
  env: env('APP_ENV', 'local'),
  debug: env('APP_DEBUG', false),
  key: env('APP_KEY', 'maxima-secret'),
  url: env('APP_URL', 'http://127.0.0.1:3000'),
  locale: env('APP_LOCALE', 'en'),
  fallback_locale: env('APP_FALLBACK_LOCALE', 'en'),
  host: '127.0.0.1',
  port: env('APP_PORT', 3000),
  providers: [
    FrameworkServiceProvider,
    TenantServiceProvider,
    AppServiceProvider
  ]
}
