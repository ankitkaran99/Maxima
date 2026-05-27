# Routing & Middleware

Maxima provides a powerful, fluent routing API inspired directly by Laravel. Under the hood, Maxima integrates with Fastify for performance while keeping the routing definitions expressive.

---

## Basic Routing

Routes are defined in the `routes/web.ts` or `routes/api.ts` files using the `Route` facade. A route accepts a URL pattern and a handler (either a closure or a controller action).

### Standard Route Methods

```typescript
import { Route } from '@lib/http/Route.js';

// GET route returning a JSON object or string
Route.get('/welcome', () => {
  return { message: 'Welcome to Maxima!' };
});

// POST route
Route.post('/posts', (request) => {
  return { status: 'created', data: request.body() };
});

// Common HTTP verbs supported:
Route.put('/posts/:id', (request) => { /* ... */ });
Route.patch('/posts/:id', (request) => { /* ... */ });
Route.delete('/posts/:id', (request) => { /* ... */ });
Route.options('/posts', () => { return { status: 'ok' }; });
```

### Match & Any Routing
If a route needs to support multiple HTTP verbs, use `Route.match` or `Route.any`:
```typescript
// Support specific HTTP verbs
Route.match(['GET', 'POST'], '/submit', (request) => {
  return { method: request.method() };
});

// Support all HTTP verbs
Route.any('/fallback', (request) => {
  return { fallback: true, method: request.method() };
});
```

---

## Route Parameters & Constraints

Route parameters are defined with a colon (`:`) prefix. They are made available on the request params bag.

```typescript
Route.get('/users/:id/posts/:post_id', (request) => {
  const userId = request.params.id;
  const postId = request.params.post_id;
  return { userId, postId };
});
```

### Parameter constraints

You can restrict the format of route parameters using regular expression constraints. Maxima includes several fluent helper methods:

```typescript
// Match order parameter as digits only ([0-9]+)
Route.get('/orders/:order', (request) => {
  return { orderId: request.params.order };
}).whereNumber('order');

// Match category parameter as letters only ([A-Za-z]+)
Route.get('/category/:category', () => { /* ... */ }).whereAlpha('category');

// Match slug parameter as alphanumeric characters ([A-Za-z0-9]+)
Route.get('/tag/:slug', () => { /* ... */ }).whereAlphaNumeric('slug');

// Match item parameter to a UUID structure
Route.get('/items/:item', () => { /* ... */ }).whereUuid('item');

// Match role to a specific list of values
Route.get('/users/role/:role', () => { /* ... */ }).whereIn('role', ['admin', 'manager', 'user']);

// Custom regex constraint
Route.get('/code/:code', () => { /* ... */ }).where('code', '[A-Z]{3}-[0-9]{3}');
```

---

## Route Model Binding

Maxima features implicit Route Model Binding. When you register model names in the `SerializableModelRegistry`, Maxima automatically resolves matching model instances from database queries based on the route parameter name.

### Implicit Route Model Binding

If you define a route parameter containing the name of a registered model class (e.g. `:post` for the `Post` model), Maxima will query the database by the record's primary key (`id`):

```typescript
// 1. SerializableModelRegistry resolves 'post' to Post model
Route.get('/posts/:post', (request) => {
  // request.params.post is automatically loaded as a Post model instance!
  const post = request.params.post;
  return { title: post.title, body: post.body };
});
```

If the record is not found in the database, a `404` error is automatically thrown.

### Custom Route Keys

If you want route model binding to resolve models using a column other than `id`, override the `routeKeyName` property in your Model class:

```typescript
export class Post extends Model {
  // Bind models using slug column instead of id
  static routeKeyName = 'slug';
}
```

### Customizing Missing Model Responses

You can define custom behavior if a model record cannot be found by chaining the `.missing()` helper:

```typescript
Route.get('/posts/:post', (request) => {
  return { post: request.params.post.title };
})
.missing((request) => {
  return { error: 'The requested post was not found in our catalog.' };
});
```

### Scoped Bindings

When nesting multiple model bindings inside a single route, you can choose to scope the child binding to ensure it belongs to the parent (e.g. validating that `:post` belongs to `:user`). Chain the `.scopeBindings()` helper:

```typescript
// This ensures that the Post has a user_id matching the User's id
Route.get('/users/:user/posts/:post', (request) => {
  return {
    author: request.params.user.name,
    post: request.params.post.title
  };
})
.scopeBindings();
```

---

## Fallback Routes

Using the `Route.fallback` method, you can define a route that will be executed when no other route matches the incoming request:

```typescript
Route.fallback((request) => {
  return { error: 'Endpoint does not exist.' };
});
```

---

## Named Routes

Named routes allow the convenient generation of URLs or redirects. You can chain the `.name()` method to assign a unique name to a route:

