# Maxima LiteTable Datatables Plugin

A lightweight server-side DataTables and export helper plugin for the Maxima framework, inspired by Laravel's server-side Datatables. It simplifies paginating, searching, sorting, and transforming database model query results for AJAX-based DataTables in the frontend.

---

## Features

- **Automated Server-Side Operations:** Parses DataTables parameters (`start`, `length`, `draw`, `search`, `order`, etc.) and automatically constructs count, pagination, filtering, and sorting queries.
- **Dynamic Columns:** Dynamically reads requested columns from the request context or allows overriding them explicitly in the backend.
- **Row Transformation Hooks:** Easy-to-use callbacks to append new columns (`addColumn`), modify column values (`editColumn`), or modify groups of columns (`editColumns`).
- **Escaped Outputs by Default:** HTML-escapes output data dynamically to prevent XSS. Specify `rawColumns` to allow HTML formatting on specific keys.
- **Relation Fields:** Supports resolving dot-notation relation keys (e.g. `customer.name`) for rendering and search blocks.
- **CSV Export:** Streams Excel-compatible CSV exports natively with custom cell-mapping arrays and UTF-8 BOM headers.

---

## Installation & Setup

Import and instantiate `LiteTable` directly in your controllers or route handlers.

No service provider registration is strictly required as the class works as a dynamic pipeline factory.

---

## Usage Guide

### Basic Rendering Endpoint

Instantiate `LiteTable` with a database query builder and the HTTP `Request` object. Call `.render()` to automatically output the JSON structure expected by DataTables:

```typescript
import { Route } from '@lib/http/Route.js'
import { User } from 'app/Models/User.js'
import { LiteTable } from 'plugins/litetable/src/index.js'

Route.get('/api/users', async (request, response) => {
  const query = User.query() // Or User.where('active', true)

  return await LiteTable.make(query, request).render(response)
})
```

---

### Fluent Configuration & Custom Column Mapping

Customize the output row payloads with custom index offsets, raw markup fields, custom column edits, and custom row IDs:

```typescript
import { LiteTable } from 'plugins/litetable/src/index.js'

Route.get('/api/users', async (request, response) => {
  const query = User.query()

  return await LiteTable.make(query, request)
    .addIndexColumn() // Adds the 'DT_RowIndex' sequential index column
    .setRowId('id')   // Adds the 'DT_RowId' attribute mapping to the user ID
    
    // Append custom computed columns
    .addColumn('action', (user) => {
      return `<a href="/users/${user.id}/edit" class="btn btn-sm">Edit</a>`
    })

    // Modify existing columns
    .editColumn('status', (user, rawValue) => {
      return rawValue === 'active' ? 'Active User' : 'Inactive User'
    })

    // Mark specific columns as raw (unescaped)
    .rawColumns(['action'])
    .render(response)
})
```

---

### Custom Ordering and Filtering

Define custom callbacks to override default database search or sorting logic for specific fields:

```typescript
LiteTable.make(query, request)
  // Custom filter logic
  .filterColumn('name', (builder, keyword, column, type) => {
    // Custom SQL query condition
    builder.where('first_name', 'like', `%${keyword}%`)
           .orWhere('last_name', 'like', `%${keyword}%`)
  })

  // Custom sort logic
  .orderColumn('name', (builder, direction, column) => {
    builder.orderBy('first_name', direction).orderBy('last_name', direction)
  })
```

---

### CSV Streaming Exports

Stream CSV exports directly by defining export headers and a mapper callback:

```typescript
Route.get('/api/users/export', async (request, response) => {
  const query = User.query()

  const exporter = LiteTable.make(query, request)
    .setExportHeaders(['User ID', 'Name', 'Email Address', 'Date Created'])

  return await exporter.export(
    response,
    (user) => [
      user.id,
      user.name,
      user.email,
      user.created_at
    ],
    'users-list-export'
  )
})
```

---

## API Reference & Method Signatures

### LiteTable Class

```typescript
class LiteTable {
  /** Instantiate the table builder with query and request contexts */
  static make(query: any, request: Request): LiteTable;

  /** Set explicit array of column configurations */
  columns(columns: any[]): this;

  /** Add sequential index column 'DT_RowIndex' */
  addIndexColumn(): this;

  /** Resolve the 'DT_RowId' using a model field key or custom callback */
  setRowId(resolver: string | ((row: any) => string)): this;

  /** Set default order fallback column and direction */
  defaultOrder(column: string, direction?: 'asc' | 'desc'): this;

  /** Prevent HTML escaping on specific columns (usually HTML actions) */
  rawColumns(columns: string[]): this;

  /** Append a new column with a mapping callback */
  addColumn(key: string, callback: (row: any, column?: any) => any): this;

  /** Edit the output of an existing column */
  editColumn(key: string, callback: (row: any, rawValue: any, column?: any) => any): this;

  /** Edit multiple column values using a shared mapping function */
  editColumns(columns: string[], callback: (rawValue: any) => any): this;

  /** Register a custom DB query filter for a specific column */
  filterColumn(key: string, callback: (query: any, keyword: string, column: any, type: 'global' | 'column') => void): this;

  /** Register a custom DB query sort for a specific column */
  orderColumn(key: string, callback: (query: any, direction: 'asc' | 'desc', column: any) => void): this;

  /** Set header names for CSV export (order must match the mapper array output) */
  setExportHeaders(headers: string[]): this;

  /** Process request and send Datatables formatted JSON response payload */
  render(response?: any): Promise<any>;

  /** Filter the query and stream downloading a mapped CSV file */
  export(response: any, mapper: (row: any) => any[] | Promise<any[]>, fileName: string, type?: string): Promise<any>;
}
```

---

## Testing

Run the LiteTable test suite:

```bash
npx vitest run plugins/litetable/
```
