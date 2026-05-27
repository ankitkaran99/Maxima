# Uploaded Files

`UploadedFile` wraps multipart upload streams and stores them through the filesystem manager.

```typescript
import { UploadedFile } from '@lib/index.js';
```

## File Metadata

```typescript
const name = file.originalName();
const extension = file.extension();
const mime = file.mimeType();
const bytes = file.size();
const path = file.path();
```

`size()` returns the upload stream's `bytesRead` value when available.

## Storing Files

Store a file with a timestamped name:

```typescript
const storedPath = await file.store('avatars');
```

Store a file with an explicit name:

```typescript
const storedPath = await file.storeAs('avatars', 'ada.png');
```

Move to a destination path:

```typescript
await file.move('avatars/ada.png');
```

Use a specific disk:

```typescript
await file.store('avatars', 's3');
await file.storeAs('avatars', 'ada.png', 'public');
```

`storePublicly(directory, disk?)` stores on the `public` disk by default:

```typescript
await file.storePublicly('avatars');
```

All storage methods return the path written relative to the selected disk.
