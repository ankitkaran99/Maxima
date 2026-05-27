# Helper Functions

Maxima provides a collection of global "helper" JavaScript functions to interact with the container, routing, views, authentication, sessions, localization, and paths.

---

## Glossary of Global Helpers

### Core & Container

- **`app(key?)`**: Resolves a service class or token from the container, or returns the primary `Application` instance if no key is provided:
  ```typescript
  const db = await app(DatabaseManager);
  ```
- **`env(key, defaultValue?)`**: Retrieves an environment variable, parsing type representations automatically:
  ```typescript
  const debug = env('APP_DEBUG', false);
  ```
- **`config(key, defaultValue?)`**: Retrieves configuration values from your config files using dot-notation:
  ```typescript
  const timezone = config('app.timezone', 'UTC');
  ```

---

### Routing & URLs

- **`route(name, params?, absolute?)`**: Generates a URL string to a named route:
  ```typescript
  const url = route('users.show', { id: 45 }); // "/users/45"
  ```
- **`signedRoute(name, params?, expiresAt?, absolute?)`**: Generates a signed URL to a named route:
  ```typescript
  const url = signedRoute('unsubscribe', { id: 45 }, new Date(Date.now() + 3600000));
  ```
- **`action(action, params?, absolute?)`**: Generates a URL to a controller action:
  ```typescript
  const url = action([UserController, 'show'], { id: 45 });
  ```
- **`url(path?, params?)`**: Generates a standard absolute URL path:
  ```typescript
  const path = url('/register', { ref: 'partner' }); // "http://localhost:3000/register?ref=partner"
  ```
- **`currentUrl()`** / **`fullUrl()`**: Retrieves the path or full URL (with query values) of the active request.
- **`previousUrl(fallback?)`**: Retrieves the referrer URL of the request.

---

### Request & Response Context

These helpers access the active HTTP request context (powered by Node's `AsyncLocalStorage` execution thread) and are only available during HTTP requests:

- **`request()`**: Accesses the current `Request` instance.
- **`response()`**: Accesses the current `Response` instance.
- **`currentRoute()`**: Retrieves the matched `Route` definition.
- **`currentRouteName()`**: Retrieves the name of the active route.
- **`currentRouteAction()`**: Retrieves the active controller method action.

---

### CSRF Protection

- **`csrf_token()`**: Generates a unique CSRF token string.
- **`csrf_field()`**: Returns a hidden HTML input containing the token:
  ```typescript
  const html = csrf_field();
  // returns '<input type="hidden" name="_token" value="abc-123...">'
  ```

---

### Assets & Views

- **`asset(path)`**: Resolves a public asset path prefixing `/assets/`:
  ```typescript
  const url = asset('css/app.css'); // "/assets/css/app.css"
  ```
- **`view(template, data?)`**: Renders a view template:
  ```typescript
  const html = await view('welcome', { name: 'Taylor' });
  ```
- **`viewExists(template)`**: Checks if a view template file exists.
- **`viewFirst(templates, data?)`**: Renders the first template that exists in a list.
- **`renderEmail(template, data?)`**: Renders a template specialized for emails.
- **`renderInline(template, data?)`**: Renders an inline template string.
- **`renderFragment(template, fragment, data?)`**: Renders a named template fragment.

See [Views And Templating](./views-templating.md) for layout, directive, composer, fragment, and cache behavior.

---

### Facades & Providers (Async Resolvers)

- **`logger()`**: Resolves a logging channel instance.
- **`auth()`**: Resolves the `AuthManager` instance.
- **`cache()`**: Resolves the `Cache` manager instance.
- **`event()`**: Resolves the `Event` dispatcher.
- **`broadcast()`**: Resolves the `Broadcast` manager.
- **`http()`**: Resolves the HTTP client manager.
- **`processRunner()`**: Resolves the process execution manager.
- **`context()`**: Resolves the async context manager.

```typescript
const client = await http();
const response = await client.get('https://api.example.com/health');

const process = await processRunner();
const result = await process.command('node', ['--version']).run();

const ctx = await context();
await ctx.run({ requestId: 'req-123' }, async () => ctx.get('requestId'));
```

---

### Path Builders

- **`base_path(...segments)`**: Resolves paths relative to the project root:
  ```typescript
  const path = base_path('storage', 'logs');
  ```
- **`app_path(...segments)`**: Resolves paths relative to the `src/app/` directory.
- **`config_path(...segments)`**: Resolves paths relative to the `src/config/` directory.
- **`database_path(...segments)`**: Resolves paths relative to `src/database/`.
- **`resource_path(...segments)`**: Resolves paths relative to `src/resources/`.
- **`storage_path(...segments)`**: Resolves paths relative to `src/storage/`.
- **`public_path(...segments)`**: Resolves paths relative to `src/public/`.

---

### Localization

- **`trans(key, options?)`** or **`__()`**: Retrieves translation strings.
- **`transChoice(key, count, options?)`**: Retrieves pluralized translation choices.
- **`setLocale(locale)`** / **`getLocale()`**: Sets or retrieves the active locale.
- **`pluralize(word, count?)`**: Returns the plural noun form of a word.
