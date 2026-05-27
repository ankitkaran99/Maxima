# Authentication & Authorization

Maxima contains built-in authentication services alongside a comprehensive authorization engine to define policies and protect actions.

---

## Authentication

The `Auth` manager handles verifying credentials, sessions, and request-level authentication.

### Hashing Passwords

Use the `Hash` utility to securely hash passwords:

```typescript
import { Auth } from '@lib/auth/AuthManager.js';
import { Hash } from '@lib/security/Hash.js';

// Hash a password using argon2 (default driver)
const hashedPassword = await Hash.make('my-secret-password');

// Verify a password
const isValid = await Hash.check('my-secret-password', hashedPassword);
```

`Auth.hash()` and `Auth.verify()` delegate to the same hashing manager when you prefer to keep hashing calls near authentication code.

### Attempting Authentication

Inside login routes, you can verify credentials and log users in:

```typescript
import { Auth } from '@lib/auth/AuthManager.js';

Route.post('/login', async (request, response) => {
  const credentials = request.only(['email', 'password']);
  const remember = request.boolean('remember');

  // Attempts verification; if valid, binds user to session and request
  const loggedIn = await Auth.attempt(credentials, 'session', remember);

  if (loggedIn) {
    return response.redirect('/dashboard');
  }

  return response.back().withErrors({
    email: 'These credentials do not match our records.'
  });
});
```

### Checking Auth Status & Retrieving the User

You can verify if the user is authenticated and access their profile data:

```typescript
// Check if the current user is logged in
if (await Auth.check()) {
  const user = await Auth.user();
  console.log(`Hello, ${user.name}!`);
}
```

### Logging Out

To invalidate the active user session:

```typescript
Route.post('/logout', async (request, response) => {
  await Auth.logout();
  return response.redirect('/login');
});
```

---

## Guards & Providers

Guards define how users are authenticated for each request. The default guards are `session` (cookie/session-based) and `token` (bearer token).

Configure guards in `src/config/auth.ts`:

```typescript
export default {
  defaults: {
    guard: 'session',
    provider: 'users'
  },
  guards: {
    session: {
      driver: 'session',
      provider: 'users'
    },
    token: {
      driver: 'token',
      provider: 'users'
    }
  },
  providers: {
    users: {
      driver: DatabaseUserProvider // Maps to database user queries
    }
  }
};
```

To fetch a user under a specific guard:
```typescript
const apiUser = await Auth.user('token'); // Resolves via Authorization: Bearer token header
```

### Custom Request Guards

If you need to define custom logic for resolving the current authenticated user on a request, you can register a custom request-based guard using `Auth.viaRequest`:

```typescript
import { Auth } from '@lib/auth/AuthManager.js';

// Resolve user by custom header
Auth.viaRequest('api-key-guard', async (request) => {
  const apiKey = request.headers['x-api-key'];
  if (!apiKey) return null;

  return await User.where('api_key', apiKey).first();
});
```

### User Providers Contracts

If you store user credentials outside standard database tables (such as LDAP or a remote API), implement a custom User Provider class:

```typescript
import { type UserProvider } from '@lib/auth/AuthManager.js';

export class CustomUserProvider implements UserProvider {
  // Retrieve user by primary key ID
  async retrieveById(id: string | number) {
    return await RemoteUserApi.find(id);
  }

  // Retrieve user by credentials object during login attempts
  async retrieveByCredentials(credentials: Record<string, any>) {
    return await RemoteUserApi.findByEmail(credentials.email);
  }
}
```

---

## Authentication Events

The Auth module dispatches events throughout the login and verification flow. You can register listeners for these events to track metrics, log audits, or update user records:

- **`AuthAttempting`**: Fired when a login verification process begins.
- **`AuthValidated`**: Fired when credentials check matches successfully.
- **`AuthLogin`**: Fired when a user successfully logs in and session stores their ID.
- **`AuthFailed`**: Fired when login credentials check fails.
- **`AuthLogout`**: Fired when a user logs out.

```typescript
import { Event } from '@lib/events/Event.js';
import { AuthLogin, AuthFailed } from '@lib/auth/AuthManager.js';

// Audit successful logins
Event.listen(AuthLogin, (event) => {
  console.log(`User ID [${event.user.id}] logged in via [${event.guard}] guard.`);
});

// Audit failed logins
Event.listen(AuthFailed, (event) => {
  console.log(`Failed login attempt on [${event.guard}] guard for credentials: ${event.credentials.email}`);
});
```

---

## Login Throttling

To protect routes from brute force attacks, Maxima has automatic login throttling. Configure throttling in `src/config/auth.ts`:

```typescript
export default {
  throttle: {
    enabled: true,
    decaySeconds: 60, // period of lockout block
    maxAttempts: 5    // max logins allowed before block
  }
};
```

---

## Authorization Gates

Gates are closures that determine if a user is authorized to perform a given action.

### Defining Gates

Define gates in your App's bootstrapper or service providers:

```typescript
import { Gate } from '@lib/auth/Gate.js';

// Define a gate check
Gate.define('update-post', (user, post) => {
  return user.id === post.user_id;
});

// Admin bypass using before()
Gate.before((user) => {
  if (user.role === 'admin') {
    return true; // Bypasses specific check and grants access
  }
});
```

### Checking Gates

You can check gates using the `allows`, `denies`, or `authorize` methods:

```typescript
// 1. Returns a boolean
if (await Gate.allows('update-post', post)) {
  // Update post...
}

if (await Gate.denies('update-post', post)) {
  // Block action...
}

// 2. Throws an AuthorizationException (403) if disallowed
await Gate.authorize('update-post', post);
```

### User Authorization Shortcuts

Authenticated user objects are automatically decorated with `can` and `cannot` helpers:

```typescript
const user = await Auth.user();

if (await user.can('update-post', post)) {
  // Authorized!
}

if (await user.cannot('update-post', post)) {
  // Blocked!
}
```

---

## Policies

Policies are classes that organize authorization logic around a particular model.

### Defining a Policy

```typescript
import { Post } from '../Models/Post.js';
import { User } from '../Models/User.js';

export class PostPolicy {
  // Define actions matching resource operations
  async view(user: User, post: Post) {
    return true;
  }

  async update(user: User, post: Post) {
    return user.id === post.user_id;
  }

  async delete(user: User, post: Post) {
    return user.id === post.user_id || user.role === 'admin';
  }
}
```

### Registering Policies

Map your models to policies:

```typescript
import { Gate } from '@lib/auth/Gate.js';
import { Post } from '../app/Models/Post.js';
import { PostPolicy } from '../app/Policies/PostPolicy.js';

// Bind Post model to PostPolicy
Gate.policy(Post, PostPolicy);
```

### Checking Policies

Once registered, Gate checks will automatically look up the appropriate policy based on the model instance passed:

```typescript
// This automatically instantiates PostPolicy and executes the update() method
if (await Gate.allows('update', post)) {
  // ...
}
```

### Protecting Controller Actions

If your controller extends the base Maxima `Controller` class, you can use the `authorize()` helper:

```typescript
import { Controller } from '@lib/http/Controller.js';

export class PostController extends Controller {
  async update(request: Request) {
    const post = await Post.findOrFail(request.params.id);

    // Throws 403 error if user cannot update
    await this.authorize('update', post);

    await post.update(request.all());
    return { status: 'success' };
  }
}
```
