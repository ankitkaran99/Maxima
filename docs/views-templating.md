# Views And Templating

Maxima renders Edge templates from `src/resources/views` and compiles email templates from `src/resources/emails`. Standard views are built on Edge.js, while email templates use `.mjml` layout syntax (with `.edge` fallback) compiled via MJML. Views can be rendered through the `ViewFactory`, response helpers, or global helpers.

```typescript
import { view, viewExists, viewFirst } from '@lib/index.js';

const html = await view('users.show', { title: 'Ada' });
const exists = await viewExists('users.show');
const first = await viewFirst(['users.card', 'users.show'], { title: 'Ada' });
```

Dot notation maps to nested files, so `users.show` resolves to `resources/views/users/show.edge`.

## View Factory

The `ViewFactory` can share global data, register creators, register composers, render inline templates, and render fragments.

```typescript
import { ViewFactory } from '@lib/view/ViewFactory.js';

const views = new ViewFactory();

views.share('appName', 'Maxima');
views.creator('dashboard', data => {
  data.created = true;
});
views.composer(['dashboard', 'users.*'], data => {
  data.navigation = ['Home', 'Users'];
});

await views.render('dashboard');
await views.renderInline('Hello {{ name }}', { name: 'Ada' });
await views.renderFragment('dashboard', 'preview', { name: 'Ada' });
```

Creators run before composers. Patterns may be exact names, wildcard strings such as `users.*`, arrays, or regular expressions.

## Layouts And Sections

Templates support Laravel-style layout directives:

```edge
@extends('layouts/app')

@section('content')
  <h1>{{ title }}</h1>
@endsection
```

Layouts can render sections with `@yield('content')`. `@parent`, `@show`, `@append`, `@overwrite`, `@hasSection`, and `@sectionMissing` are also compiled.

## Blade-Style Directives

Maxima preprocesses common Blade-style directives before handing templates to Edge:

```edge
@auth
  Signed in
@endauth

@guest
  Guest
@endguest

@can('update', post)
  Edit
@endcan

@csrf
@method('PUT')
<input @checked(active) @required(required)>
```

Supported directives include `@auth`, `@guest`, `@can`, `@cannot`, `@canany`, `@isset`, `@empty`, `@production`, `@env`, `@session`, `@error`, `@csrf`, `@method`, `@checked`, `@selected`, `@disabled`, `@readonly`, and `@required`.

## Loops And Control Flow

Edge-native tags work alongside additional loop helpers:

```edge
@for(let i = 0; i < users.length; i++)
  {{ users[i].name }}
@endfor

@for(const user of users)
  @if(user.disabled)
    @continue
  @endif
  {{ user.name }}
@endfor

@while(counter.value < 5)
  @eval(counter.value++)
  @break
@endwhile
```

`@break` and `@continue` are available inside supported loops.

## Localization And Output Helpers

Templates can call translation and output helpers directly:

```edge
@lang('messages.welcome', { name: user.name })
@choice('messages.apples', count)

@json(payload)
@js(payload)
<span class="@class({ active: isActive, hidden: false })"></span>
<span style="@style({ color: 'red', display: false })"></span>
```

`@json` and `@js` escape HTML-sensitive characters before rendering JSON.

## Fragments

Fragments can be rendered as part of a full view or independently:

```edge
@fragment('preview')
  Preview {{ name }}
@endfragment
```

```typescript
const html = await renderFragment('users.card', 'preview', { name: 'Ada' });
```

## Emails

Email templates live under `resources/emails` (using the `.mjml` extension) and are rendered through `renderEmail()` or `ViewFactory.renderEmail()`. They are compiled using the MJML compiler to produce clean, responsive email HTML.

### Variable Interpolation & Logical Directives
Email templates fully support variables, conditionals, loops, and other Edge.js features inside the MJML structure. Variables are evaluated during a pre-rendering step before layout compilation.

Example template `resources/emails/welcome.mjml`:
```xml
<mjml>
  <mj-head>
    <mj-title>Welcome, {{ user.name }}</mj-title>
  </mj-head>
  <mj-body background-color="#f6f8fb">
    <mj-section>
      <mj-column>
        <mj-text font-size="20px">Welcome, {{ user.name }}!</mj-text>
        
        @if(user.isAdmin)
          <mj-text color="#0f766e" font-weight="bold">Admin Access Granted.</mj-text>
        @endif

        <mj-text>Your tasks:</mj-text>
        @each(task in tasks)
          <mj-text>- {{ task }}</mj-text>
        @endeach
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```

Rendering the email:
```typescript
import { renderEmail } from '@lib/index.js';

const html = await renderEmail('welcome', { 
  user: { name: 'Ada', isAdmin: true },
  tasks: ['Setup project', 'Configure queue']
});
```

## View Cache

Rendered templates are compiled into `storage/framework/views` and invalidated when the source file changes. You can warm or clear the cache through the CLI:

```bash
npm run maxima -- view:cache
npm run maxima -- view:clear
```

### Production In-Memory Caching

To optimize performance and avoid filesystem lock contention under high-load benchmarks on production systems, Maxima features an in-memory compilation and hash cache.

When running in production mode (`APP_ENV=production` or `CACHE_VIEWS=true`), compiled view strings and their SHA1 cryptographic hashes are cached in memory using a size-limited LRU (Least Recently Used) cache. This completely avoids subsequent file stats (`fs.stat`) and disk reads, bringing rendering times down to CPU-bound memory access.

You can configure the in-memory cache behavior via the following environment variables:

| Environment Variable | Description | Default |
|---|---|---|
| `CACHE_VIEWS` | Set to `true` to enable permanent in-memory template and hash caching regardless of environment. | `false` |
| `VIEW_CACHE_LIMIT` | The maximum number of compiled template strings to keep in-memory. | `100` |
| `VIEW_HASH_CACHE_LIMIT` | The maximum number of pre-computed template hashes to keep in-memory (bypasses SHA1 crypto calls). | `100` |
