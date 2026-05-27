# File Storage

Maxima provides a powerful filesystem abstraction layer based on a clean `Disk` interface. It enables transparently working with local storage, Amazon S3, FTP, or SFTP servers using the exact same API.

---

## Configuration

Configure your file storage disks in `src/config/filesystems.ts`:

```typescript
export default {
  default: 'local',
  cloud: 's3',

  disks: {
    local: {
      driver: 'local',
      root: 'storage/app',
      url: 'http://localhost:3000/storage',
      visibility: 'private'
    },
    public: {
      driver: 'local',
      root: 'storage/app/public',
      url: 'http://localhost:3000/storage/public',
      visibility: 'public'
    },
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'us-east-1',
      key: 'AWS_ACCESS_KEY_ID',
      secret: 'AWS_SECRET_ACCESS_KEY'
    },
    ftp: {
      driver: 'ftp',
      host: 'ftp.example.com',
      port: 21,
      user: 'user',
      password: 'password',
      root: 'uploads'
    },
    ssh: {
      driver: 'ssh', // resolves using SFTP ssh driver
      host: 'sftp.example.com',
      port: 22,
      username: 'user',
      password: 'password',
      root: 'uploads'
    },
    sftp: {
      driver: 'sftp',
      host: 'sftp.example.com',
      port: 22,
      username: 'user',
      password: 'password',
      root: 'uploads'
    },
    scoped: {
      driver: 'scoped',
      disk: 's3',
      prefix: 'tenant-a'
    },
    readonly: {
      driver: 'scoped',
      disk: 's3',
      prefix: 'archives',
      readOnly: true
    }
  }
};
```

---

## Interacting with Disks

You can run operations using the `Storage` facade. By default, operations are run on the configured `default` disk.

### Switching Disks

```typescript
import { Storage } from '@lib/storage/Storage.js';

// Run on default disk (e.g. 'local')
await Storage.put('file.txt', 'Contents');

// Run on S3 disk specifically
await Storage.disk('s3').put('avatars/avatar-1.png', fileBuffer);

// Use the configured cloud disk
await Storage.cloud().put('exports/report.csv', csv);

// Build an on-demand disk
const tenantDisk = Storage.build({ driver: 'local', root: '/tmp/tenant-a' });
await tenantDisk.put('file.txt', 'contents');
```

---

## File Operations

The `Disk` interface supports a comprehensive set of file manipulation APIs:

### Reading & Writing Files

```typescript
// Create or overwrite file
await Storage.put('document.txt', 'Hello World');

// Retrieve file contents
const contentBuffer = await Storage.get('document.txt');
console.log(contentBuffer.toString());

// Check if file exists
if (await Storage.exists('document.txt')) {
  // ...
}

if (await Storage.missing('missing.txt')) {
  // ...
}

const allPresent = await Storage.existsAll(['a.txt', 'b.txt']);
const anyMissing = await Storage.missingAny(['a.txt', 'b.txt']);
```

For multipart upload wrappers and `UploadedFile.store()` helpers, see [Uploaded Files](./uploaded-files.md).

### Deleting Files

```typescript
// Delete a single file
await Storage.delete('document.txt');
```

### Copying & Moving Files

```typescript
// Copy file
await Storage.copy('source.txt', 'backup/copy.txt');

// Move / Rename file
await Storage.move('source.txt', 'archive/moved.txt');
```

### Metadata Helpers

```typescript
// Get file size in bytes
const bytes = await Storage.size('photo.jpg');

// Get last modified Date object
const mtime = await Storage.lastModified('photo.jpg');

// Get mime type string
const mime = await Storage.mimeType('photo.jpg'); // "image/jpeg"

// Hash file contents
const md5 = await Storage.checksum('photo.jpg');
```

---

## Directories

Manage folders inside your storage disks:

```typescript
// Get all files inside a directory (returns relative path strings)
const files = await Storage.files('reports');
const recursiveFiles = await Storage.allFiles('reports');

// Get subdirectories
const directories = await Storage.directories('reports');
const recursiveDirectories = await Storage.allDirectories('reports');

// Create a directory
await Storage.makeDirectory('invoices/pending');

// Recursively delete directory
await Storage.deleteDirectory('invoices/pending');
```

---

## File Streams

For reading or writing large files without consuming excessive system memory:

```typescript
import { createReadStream } from 'fs';

// Read file stream
const readable = await Storage.readStream('videos/large-movie.mp4');

// Write stream (pipes a stream directly into storage target)
const localStream = createReadStream('local-file.zip');
await Storage.writeStream('uploads/archive.zip', localStream);
```

---

## File URLs & Expirations

### Public URLs

Retrieve the public web URL path for a given file:

```typescript
const url = Storage.disk('public').url('avatars/user-12.jpg');
// returns "http://localhost:3000/storage/public/avatars/user-12.jpg"
```

### Temporary Signed URLs

Create temporary secure URLs to files (especially useful for downloading private assets on S3 or local disk):

```typescript
const expirationDate = new Date(Date.now() + 60 * 1000); // 1 minute from now

// Generates S3 presigned URL with X-Amz-Signature parameters
const signedUrl = await Storage.disk('s3').temporaryUrl('reports/private-financials.pdf', expirationDate);

const upload = await Storage.temporaryUploadUrl('uploads/incoming.csv', expirationDate);
// { url, headers }
```

--- 

## HTTP Responses

Controllers can return files from any configured disk:

```typescript
Route.get('/reports/:name', (request, response) => {
  return response.storageDownload(`reports/${request.params.name}`, 's3');
});
```

---

## File Visibility Settings

In Maxima, you can manage files with public or private visibility:

- **`public`**: Files should be accessible by anyone. Local files are written with readable chmod parameters (`0o644`).
- **`private`**: Files are restricted. Local files are written with read-only permissions (`0o600`).

```typescript
// 1. Set visibility dynamically on files
await Storage.setVisibility('secret.txt', 'private');

// 2. Retrieve visibility state
const visibility = await Storage.getVisibility('secret.txt'); // returns "private"
```

--- 

## Scoped, Read-Only, and Throwing Disks

Scoped disks prepend a path prefix to every operation. Read-only disks reject write operations. Set `throw: false` to return safe fallback values for read/write failures, or `throw: true` to surface adapter errors.

```typescript
await Storage.disk('scoped').put('avatar.jpg', image);
await Storage.disk('readonly').get('archive.zip');
```

---

## Testing File Storage

Mock the filesystem inside tests using `Storage.fake()`:

```typescript
import { Storage } from '@lib/storage/Storage.js';

// 1. Mock 'public' disk (instantiates an in-memory disk)
Storage.fake('public');

// 2. Perform write operations in code
await Storage.disk('public').put('avatars/1.txt', 'ok');

// 3. Make assertions
const exists = await Storage.disk('public').exists('avatars/1.txt');
expect(exists).toBe(true);
await Storage.assertExists(['avatars/1.txt']);
await Storage.assertMissing('avatars/missing.txt');
await Storage.assertCount('avatars', 1);
await Storage.assertDirectoryEmpty('empty-dir');

// Restore original adapter connections
Storage.restore();
```
