# Database & ORM

Maxima features a powerful Knex.js-driven Database abstraction layer alongside an Eloquent-inspired Object-Relational Mapper (ORM).

---

## The Query Builder (`DB`)

You can execute clean queries against the database using the `DB` class. It proxies directly to Knex while offering additional utilities.

### Basic Queries

```typescript
import { DB } from '@lib/database/DB.js';

// Retrieve all rows
const users = await DB.table('users').get();

// Retrieve a single row by a column value
const user = await DB.table('users').where('email', 'taylor@example.com').first();

// Select specific columns
const emails = await DB.table('users').select('email').get();

// Insert a row
await DB.table('users').insert({
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  created_at: new Date()
});

// Update a row
await DB.table('users')
  .where('id', 1)
  .update({ name: 'Ada Lovelace' });

// Delete a row
await DB.table('users').where('id', 1).delete();
```

### Raw SQL Expressions

Sometimes you may need to use raw expressions in queries. Use `DB.raw` or `DB.expression`:

```typescript
const activeCount = await DB.table('users')
  .select(DB.raw('count(*) as user_count, status'))
  .groupBy('status')
  .get();
```

### Database Query Listener

You can listen for executed SQL queries to log queries or profile execution speeds:

```typescript
// Registers a global listener callback
const unsubscribe = DB.listen((query) => {
  console.log(`SQL: ${query.sql}`);
  console.log(`Bindings: ${JSON.stringify(query.bindings)}`);
  console.log(`Connection: ${query.connection}`);
});

// Remove listener
unsubscribe();
```

---

## Database Transactions

Maxima provides a transaction wrapper to run operations within a single database transaction. If an error is thrown, the transaction is rolled back automatically.

### Closure Transactions

```typescript
await DB.transaction(async (trx) => {
  await DB.table('users').transacting(trx).insert({ name: 'Taylor' });
  await DB.table('posts').transacting(trx).insert({ title: 'New Post' });
});
```

### Manual Transactions

If you need finer control:

```typescript
const trx = await DB.beginTransaction();

try {
  await DB.table('users').transacting(trx).insert({ name: 'Taylor' });
  await DB.commit(trx);
} catch (error) {
  await DB.rollBack(trx);
  throw error;
}
```

### After Commit Hook

If you want code to run only *after* the active database transaction is committed:

```typescript
DB.afterCommit(() => {
  console.log('Database changes saved successfully!');
});
```

> [!NOTE]
> Maxima isolates transaction contexts and `afterCommit` callbacks per asynchronous execution thread (e.g. per HTTP request or Queue job) using `AsyncLocalStorage`. This ensures that concurrent requests do not interfere with each other's transactions or callbacks.
>
> If `DB.afterCommit` is called when no transaction is active, the callback will be executed immediately.

---

## Eloquent Models

Models in Maxima extend the core `Model` class and map directly to database tables.

### Defining a Model

```typescript
import { Model } from '@lib/database/Model.js';

export class User extends Model {
  // Table name mapping
  static table = 'users';

  // Primary key (defaults to 'id')
  static primaryKey = 'id';

  // Enable/disable automatic timestamps (default: true)
  static timestamps = true;

  // Mass assignment security limits
  static fillable = ['name', 'email', 'active', 'settings'];
  static guarded = ['id', 'is_admin'];

  // Hidden attributes during JSON serialization (e.g. user.toJSON())
  static hidden = ['password'];

  // Type annotations (for TS completion)
  declare id: number;
  declare name: string;
  declare email: string;
  declare active: boolean;
  declare settings: Record<string, any>;
}
```

### CRUD Operations with Models

```typescript
// Create
const user = await User.create({ name: 'Taylor', email: 'taylor@example.com' });

// Find by ID
const user = await User.find(1); // returns null if not found
const user = await User.findOrFail(1); // throws if not found

// Update
await user.update({ name: 'Taylor Otwell' });

// Delete
await user.delete();
```

### Querying Models

```typescript
const users = await User.where('active', true).orderBy('name', 'asc').get();

// Pagination
const paginationResult = await User.paginate(1, 15); // page 1, 15 per page
console.log(paginationResult.total); // total rows count
console.log(paginationResult.data);  // User[] array
```

---

## Scopes, Accessors, and Mutators

### Local Query Scopes

Scopes allow you to define common sets of query constraints that you can easily re-use. Define them as static methods with a `scope` prefix:

```typescript
export class User extends Model {
  static scopeActive(query) {
    return query.where('active', true);
  }

  static scopeOfType(query, type: string) {
    return query.where('type', type);
  }
}

// Usage:
const activeAdmins = await User.scope('active').scope('type', 'admin').get();
```

### Accessors & Mutators

Transform attributes when they are retrieved from or set to the model instance:

```typescript
export class User extends Model {
  // Mutator runs when setting 'name'
  static mutators = {
    name: (value: string) => value.trim()
  };

  // Accessor runs when retrieving 'name'
  static accessors = {
    name: (value: string) => value.toUpperCase()
  };
}

const user = new User({ name: '  taylor  ' });
console.log(user.name); // "taylor"
console.log(user.attributes().name); // "TAYLOR" (in final persisted values)
```

---

