# Maxima ImEx (Import Export) Plugin

A Laravel-Excel inspired class-based import and export plugin for the Maxima framework, powered by SheetJS (`xlsx`). It allows you to dynamically import spreadsheet data (CSV, XLS, XLSX) into collections or database models, and export arrays or queries to downloadable files or storage disks.

---

## Features

- **Class-Based Exporters:** Easily structure your spreadsheet outputs by implementing simple declarative methods (`headings()`, `map()`, `query()`, `array()`).
- **Class-Based Importers:** Parse sheets cleanly using heading-row mapping (`headingRow()`) and persist rows directly into database models (`model()`) or batch-process them (`collection()`).
- **Multi-Format Support:** Read and write CSV, XLS (Excel 97-2004), and XLSX (OpenXML) formats out-of-the-box.
- **Dynamic File Streaming:** Stream spreadsheet downloads directly to clients using Maxima's HTTP response handlers.
- **Storage Disk Integration:** Direct hooks to store generated reports on configured storage disks (`Storage.disk()`).

---

## Installation & Setup

Import and call the `ImEx` utility directly in your code.

---

## Usage Guide: Exports

To define an export, create a class that declares how to retrieve the data (using `query()` or `array()`) and optionally maps the columns (`map()`) and adds labels (`headings()`).

### 1. From Array (Basic)

```typescript
import { ImEx } from 'plugins/imex/src/index.js'

class UsersExport {
  headings() {
    return ['Name', 'Email Address']
  }

  map(user: any) {
    return [user.name.toUpperCase(), user.email]
  }

  array() {
    return [
      { name: 'Alice Smith', email: 'alice@test.com' },
      { name: 'Bob Jones', email: 'bob@test.com' }
    ]
  }
}
```

### 2. From Database Query (Recommended for large datasets)

```typescript
import { User } from 'app/Models/User.js'

class DBUsersExport {
  headings() {
    return ['ID', 'Name', 'Email Address']
  }

  map(user: any) {
    return [user.id, user.name, user.email]
  }

  query() {
    return User.query() // Returns ModelQueryBuilder / Knex query
  }
}
```

### 3. Exposing Download in Controller

Call `ImEx.download()` inside your route handler to stream the file to the client:

```typescript
Route.get('/users/export', async (request, response) => {
  return await ImEx.download(response, new DBUsersExport(), 'users-report.xlsx')
})
```

### 4. Storing File on Storage Disk

Call `ImEx.store()` to save the file silently onto your local or remote disk:

```typescript
await ImEx.store(new DBUsersExport(), 'reports/users-report.xlsx', 's3')
```

---

## Usage Guide: Imports

To import data, write a class declaring if rows should be parsed into DB models (`model()`) or processed as a batch collection (`collection()`).

### 1. Heading-Mapped Model Import (ToModel)

If your spreadsheet has a header row, implement `headingRow()` returning the 1-indexed row number (e.g. `1`). Row inputs are then passed as key-value objects matching your header titles:

```typescript
import { User } from 'app/Models/User.js'

class UsersImport {
  headingRow() {
    return 1 // Headers are on Row 1, data starts on Row 2
  }

  async model(row: any) {
    // Return a model instance. ImEx automatically calls .save() if model is returned
    return new User({
      name: row['Full Name'],
      email: row['Email Address'],
      password: 'default-password'
    })
  }
}
```

Import by calling:
```typescript
await ImEx.import(new UsersImport(), fileBuffer) // Or path string: 'imports/users.xlsx'
```

### 2. Collection Import (ToCollection)

If you need to batch-process rows in memory (e.g., custom validations or batch inserts), implement `collection()`:

```typescript
class CustomImport {
  async collection(rows: any[]) {
    for (const row of rows) {
      console.log('Processing row:', row)
    }
  }
}
```

---

## API Reference & Method Signatures

### ImEx Manager

```typescript
class ImExClass {
  /** Stream a download response of the export payload */
  download(
    response: any,
    exportInstance: any,
    fileName: string,
    format?: 'csv' | 'xlsx' | 'xls'
  ): Promise<any>;

  /** Store the export payload onto a storage disk */
  store(
    exportInstance: any,
    filePath: string,
    disk?: string,
    format?: 'csv' | 'xlsx' | 'xls'
  ): Promise<void>;

  /** Parse a local path, disk file, or file Buffer and trigger import mapping hooks */
  import(
    importInstance: any,
    filePathOrBuffer: string | Buffer,
    disk?: string
  ): Promise<void>;
}
```

### Export Interface Methods

Declare these methods on your export classes to specify data extraction:

```typescript
interface ExportClass {
  /** Return a Maxima query builder */
  query?(): any;

  /** Return a static list of objects/arrays */
  array?(): any[] | Promise<any[]>;

  /** Define header column labels */
  headings?(): string[] | Promise<string[]>;

  /** Map a model row instance to an indexed array of cell values */
  map?(row: any): any[] | Promise<any[]>;
}
```

### Import Interface Methods

Declare these methods on your import classes to specify parsing rules:

```typescript
interface ImportClass {
  /** The 1-indexed row number representing column headers */
  headingRow?(): number;

  /** Process a single row and return a Maxima Model instance to be saved */
  model?(row: any): any | Promise<any>;

  /** Batch process parsed rows */
  collection?(rows: any[]): void | Promise<void>;
}
```

---

## Testing

Run the ImEx unit tests:

```bash
npx vitest run plugins/imex/
```
