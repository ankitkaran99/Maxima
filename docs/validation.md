# Validation & Form Requests

Maxima includes a robust, schema-driven validation engine. You can validate incoming requests using manual schema validations or encapsulate them inside dedicated `FormRequest` classes.

---

## Validation Schemas & Types

The `schema` builder defines validation schemas. Maxima automatically parses, validates, and casts the incoming request data.

### Schema Fields

- `schema.string()`: Matches and casts fields to a string.
- `schema.number()`: Matches and casts fields to a float.
- `schema.integer()`: Matches and casts fields to an integer.
- `schema.boolean()`: Matches and casts fields to a boolean (e.g. `true`, `'true'`, `1`, `'1'`).
- `schema.date()`: Matches and casts fields to a JavaScript `Date` object.
- `schema.file()`: Matches uploaded file payloads.
- `schema.password()`: Validates password complexity constraints.
- `schema.array()`: Validates arrays (use `.members()` for inner elements).
- `schema.object(shape)`: Validates nested objects.

---

## Inline Validation (`Validator`)

To run inline validations inside route closures or controllers:

```typescript
import { Validator, schema } from '@lib/index.js';

Route.post('/register', async (request) => {
  try {
    const validated = await Validator.validate(request.all(), {
      username: schema.string().minLength(3).maxLength(30),
      email: schema.string().email(),
      age: schema.integer().between(18, 99),
      subscribe: schema.boolean().optional()
    });

    // validated now contains fully typed and casted data:
    // validated.age is a number, validated.subscribe is a boolean
    return { status: 'success', data: validated };
  } catch (error: any) {
    return { status: 'failed', errors: error.errors };
  }
});
```

### Conditional Validations (`sometimes`)

Use `sometimes()` to execute a validation rule only if a given condition is met:

```typescript
const validator = Validator.make(request.all(), {
  type: schema.string()
})
.sometimes('company_name', schema.string().minLength(3), (data) => {
  return data.type === 'company';
});

const validated = await validator.validate();
```

### Customizing Messages & Wildcards

You can customize messages, attributes, and value replacers globally or inline. Maxima supports wildcard `*` syntax for nested array/object indices:

```typescript
const validated = await Validator.validate(request.all(), {
  'users.*.email': schema.string().email()
}, {
  messages: {
    // Matches users.0.email.email, users.1.email.email, etc.
    'users.*.email.email': 'The :attribute must be valid.'
  },
  attributes: {
    'users.*.email': 'user email'
  }
});
```

> [!NOTE]
> Wildcard messages and attributes are matched segment-by-segment using clean regex patterns. The `*` wildcard only matches a single array index or object segment (preventing false matches across deeper levels of the request).

---

## Advanced Schema Rule Chains

Maxima supports highly flexible rule chaining:

### String Constraints
```typescript
schema.string()
  .alpha()       // letters only
  .alphanumeric() // letters and numbers
  .email()
  .url()
  .ip()          // valid IPv4 or IPv6
  .uuid()        // valid UUID
  .regex(/^[A-Z0-9]+$/) // custom regex
```

### Date Constraints
```typescript
schema.string()
  .dateFormat('YYYY-MM-DD')
  .before('end_date') // must be before value of field 'end_date'
  .afterOrEqual('start_date')
```

### Number Constraints
```typescript
schema.integer()
  .min(0)
  .max(100)
  .gt('other_field') // must be greater than value of 'other_field'
```

### Array & Object Nesting
```typescript
schema.array().members(schema.integer().min(1));

schema.object({
  profile: schema.object({
    first_name: schema.string(),
    last_name: schema.string()
  })
});
```

### File Constraints
```typescript
schema.file()
  .image()
  .mimes(['png', 'jpeg'])
  .maxFileSize(2048) // in kilobytes (2MB)
```

### Database Validation Rules

You can validate parameter values against database tables to ensure data integrity:

```typescript
// 1. Validate that the value EXISTS in the specified table column
const existsRule = {
  email: schema.string().exists('users', 'email')
};

// 2. Validate that the value is UNIQUE (does not exist) in the database table
const uniqueRule = {
  email: schema.string().unique('users', 'email')
};
```

---

## Custom Validation Rules

You can extend the validation system with custom rules globally using `Validator.extend`:

```typescript
import { Validator } from '@lib/index.js';

// Register global custom rule
Validator.extend('uppercase', (value) => {
  return typeof value === 'string' && value === value.toUpperCase();
});

// Usage in schema
const validated = await Validator.validate(request.all(), {
  promo_code: schema.string().use('uppercase')
});
```

---

## Form Requests

Form Requests are dedicated request classes that encapsulate validation and authorization logic. They are placed in the `src/app/Http/Requests/` directory.

### Creating a Form Request

Create a class that extends `FormRequest`:

```typescript
import { FormRequest, schema } from '@lib/index.js';

export class StoreUserRequest extends FormRequest {
  // 1. Prepare data before running validation rules
  prepareForValidation() {
    this.merge({
      email: this.input('email', '').trim().toLowerCase()
    });
  }

  // 2. Define the validation rules
  rules() {
    return {
      name: schema.string().minLength(2),
      email: schema.string().email(),
      password: schema.password().minLength(8)
    };
  }

  // 3. Optional: Customize failure error messages
  messages() {
    return {
      'email.email': 'Please specify a valid business email address.'
    };
  }

  // 4. Optional: Customize attribute name display
  attributes() {
    return {
      email: 'work email'
    };
  }

  // 5. Runs after validation succeeds
  after() {
    // Add custom post-validation logic here
  }
}
```

### FormRequest Execution Lifecycle Sequence

When you invoke `await formRequest.validateResolved()`, Maxima processes hooks in this order:

1. Calls **`prepareForValidation()`** (if present) to pre-sanitize or default incoming request input.
2. Compiles rule mappings via **`rules()`**.
3. Executes validation against the merged inputs. If failure occurs, it formats messages using **`messages()`** and **`attributes()`** before throwing a `ValidationException` (returning HTTP 422).
4. Calls **`after()`** (if present) to run post-validation side-effects (e.g. logging, or attaching verified models).

### Using a Form Request inside a Controller

```typescript
import { StoreUserRequest } from '../Requests/StoreUserRequest.js';

export class UserController {
  async store(request: Request, reply: Response) {
    const formRequest = new StoreUserRequest(request, reply);
    
    // Automatically runs prepareForValidation(), rules(), after()
    // Throws a validation exception if failed
    await formRequest.validateResolved();

    // Access the validated data:
    const data = formRequest.validated();
    
    // Get subset
    const safeData = formRequest.safe().only(['name', 'email']);

    return { status: 'created', user: data };
  }
}
```
