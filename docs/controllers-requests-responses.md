# Controllers, Requests, & Responses

In Maxima, HTTP requests are handled by Controllers. These controllers receive incoming HTTP Requests, interact with models or services, and return Responses.

---

## Controllers

Controllers group related request handling logic into a single class. They are placed in the `src/app/Http/Controllers/` directory.

### Basic Controller

A Controller is a class that optionally inherits from the framework's base `Controller` class (which provides authorization helpers).

```typescript
import { Controller } from '@lib/http/Controller.js';
import { Request } from '@lib/http/Request.js';

export class UserController extends Controller {
  // Method to list users
  async index(request: Request) {
    return { users: [] };
  }

  // Method to show a specific user
  async show(request: Request) {
    const id = request.params.id;
    return { user: { id } };
  }
}
```

### Dependency Injection in Controllers

Maxima supports automatic dependency injection via the Container. 

#### Constructor Injection
Declare a `static inject` property containing the list of classes or tokens you want to inject into the constructor:

```typescript
import { Controller } from '@lib/http/Controller.js';
import { UserService } from '../../Services/UserService.js';

export class UserController extends Controller {
  static inject = [UserService];

  constructor(private userService: UserService) {
    super();
  }

  async index() {
    const users = await this.userService.getAllUsers();
    return { users };
  }
}
```

#### Method-level Injection
If you only need a dependency for a specific controller action, you can inject it directly into the method arguments using `static injectMethods`:

```typescript
import { DummyService } from '../../Services/DummyService.js';
import { Request } from '@lib/http/Request.js';
import { Response } from '@lib/http/Response.js';

export class InlineController {
  // Define method parameter injection map
  static injectMethods = {
    myMethod: [DummyService, Request, Response]
  };

  async myMethod(service: DummyService, request: Request, response: Response) {
    return response.json({
      value: service.getValue(),
      param: request.query.name
    });
  }
}
```

---

## Requests

The Maxima `Request` class wraps the raw Fastify request and provides clean input collection, cast wrappers, and helper methods.

### Accessing Request Input

Use the `input()` method to retrieve values regardless of where they came from (query parameters, JSON body, or route parameters):

```typescript
// Retrieves key or returns default if not found
const search = request.input('search', 'default-value');
```

To fetch everything or a subset of parameters:
```typescript
// Get all input fields merged
const all = request.all(); // { id: 1, name: 'Taylor' }

// Get only specific fields
const queryOnly = request.only(['name', 'email']);

// Get all fields except specified fields
const postData = request.except(['_token']);
```

### Typed Input Casts

Instead of manually converting input types, use typed helpers:

```typescript
// Returns boolean (handles true, 'true', 1, '1', 'on')
const isActive = request.boolean('active');

// Returns integer
const page = request.integer('page'); // 1

// Returns float
const amount = request.float('amount'); // 12.50

// Returns Date object
const startsAt = request.date('starts_at');

// Returns array (wraps single value in array if not already an array)
const tags = request.array('tags'); // ['js', 'ts']
```

### Enumeration Helpers
Ensure input matches a specific set of allowed values or enum members:

```typescript
enum UserRole {
  Admin = 'admin',
  User = 'user'
}

const role = request.enum('role', UserRole, UserRole.User);
```

Use `enums()` when the input may contain multiple enum values:

```typescript
const roles = request.enums('roles', UserRole);
```

### Uploaded Files

Multipart uploads are available through `file()` and `files()`. Nested keys and repeated file inputs are normalized before lookup.

```typescript
const avatar = request.file('avatar');
const gallery = request.files('gallery');

if (avatar) {
  await avatar.storePublicly('avatars');
}
```

See [Uploaded Files](./uploaded-files.md) for file metadata and storage helpers.

### Flash Data And Validation State

Requests can flash input and validation errors into the active session:

```typescript
request.flash();
request.flashOnly(['email']);
request.flashExcept(['password']);

const oldEmail = request.old('email');

request.flashErrors({ email: ['Invalid email address.'] });
request.setErrors({ email: ['Invalid email address.'] });
request.firstError('email');
request.hasError('email');
```

After validation, access the validated payload through `validated()` or the safe `ValidatedInput` wrapper:

```typescript
const data = await request.validate({
  email: schema.string().email()
});

const validated = request.validated();
const safe = request.safe().only(['email']);
```

