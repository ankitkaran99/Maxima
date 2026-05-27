# Support Utilities

Maxima exports collection, string, array, object, URL, number, and macro utilities from `@lib/index.js`.

```typescript
import {
  Arr,
  Collection,
  LazyCollection,
  Number as NumberFormatter,
  Obj,
  Str,
  Uri,
  collect,
  str
} from '@lib/index.js';
```

## Collections

Use `collect()` or `Collection.make()` to wrap iterable values or object values.

```typescript
const users = collect([
  { id: 1, name: 'Ada', active: true },
  { id: 2, name: 'Grace', active: false }
]);

const names = users
  .filter(user => user.active)
  .pluck('name')
  .all();
```

Common collection methods include:

- `all()`, `toArray()`, `count()`, `isEmpty()`, `isNotEmpty()`
- `first()`, `last()`, `get()`
- `map()`, `filter()`, `reject()`, `each()`, `reduce()`
- `pluck()`, `keys()`, `values()`
- `push()`, `pop()`, `shift()`, `prepend()`, `merge()`
- `unique()`, `groupBy()`, `keyBy()`, `sortBy()`
- `take()`, `skip()`, `chunk()`, `flatten()`
- `contains()`, `sum()`, `avg()`, `min()`, `max()`
- `partition()`, `when()`, `unless()`, `tap()`

Higher-order collection proxies are available through `higher()`:

```typescript
const names = users.higher('map').name.all();
const active = users.higher('filter').active.all();
```

Collections are macroable:

```typescript
Collection.macro('active', function() {
  return this.filter((item: any) => item.active);
});

const activeUsers = (users as any).active().all();
Collection.flushMacros();
```

## Lazy Collections

`LazyCollection` works with sync or async iterable sources and evaluates as it is consumed.

```typescript
const values = await LazyCollection
  .make([1, 2, 3, 4])
  .map(value => value * 2)
  .filter(value => value > 4)
  .take(2)
  .all();

const eager = await LazyCollection.make([1, 2, 3]).collect();
```

## Strings

`str()` returns a fluent string wrapper. `Str` exposes static helpers.

```typescript
str('hello_world').camel().title().toString();

Str.camel('user_name');
Str.snake('UserName');
Str.kebab('UserName');
Str.slug('Hello World');
Str.uuid();
Str.random(24);
```

Fluent strings support `lower()`, `upper()`, `title()`, `camel()`, `snake()`, `kebab()`, `slug()`, `studly()`, `before()`, `after()`, `contains()`, `startsWith()`, `endsWith()`, `replace()`, `append()`, `prepend()`, `trim()`, and `limit()`.

String macros are registered through `Str.macro()` or `FluentString.macro()`.

## Arrays And Objects

`Arr` and `Obj` support dot-notation access and common selection operations.

```typescript
const payload = { user: { profile: { name: 'Ada' } } };

Arr.get(payload, 'user.profile.name');
Arr.set(payload, 'user.profile.role', 'admin');
Arr.has(payload, 'user.profile.role');
Arr.forget(payload, 'user.profile.role');
Arr.only({ id: 1, name: 'Ada' }, ['id']);
Arr.except({ id: 1, password: 'secret' }, ['password']);
Arr.wrap('tag');
Arr.flatten([[1], [2, [3]]]);

Obj.get(payload, 'user.profile.name');
```

## URIs

`Uri` wraps the built-in `URL` API with a fluent interface.

```typescript
const value = Uri
  .of('/users', 'https://example.com')
  .path('/users/1')
  .query({ tab: 'profile' })
  .withQuery('page', 2)
  .withoutQuery('tab')
  .fragment('details')
  .toString();
```

## Numbers

The exported `Number` helper formats numbers with `Intl.NumberFormat` and includes convenience formatters.

```typescript
NumberFormatter.format(1234.5);
NumberFormatter.currency(1999, 'USD');
NumberFormatter.percentage(0.25, 2);
NumberFormatter.fileSize(1536);
```

## Macro Registry

For custom macroable classes, use `MacroRegistry` and `proxyMacros()`.

```typescript
import { MacroRegistry, proxyMacros } from '@lib/index.js';

class Tool {
  static macros = new MacroRegistry();

  constructor() {
    return proxyMacros(this, Tool.macros);
  }
}

Tool.macros.macro('ping', () => 'pong');
```
