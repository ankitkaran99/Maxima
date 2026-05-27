# API Resources

API resources transform models and plain objects into consistent JSON payloads.

```typescript
import { JsonResource } from '@lib/index.js';

export class UserResource extends JsonResource {
  toArray(request: any) {
    return {
      id: this.id,
      name: this.name,
      email: this.email
    };
  }
}
```

Resource instances proxy missing properties to the wrapped resource, so `this.id` reads from the model or object passed to the constructor.

## Single Resources

```typescript
const resource = new UserResource(user);

return resource.resolve();
```

By default resources are wrapped in a `data` key:

```json
{
  "data": {
    "id": 1,
    "name": "Ada"
  }
}
```

Disable or change wrapping by setting the static `wrap` property:

```typescript
export class UserResource extends JsonResource {
  static wrap = '';
}
```

If `toArray()` is not overridden, Maxima uses the wrapped resource's `toJSON()` method when available, otherwise it returns the raw resource.

## Collections

Use the static `collection()` helper to transform arrays:

```typescript
return UserResource.collection(users).resolve();
```

The result is wrapped with the same resource wrapping rules:

```json
{
  "data": [
    { "id": 1, "name": "Ada" },
    { "id": 2, "name": "Grace" }
  ]
}
```

## Paginated Collections

When the collection source contains `data`, `total`, `page`, and `perPage`, Maxima includes pagination links and metadata.

```typescript
const paginated = {
  data: users,
  total: 50,
  page: 2,
  perPage: 15
};

return UserResource.collection(paginated).resolve();
```

The response includes `links.first`, `links.last`, `links.prev`, `links.next`, and `meta` fields such as `current_page`, `last_page`, `per_page`, and `total`.

## JSON Serialization

Resources implement `toJSON()`, so returning a resource from a route or serializing it with `JSON.stringify()` uses the resolved payload.