### Request Macros

You can extend the `Request` class dynamically using macros:

```typescript
import { Request } from '@lib/http/Request.js';

// Define a macro
Request.macro('isLocal', function(this: Request) {
  return this.input('host') === 'localhost';
});

// Use it inside a route or controller
Route.get('/check', (request) => {
  return { local: request.isLocal() };
});
```

---

## Responses

Maxima allows you to return JSON objects or strings directly from controllers/route closures, and it will automatically translate them into 200 HTTP responses. However, if you need custom headers, status codes, downloads, or templated HTML, you can build them using the `Response` helper or the second controller argument.

### JSON Responses
```typescript
Route.get('/json', (request, response) => {
  return response.json({ message: 'Success' }, 201);
});
```

For structured API transformers, see [API Resources](./api-resources.md).

### Redirects & Back

Redirect to a URL, named route, or controller action:

```typescript
// Redirect to URL
return response.redirect('/login');

// Redirect back to the referrer URL (with a fallback)
return response.back(302, '/home');

// Redirect to named route
return response.route('users.show', { id: 4 });

// Redirect to controller action
import { UserController } from './UserController.js';
return response.action([UserController, 'index']);
```

### Views (HTML)
If using the template engine, render templates with data:
```typescript
return response.view('welcome', { name: 'Taylor' });
```

See [Views And Templating](./views-templating.md) for layouts, directives, composers, fragments, and view caching.

### Files & Downloads

Send files inline or as attachments:

```typescript
// Serve file inline (e.g. PDF/images)
return response.file('storage/reports/annual.pdf');

// Force file download
return response.download('storage/reports/annual.pdf', 'report-2026.pdf');
```

### Streams
Stream contents or trigger stream downloads:
```typescript
import { createReadStream } from 'fs';

const stream = createReadStream('storage/large-data.csv');
return response.stream(stream, 200, { 'Content-Type': 'text/csv' });
```

### Cookies

Set cookies:
```typescript
return response.cookie('theme', 'dark', {
  maxAge: 3600,
  path: '/',
  httpOnly: true
});
```

### Response Macros
Just like Request, the `Response` class is macroable:
```typescript
import { Response } from '@lib/http/Response.js';

Response.macro('capsJson', function(this: Response, data: Record<string, string>) {
  const caps = Object.fromEntries(
    Object.entries(data).map(([key, val]) => [key, val.toUpperCase()])
  );
  return this.json(caps);
});
```

---

## Exception Handling

All exceptions thrown during HTTP requests are caught and routed to the `ExceptionHandler` class to log and render readable responses.

### Custom Exception Handler setup

You can override logging/rendering rules within `src/app/Exceptions/Handler.ts` (extending `ExceptionHandler`):

```typescript
import { ExceptionHandler } from '@lib/http/ExceptionHandler.js';

export class Handler extends ExceptionHandler {
  constructor() {
    super();

    // 1. Specify exception classes that should NEVER be logged
    this.dontReport(TeapotError);

    // 2. Ignore reporting dynamically based on logic
    this.dontReportWhen((error, request) => {
      return error.message.includes('IgnoreMe');
    });

    // 3. Prevent duplicate exceptions logging
    this.dontReportDuplicates();

    // 4. Customize logging levels per exception type
    this.level(WarningContextError, 'warn');

    // 5. Throttle exceptions to avoid flooding logs (max 2 reports per minute)
    this.throttle(ThrottledError, 2, 60000);

    // 6. Define custom reporting hooks (e.g. Sentry/Bugsnag integrations)
    this.reportable(async (error, request) => {
      // Send error details to Sentry...
      await sentry.captureException(error);
    });

    // 7. Define custom rendering hooks (e.g. customized HTML/JSON error responses)
    this.renderable((error, request, response) => {
      if (error instanceof AuthorizationException) {
        return response.json({ error: 'You do not have access to this resource.' }, 403);
      }
    });
  }
}
```

### Error Context Logging

If your custom exception class implements a `context()` method, Maxima will automatically extract and append that metadata context to the logs:

```typescript
export class WarningContextError extends Error {
  context() {
    return {
      tenantId: 'acme-corp',
      billingStatus: 'overdue'
    };
  }
}
```
