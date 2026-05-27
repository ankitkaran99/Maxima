# Testing

Maxima ships Vitest-friendly test helpers for database assertions, HTTP responses, authentication state, time travel, framework fakes, console commands, browser-like assertions, snapshots, and views.

```typescript
import {
  actingAs,
  assertDatabaseCount,
  assertDatabaseHas,
  assertDatabaseMissing,
  expectResponse,
  fakeFramework,
  restoreFrameworkFakes,
  travel,
  travelBack,
  travelTo
} from '@lib/index.js';
```

## Database Assertions

```typescript
await assertDatabaseHas('users', { email: 'ada@example.com' });
await assertDatabaseMissing('users', { email: 'missing@example.com' });
await assertDatabaseCount('users', 1);
```

## HTTP Response Assertions

Wrap a Fastify injected response or response-like object with `expectResponse()`.

```typescript
expectResponse(response)
  .assertStatus(200)
  .assertOk()
  .assertJson({ ok: true })
  .assertJsonPath('user.name', 'Ada')
  .assertHeader('content-type');
```

Available assertions include `assertCreated()`, `assertNoContent()`, `assertForbidden()`, `assertNotFound()`, `assertUnauthorized()`, `assertUnprocessable()`, `assertSuccessful()`, `assertServerError()`, `assertJsonFragment()`, `assertJsonMissing()`, `assertJsonCount()`, `assertSee()`, `assertDontSee()`, `assertRedirect()`, `assertHeaderMissing()`, `assertCookie()`, and `assertCookieMissing()`.

## Authentication

Use `actingAs()` or `be()` to set the current authenticated test user.

```typescript
const request = actingAs({ id: 10, name: 'Ada' }, 'admin');

expect(request.session.get('auth_admin_id')).toBe(10);
```

## Middleware And Exception Handling

Temporarily disable middleware or exception handling for a test:

```typescript
const restoreMiddleware = withoutMiddleware(app);
const restoreExceptions = withoutExceptionHandling(app);

restoreMiddleware();
restoreExceptions();
```

Pass a middleware alias or list to disable only selected middleware.

## Time Travel

```typescript
travelTo('2026-05-26T10:00:00Z');
travel(1000);
travelBack();
```

Time helpers wrap Vitest fake timers.

## Framework Fakes

`fakeFramework()` fakes events, queues, bus dispatching, mail, notifications, storage, cache, logs, HTTP, and processes.

```typescript
fakeFramework();

// run code under test

restoreFrameworkFakes();
```

Use individual fake/assert APIs from the relevant managers when a test needs finer control.

## Console Testing

Run CLI commands and assert their output:

```typescript
const output = await artisan(['env']);

output
  .assertSuccessful()
  .expectsOutput('local')
  .doesntExpectOutput('production');
```

`ConsoleResult` also exposes `assertExitCode()` and `assertFailed()`.

## Browser Assertions

The lightweight `browse()` helper supports HTML-string assertions:

```typescript
await browse(async browser => {
  await browser.visit('<main>Dashboard</main>');
  browser.assertSee('Dashboard').assertDontSee('Login');
});
```

## Database Isolation, Seeding, And Factories

```typescript
await refreshDatabase(async () => {
  await DB.table('users').insert({ name: 'Temporary' });
});

await seed(DatabaseSeeder);

const user = await factory(UserFactory, undefined, { role: 'admin' });
```

`withParallelIsolation()` passes the current parallel testing token to a callback.

## Snapshots And Views

```typescript
await assertMatchesSnapshot('payload', { ok: true });

await assertViewIs('card', { title: 'Hello' }, 'Hello');
await assertViewHas('card', { title: 'Hello' }, 'title', 'Hello');
```
