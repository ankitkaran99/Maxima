import { env } from '@lib/index.js'

export default {
  enabled: true,
  origin: env('CORS_ORIGIN', '*'),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true
}