## Type Casting & Custom Cast Classes

The `casts` property allows you to define how model attributes are converted to standard types:

```typescript
export class User extends Model {
  static casts = {
    active: 'boolean',
    settings: 'json',
    starts_at: 'date' // parses with Moment.js automatically
  } as const;
}
```

### Custom Cast Classes
If you have advanced casting logic, you can define a custom cast class. A custom cast class implements a `get(model, key, value)` and a `set(model, key, value)` method:

```typescript
export class UpperCast {
  // Executed when reading attribute from model instance
  get(model: any, key: string, value: any) {
    return String(value).toUpperCase();
  }

  // Executed when serializing/writing attribute to database
  set(model: any, key: string, value: any) {
    return String(value).toLowerCase();
  }
}

// Register inside Model
export class TestModel extends Model {
  static casts = {
    code: UpperCast
  };
}
```

---

## Model Relationships

Maxima supports all standard relationship types. Define relations as methods on your model classes:

### One-to-Many (`hasMany` / `belongsTo`)

```typescript
export class Post extends Model {
  static table = 'posts';
  
  user() {
    return this.belongsTo(User);
  }
}

export class User extends Model {
  static table = 'users';

  posts() {
    return this.hasMany(Post);
  }
}

// Usage:
const user = await User.find(1);
const posts = await user.posts().get(); // returns Post[]

const post = await Post.find(1);
const author = await post.user().first(); // returns User
```

### Many-to-Many (`belongsToMany`)

```typescript
export class User extends Model {
  roles() {
    return this.belongsToMany(Role, 'role_user', 'user_id', 'role_id');
  }
}

// Usage:
const user = await User.find(1);
const roles = await user.roles().get();
```

### Eager Loading (`with`)

To prevent N+1 query problems, eager load relationships:

```typescript
const users = await User.with('posts').get();
// Every user object will have its `.posts` property pre-populated.
```

---

## Model Collections

When you perform queries that return multiple models, Maxima wraps the array in a custom `ModelCollection` class. ModelCollection extends the native array with powerful helper operations:

```typescript
const users = await User.get(); // returns ModelCollection<User>

// 1. Eager load relationships on an existing collection
await users.load('posts');

// 2. Load relationships only if they haven't been loaded already
await users.loadMissing('roles');

// 3. Refresh all models from database
const freshUsers = await users.fresh();

// 4. Build a database query scoped specifically to collection members
const query = users.toQuery(); // DB query: WHERE id IN (1, 2, ...)

// 5. Modify attribute visibility dynamically
users.makeVisible('email').makeHidden('api_token');

// 6. Partition collection based on condition
const [activeUsers, inactiveUsers] = users.partition(user => user.active);
```

---

## Soft Deletes

When models are soft-deleted, they are not actually removed from the database. Instead, a `deleted_at` timestamp is set:

```typescript
export class Post extends Model {
  static softDeletes = true;
}

// Usage:
const post = await Post.find(1);
await post.delete(); // sets deleted_at, does not delete row

// Exclude deleted rows by default:
const posts = await Post.get(); // ignores soft-deleted entries

// Include deleted rows:
const posts = await Post.query().withTrashed().get();

// Exclusively retrieve deleted rows:
const deletedPosts = await Post.query().onlyTrashed().get();

// Restore a soft-deleted model:
await post.restore();
```

---

## Model Lifecycle Events

Models fire events throughout their lifecycles. Register listener callbacks:

```typescript
User.on('creating', (model) => {
  // Run before creation (e.g. generating UUIDs)
});

User.on('created', (model) => {
  // Run after creation
});

User.on('deleted', (model) => {
  // Run after deletion
});
```

---

## Factories & Seeders

Factories allow you to mock model data for testing and database seeding.

### Defining a Factory

```typescript
import { Factory } from '@lib/database/Factory.js';
import { User } from '../app/Models/User.js';

export class UserFactory extends Factory<typeof User> {
  model = User;

  definition() {
    return {
      name: 'Default User',
      email: 'user@example.com',
      active: true
    };
  }
}

// Register it (usually done automatically or at startup)
import { FactoryRegistry } from '@lib/database/Factory.js';
FactoryRegistry.register(User, UserFactory);
```

### Using Factories

```typescript
// Create single database row with default definition
const user = await User.factory().create();

// Create multiple rows
const users = await User.factory(5).create();

// Override definition attributes
const admin = await User.factory().create({ name: 'Admin User' });

// Make instances without persisting to DB
const userInstance = User.factory().make();
```

---

## Schema Builder

Use the `Schema` facade to run migration operations (such as creating tables, columns, indexes, and dropping tables).

```typescript
import { Schema } from '@lib/database/Schema.js';

// Create a table
await Schema.create('users', (table) => {
  table.increments('id');
  table.string('name').notNullable();
  table.string('email').unique().notNullable();
  table.string('password').nullable();
  table.timestamps();
});

// Alter an existing table
await Schema.table('users', (table) => {
  table.string('phone').nullable();
});

// Drop table
await Schema.dropIfExists('users');

// Verify structure
const hasUsers = await Schema.hasTable('users');
const hasPhone = await Schema.hasColumn('users', 'phone');
```
