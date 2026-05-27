# Localization & Translation

Maxima's localization services provide a convenient way to retrieve strings in various languages, allowing you to easily support internationalization in your application.

---

## Configuration

Configure your default application locale and fallback language settings in `src/config/app.ts`:

```typescript
export default {
  locale: 'en',
  fallback_locale: 'en'
};
```

---

## Translation Files

Translation strings are stored in files within the `src/resources/lang/` directory.

### Directory Structure

```text
src/resources/lang/
├── en.json
├── fr.json
├── en/
│   ├── messages.json
│   └── admin.js
└── fr/
    └── messages.json
```

- **Root JSON Files (`en.json`)**: Map raw keys directly to translation strings.
- **Subdirectory Group Files (`en/messages.json`)**: Access keys scoped by the file name prefix (e.g. `messages.welcome`). Both JSON and JavaScript modules (using `export default`) are supported.

---

## Basic Translation Retrievals

Use the global `trans()` helper to retrieve translation strings:

```typescript
import { trans } from '@lib/foundation/helpers.js';

// Retrieve from root JSON
const welcome = await trans('Welcome to our site');

// Retrieve from group files
const welcomeFromGroup = await trans('messages.welcome');
const adminTitle = await trans('admin.dashboard.title');
```

### Placeholders & Case Conversions

You can define placeholders in your translation strings. All placeholders are prefixed with a colon (`:`):

```json
{
  "greeting": "Hello :name",
  "receipt": ":Name paid :AMOUNT"
}
```

Maxima automatically handles replacement casing:
- `:name` -> kept as-is (`ada` -> `ada`)
- `:Name` -> capitalizes the first letter (`ada` -> `Ada`)
- `:NAME` -> capitalizes all letters (`ada` -> `ADA`)

```typescript
const msg = await trans('messages.receipt', {
  name: 'ada',
  amount: '$10.00'
});
// returns "Ada paid $10.00"
```

### Stringable Replacements

If you pass a custom object/class as a placeholder value, you can register a stringable mapping callback so the translator knows how to automatically convert it to a string:

```typescript
import { stringable } from '@lib/foundation/helpers.js';
import { Money } from '../Utils/Money.js';

// Define stringable callback for Money class
stringable(Money, (money) => `$${money.amount.toFixed(2)}`);

const msg = await trans('messages.receipt', {
  name: 'ada',
  amount: new Money(12.5) // Auto-converts to "$12.50"
});
```

---

## Pluralization (Choice Messages)

Maxima supports pluralization using standard ICU (Internationalization Components for Unicode) plural rules.

### Defining Plural Strings

Use the `{parameter, plural, ...}` syntax inside your json values:

```json
{
  "files": "{count, plural, =0 {No files} one {One file} other {# files}}"
}
```

### Retrieving Plural Choices

Retrieve pluralized choices using `transChoice()`:

```typescript
import { transChoice } from '@lib/foundation/helpers.js';

const zero = await transChoice('messages.files', 0); // "No files"
const one = await transChoice('messages.files', 1);  // "One file"
const multiple = await transChoice('messages.files', 5); // "5 files"
```

### Pluralizer Utilities

You can change the active pluralizer language context or pluralize nouns:

```typescript
import { pluralize, usePluralizer } from '@lib/foundation/helpers.js';

// Pluralize words
console.log(pluralize('paper')); // "papers"

// Switch pluralizer language rules
usePluralizer('spanish');
console.log(pluralize('papel')); // "papeles"
```

---

## Scoping Locales

### Setting Locales Globally
```typescript
import { setLocale, setFallbackLocale } from '@lib/foundation/helpers.js';

setLocale('fr');
setFallbackLocale('en');
```

### Temporary Runtime Scoping
Execute operations within a specific locale context using the `withLocale` helper:

```typescript
import { withLocale, trans } from '@lib/foundation/helpers.js';

// Temporarily uses 'fr' locale context
const message = await withLocale('fr', async () => {
  return await trans('messages.welcome'); // "Bonjour"
});
```

---

## Vendor Package Translations

Packages can load translation namespaces:

```text
src/resources/lang/vendor/acme/en/messages.json
```

Access these namespaces by prefixing the package name followed by `::`:

```typescript
const text = await trans('acme::messages.shipped');
```

---

## Missing Key Events

When a translation key is missing, Maxima dispatches a `TranslationMissing` event:

```typescript
import { Event } from '@lib/events/Event.js';
import { TranslationMissing } from '@lib/translation/Translator.js';

Event.listen(TranslationMissing, (event) => {
  console.warn(`Missing key: ${event.key} in locale: ${event.locale}`);
});
```

---

## Publishing Defaults

To customize default framework validation or fallback messages, publish the core language files to your source folder:

```bash
npm run maxima -- lang:publish
```
This command copies validation and framework message assets into `src/resources/lang/en/`.
