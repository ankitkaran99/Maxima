# HTTP Client

Maxima includes a fluent HTTP client built on top of the platform `fetch` API. Import the shared `Http` manager from `@lib/index.js` or resolve it through the async `http()` helper.

```typescript
import { Http } from '@lib/index.js';

const response = await Http
  .baseUrl('https://api.example.com')
  .withToken('api-token')
  .asJson()
  .get('/users', { page: 1 });

if (response.successful()) {
  const users = response.json();
}
```

## Requests

The client exposes the common HTTP verbs through `Http` and `PendingRequest` instances:

```typescript
await Http.get('https://api.example.com/health');
await Http.post('https://api.example.com/users', { name: 'Ada' });
await Http.put('https://api.example.com/users/1', { name: 'Grace' });
await Http.patch('https://api.example.com/users/1', { active: true });
await Http.delete('https://api.example.com/users/1');
```

Use fluent configuration methods before sending the request:

```typescript
const response = await Http
  .baseUrl('https://api.example.com')
  .withHeaders({ 'X-Client': 'maxima' })
  .accept('application/json')
  .asJson()
  .withToken('token')
  .withBasicAuth('user', 'secret')
  .timeout(5)
  .retry(3, 100)
  .withOptions({ cache: 'no-store' })
  .get('/reports');
```

`timeout()` accepts seconds. `retry(times, sleepMilliseconds)` retries failed responses until the attempt budget is exhausted.

## Middleware

Request middleware can wrap dispatch. Middleware receives the pending request and a `next` callback.

```typescript
const response = await Http
  .withMiddleware(async (request, next) => {
    const started = Date.now();
    const response = await next();
    console.log('HTTP duration', Date.now() - started);
    return response;
  })
  .get('https://api.example.com/status');
```

## Responses

`HttpClientResponse` provides status, body, header, and error helpers:

```typescript
const response = await Http.get('https://api.example.com/users/1');

response.ok();
response.successful();
response.failed();
response.clientError();
response.serverError();
response.status();
response.text();
response.bodyText();
response.json();
response.object();
response.header('content-type');
response.throw();
```

`throw()` raises an error when the response failed, otherwise it returns the same response.

## Concurrent Pools

Use `pool()` to name and run multiple requests concurrently:

```typescript
const responses = await Http.baseUrl('https://api.example.com').pool(pool => {
  pool.as('users').get('/users');
  pool.as('posts').get('/posts');
});

const users = responses.users.json();
const posts = responses.posts.json();
```

## Testing And Fakes

`Http.fake()` replaces network dispatch with fake responses and records all attempted requests.

```typescript
import { Http, HttpClientResponse } from '@lib/index.js';

Http.fake({
  'https://api.example.com/users*': [{ id: 1, name: 'Ada' }],
  'https://api.example.com/down': new HttpClientResponse(503, 'Unavailable'),
  '*': { ok: true }
});

await Http.get('https://api.example.com/users?page=1');

Http.assertSent(request =>
  request.method === 'GET' &&
  request.url.includes('/users') &&
  request.headers instanceof Headers
);

Http.restore();
```

Sequences are useful when the same URL should return different responses over time:

```typescript
const sequence = Http.sequence()
  .push({ status: 'queued' })
  .push({ status: 'done' })
  .whenEmpty(new HttpClientResponse(404, ''));

Http.fake({ 'https://api.example.com/jobs/1': sequence });
```

`assertNothingSent()` fails if any request was recorded, and `recorded()` returns the recorded request list.

## Macros

The HTTP client is macroable. Macros are available on pending requests.

```typescript
Http.macro('github', function() {
  return this.baseUrl('https://api.github.com').accept('application/json');
});

const response = await (Http.pending() as any).github().get('/repos/example/project');
Http.flushMacros();
```
