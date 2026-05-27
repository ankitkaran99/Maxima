# Security & Cryptography

Maxima provides robust facilities for encrypting and decrypting data using AES-256-GCM, alongside secure password hashing based on the industry-standard Argon2 algorithm.

---

## Configuration

Set your primary application encryption key inside `.env`:

```env
APP_KEY=base64:some-random-32-byte-base64-encoded-key
APP_PREVIOUS_KEYS=base64:older-key-1,base64:older-key-2
```

> [!CAUTION]
> If your application key is compromised, all encrypted data (including session payloads and database encrypted fields) can be decrypted. Never share your application key.

---

## Cryptography (`Crypt`)

The `Crypt` facade handles encrypting and decrypting values using the `aes-256-gcm` cipher. All encrypted payloads are automatically signed with a GCM authentication tag to prevent tampering.

### Encrypting Values

You can encrypt strings, objects, or arrays. Objects and arrays are automatically JSON-serialized before encryption:

```typescript
import { Crypt } from '@lib/security/Crypt.js';

// Encrypt a string
const encryptedText = Crypt.encryptString('Hello World');

// Encrypt an object/array
const encryptedData = Crypt.encrypt({
  secret_code: '1234',
  expires_at: '2026-12-31'
});
```

### Decrypting Values

If a payload cannot be decrypted (due to tampered signatures or an invalid key), a `DecryptException` is thrown:

```typescript
import { Crypt, DecryptException } from '@lib/security/Crypt.js';

try {
  // Decrypt string
  const text = Crypt.decryptString(encryptedText); // "Hello World"

  // Decrypt object
  const data = Crypt.decrypt<{ secret_code: string }>(encryptedData);
  console.log(data.secret_code); // "1234"
} catch (error) {
  if (error instanceof DecryptException) {
    console.error('Payload decryption failed.');
  }
}
```

### Cryptographic Key Rotation

When you rotate your application key (`APP_KEY` in `.env`), any previously encrypted data would normally fail to decrypt. Maxima supports seamless key rotation:

1. Put the new key in `APP_KEY`.
2. Append the old key(s) to `APP_PREVIOUS_KEYS` (separated by commas).

When decrypting, `Crypt` checks the primary key first. If decryption fails, it loops through the keys in `APP_PREVIOUS_KEYS` until it finds one that succeeds.

---

## Hashing (`Hash`)

Passwords should always be hashed rather than encrypted. Maxima's `Hash` facade uses Argon2 to securely hash passwords.

### Hashing Passwords

```typescript
import { Hash } from '@lib/security/Hash.js';

// Hash a password
const hashedPassword = await Hash.make('my-secure-password');
```

### Custom Hashing Options

You can pass custom Argon2 hashing options during hash generation:

```typescript
const hashedPassword = await Hash.make('password', {
  memoryCost: 2 ** 16, // 64MB memory cost
  timeCost: 4,         // 4 iterations
  parallelism: 2       // 2 threads
});
```

### Verifying Passwords

```typescript
const isCorrect = await Hash.check('my-secure-password', hashedPassword); // returns boolean
```

### Checking if a Password Needs to be Rehashed

If you increase your global Argon2 security settings, you can check if existing stored password hashes need to be regenerated:

```typescript
if (Hash.needsRehash(user.password)) {
  user.password = await Hash.make('my-secure-password');
  await user.save();
}
```