```typescript
Route.get('/user/profile', () => {
  return 'Profile page';
}).name('profile');
```

### Generating URLs to Named Routes

Use the global `route()` helper to generate URLs for named routes. If the route defines parameters, pass them as the second argument:

```typescript
import { route } from '@lib/foundation/helpers.js';

// Simple URL generation
const url = route('profile'); // "/user/profile"

// With route parameters
Route.get('/users/:id', () => {}).name('users.show');
const userUrl = route('users.show', { id: 42 }); // "/users/42"
const userUrlPositional = route('users.show', 42); // "/users/42"

// With query parameters (passed inside `_query` or as extra keys)
const queryUrl = route('users.show', { id: 42, tab: 'activity' }); 
// "/users/42?tab=activity"
```

---

## Route Groups

Route groups allow you to share route attributes, such as URI prefixes, middleware, and names, across a large number of routes without needing to define them on every single route.

```typescript
Route.group({ prefix: '/admin', middleware: ['auth'], name: 'admin.' }, () => {
  // Path: /admin/dashboard, Name: admin.dashboard, Middleware: ['auth']
  Route.get('/dashboard', () => {
    return { title: 'Admin Dashboard' };
  }).name('dashboard');

  // Path: /admin/settings, Name: admin.settings, Middleware: ['auth']
  Route.get('/settings', () => {
    return { title: 'Settings' };
  }).name('settings');
});
```

### Controller Groups
If a group of routes all use the same Controller, you can declare it at the group level and only reference method names inside the routes:

```typescript
import { UserController } from '../app/Http/Controllers/UserController.js';

Route.group({ controller: UserController, prefix: '/users' }, () => {
  Route.get('/', 'index');     // Resolves to UserController.index
  Route.get('/:id', 'show');   // Resolves to UserController.show
});
```

---

## Signed URLs

Signed URLs are useful for links that should only be accessible if they have not been modified. Maxima lets you generate signed URLs easily:

```typescript
import { signedRoute, hasValidSignature } from '@lib/foundation/helpers.js';

// 1. Generate a signed URL
const url = signedRoute('unsubscribe', { user: 12 }); 
// returns "/unsubscribe?user=12&signature=..."

// 2. Validate a signature inside a route
Route.get('/unsubscribe', (request) => {
  if (!hasValidSignature(request.url())) {
    throw new Error('Invalid or expired signature.');
  }
  return { status: 'Unsubscribed successfully' };
}).name('unsubscribe');
```

---

## Middleware

Middleware provides a convenient mechanism for inspecting and filtering HTTP requests entering your application.

### Creating a Middleware

A middleware is a class that implements a `handle(request, reply, next)` method:

```typescript
export class EnsureTokenIsValid {
  async handle(request, reply, next) {
    const token = request.header('x-api-token');

    if (token !== 'secret-token') {
      return reply.code(401).send({ error: 'Unauthorized token' });
    }

    // Call next() to pass the request further down the pipeline
    await next();
  }
}
```

### Registering Middleware

Middleware is registered in the application's configuration files (typically `src/config/middleware.ts`):

```typescript
import { EnsureTokenIsValid } from '../app/Http/Middleware/EnsureTokenIsValid.js';

export default {
  // Middleware run on every HTTP request to your application
  global: [
    // ...
  ],

  // Grouped middleware lists (e.g. for web/api separate stacks)
  groups: {
    web: [
      'session',
      'shareErrorsFromSession',
    ],
    api: [
      'throttle',
    ]
  },

  // Direct middleware aliases for route binding
  aliases: {
    auth: AuthenticateMiddleware,
    token: EnsureTokenIsValid,
  }
};
```

### Assigning Middleware to Routes

You can assign middleware to individual routes or route groups:

```typescript
// Single middleware
Route.get('/profile', () => { /* ... */ }).middleware('auth');

// Multiple middleware
Route.get('/metrics', () => { /* ... */ }).middleware(['auth', 'token']);
```

For built-in `cookies`, `session`, `csrf`, `throttle`, and `signed` middleware behavior, see [Rate Limiting And Security Middleware](./rate-limiting-security.md).

### Excluding Middleware

If you want to exclude middleware from a group for a specific route:

```typescript
Route.group({ middleware: ['auth'] }, () => {
  Route.get('/profile', () => { /* ... */ });

  // Exclude 'auth' middleware for this specific public path
  Route.get('/public-profile', () => { /* ... */ }).withoutMiddleware('auth');
});
```

---

## Route Caching

For large projects, compiling routes on every boot can slow startup times. You can cache your compiled routes using the CLI:

```bash
# Cache all routes to routes.json
npm run maxima -- route:cache

# Clear the route cache
npm run maxima -- route:clear
```
When a cached route configuration exists, Maxima skips route file parsing and boots routes directly from the cache.
