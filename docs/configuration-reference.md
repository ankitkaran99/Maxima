# Configuration Reference

Maxima loads configuration files from `src/config`. Each file exports a default object and is available through dot notation:

```typescript
import { config } from '@lib/index.js';

const appName = config('app.name');
const cacheStore = config('cache.default');
```

## Application

`config/app.ts` controls core application identity and bootstrapping:

- `name`: application name.
- `env`: active environment.
- `key`: signing and encryption key fallback.
- `url`: base URL used by URL helpers.
- `locale` and `fallback_locale`: default translation locales.
- `host` and `port`: HTTP server bind values.
- `providers`: service providers registered during boot.

## Auth

`config/auth.ts` defines guards, user providers, authentication throttling, token settings, and policies.

- `defaults.guard` and `defaults.provider`: default guard and provider names.
- `guards`: session and token guard definitions.
- `providers`: user provider implementations.
- `remember`: remember-token table and lifetime.
- `passwords`: password reset table and expiry.
- `verification`: email verification table and expiry.
- `passwordTimeout`: password confirmation timeout in seconds.
- `throttle`: login attempt limits.
- `jwt`: optional JWT issuer, audience, secret, and TTL settings.
- `policies`: model policy mappings.

## Broadcasting

`config/broadcasting.ts` defines the default broadcaster, channel auth middleware, and connection settings.

Supported connection drivers include `local`, `pusher`, `reverb`, `log`, and `null`.

## Cache

`config/cache.ts` defines the default store and configured stores.

Built-in stores include `file` and `memory`. File cache entries are stored under `storage/framework/cache` by default.

## CORS

`config/cors.ts` controls cross-origin behavior:

- `enabled`: enables Fastify CORS integration.
- `origin`: allowed origin value.
- `methods`: allowed HTTP methods.
- `credentials`: whether credentialed requests are allowed.

## CSRF

`config/csrf.ts` controls CSRF protection:

- `enabled`: enables CSRF protection.
- `except`: path patterns that skip CSRF checks.
- `cookie`: XSRF cookie name and security attributes.

## Database

`config/database.ts` defines the default Knex connection and migration/seeder paths.

The default SQLite connection uses `DB_FILENAME` when present, otherwise `storage/database.sqlite`.

## Filesystems

`config/filesystems.ts` defines the default disk, cloud disk, and configured disks.

Built-in drivers include `local`, `memory`, `null`, `ftp`, `ssh`, and `s3`.

## HTTP

`config/http.ts` currently stores proxy-related HTTP settings:

- `trustedProxies`: comma-separated trusted proxy values.

## Logging

`config/logging.ts` defines the default channel, deprecations channel, and channel list. See [Logging](./logging.md).

## Mail

`config/mail.ts` defines the default mailer, mailer transports, and default sender.

Built-in transports include `smtp`, `sendmail`, `log`, and `array`.

## Middleware

`config/middleware.ts` defines:

- `global`: middleware run on every request.
- `groups`: named stacks such as `web` and `api`.
- `aliases`: route middleware aliases.

The default aliases include cookies, sessions, CSRF, throttling, signed URLs, auth, guests, authorization, verified users, password confirmation, token abilities, and shared validation errors.

## Queue

`config/queue.ts` defines the default queue connection, connection settings, and failed-job table.

## Rate Limiting

`config/rateLimit.ts` defines global and named limiter defaults:

```typescript
export default {
  global: { enabled: true, max: 60, timeWindow: '1 minute' },
  limiters: {
    api: { max: 60, timeWindow: '1 minute' },
    login: { max: 5, timeWindow: '1 minute' }
  }
};
```

See [Rate Limiting And Security Middleware](./rate-limiting-security.md).

## Scheduler

`config/scheduler.ts` stores scheduler defaults such as timezone.

## Security

`config/security.ts` controls security headers:

- `helmet`: enables Helmet integration.
- `contentSecurityPolicy`: CSP enablement and directives.

## Services

`config/services.ts` stores third-party service credentials and URLs. The default file includes GitHub OAuth settings.

## Session

`config/session.ts` defines session storage and cookie attributes:

- `driver`: `cookie`, `memory`, `redis`, or `database`.
- `lifetime`: session lifetime in minutes.
- `cookie`: name, HTTP-only, secure, signed, encrypted, same-site, and path attributes.
- `stores`: backing store configuration.
