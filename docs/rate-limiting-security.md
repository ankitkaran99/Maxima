# Rate Limiting And Security Middleware

Maxima includes a global rate limiter as well as named route-level limiters and built-in security middleware aliases.

## Global Rate Limiting

By default, Maxima registers a global rate limiter that applies to all incoming requests. This provides base protection for your application out-of-the-box.

The global rate limiter can be configured or disabled in `src/config/rateLimit.ts` via the `global` options:

- `enabled`: Toggle global rate limiting. Defaults to `true`. Can be set via the `RATE_LIMIT_ENABLED` environment variable.
- `max`: The maximum number of requests allowed. Defaults to `60`. Can be set via the `RATE_LIMIT_MAX` environment variable.
- `timeWindow`: The duration of the rate limit window. Defaults to `1 minute`. Can be set via the `RATE_LIMIT_WINDOW` environment variable.

Example `.env` configuration for local development or benchmarking:
```env
# Disable global rate limiting
RATE_LIMIT_ENABLED=false

# Or increase the threshold
RATE_LIMIT_MAX=5000
RATE_LIMIT_WINDOW="1 minute"
```

## Route-Level Named Limiters

To define specific limiters for routes, import the helpers:
```typescript
import { Limit, RateLimiter } from '@lib/http/RateLimiter.js';
```

## Defining Limiters

Register named limiters during application boot, usually in a service provider.

```typescript
RateLimiter.for('api', request => {
  return Limit.perMinute(60).by(
    request.user() ? `user:${request.user().id}` : `ip:${request.ip()}`
  );
});
```

Limiter callbacks may return a single `RateLimit`, an array of limits, `null`, or `undefined`. Returning `null` or `undefined` skips rate limiting for that request.

## Limit Helpers

```typescript
Limit.perSecond(10);
Limit.perMinute(60);
Limit.perHour(1000);
Limit.perDay(5000);
Limit.per(30, 100);
Limit.none();
```

Use `by()` to choose the rate-limit key and `response()` to customize the throttled response.

```typescript
RateLimiter.for('uploads', request => {
  return Limit
    .perMinute(10)
    .by(`user:${request.user()?.id ?? request.ip()}`)
    .response((_request, headers) => ({
      message: 'Upload limit reached.',
      retryAfter: headers['Retry-After']
    }));
});
```

## Route Middleware

Attach named limiters through the `throttle` middleware alias:

```typescript
Route.get('/api/users', handler).middleware('throttle:api');
Route.post('/login', handler).middleware('throttle:login');
```

If no named limiter is registered, `ThrottleMiddleware` falls back to `config/rateLimit.ts` or parses Laravel-style route parameters such as `throttle:60,1`.

Throttled responses return HTTP `429` and include:

- `Retry-After`
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`

## Manual Attempts API

The `RateLimiter` manager can also track attempts manually using the cache store.

```typescript
await RateLimiter.hit('login:ada@example.com', 60);

if (await RateLimiter.tooManyAttempts('login:ada@example.com', 5)) {
  const seconds = await RateLimiter.availableIn('login:ada@example.com');
}

const remaining = await RateLimiter.remaining('login:ada@example.com', 5);
await RateLimiter.clearAttempts('login:ada@example.com');
```

Available methods include `hit()`, `attempts()`, `tooManyAttempts()`, `remaining()`, `availableIn()`, `resetAttempts()`, `clearAttempts()`, and `reset()`.

## Built-In Security Middleware

Default aliases are configured in `config/middleware.ts`.

- `cookies`: adds `request.cookie(name, options?)` for signed or encrypted cookie decoding.
- `session`: starts the configured session driver and attaches the session to the request.
- `csrf`: rejects unsafe requests with invalid CSRF tokens.
- `throttle`: applies named or inline rate limits.
- `signed`: validates signed URLs.

## CSRF

The CSRF middleware allows `GET`, `HEAD`, and `OPTIONS`. Other methods must provide a token matching the session `_csrf` value through `x-csrf-token` or `_token`.

```typescript
Route.post('/profile', handler).middleware('csrf');
```

The helper `csrf_field()` renders a hidden `_token` input, and `csrf_token()` generates a token value.

## Signed URLs

Use signed route helpers with the `signed` middleware:

```typescript
const url = signedRoute('unsubscribe', { user: 1 }, new Date(Date.now() + 3600000));

Route.get('/unsubscribe', handler)
  .name('unsubscribe')
  .middleware('signed');
```

Invalid or expired signatures return HTTP `403`.
