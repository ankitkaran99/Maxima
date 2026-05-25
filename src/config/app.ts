import { env } from '@lib/index.js'
import { FrameworkServiceProvider } from '@lib/providers/FrameworkServiceProvider.js'
import { AppServiceProvider } from '@app/Providers/AppServiceProvider.js'

export default {
  name: env('APP_NAME', 'Maxima'),
  env: env('APP_ENV', 'local'),
  key: env('APP_KEY', 'maxima-secret'),
  url: env('APP_URL', 'http://127.0.0.1:3000'),
  host: '127.0.0.1',
  port: env('APP_PORT', 3000),
  providers: [
    FrameworkServiceProvider,
    AppServiceProvider
  ]
}
