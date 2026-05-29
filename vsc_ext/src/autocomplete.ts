import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getMaximaRootPath } from './commands';

interface MethodSuggestion {
  name: string;
  desc: string;
  snippet: string;
}

interface ModelMeta {
  className: string;
  fields: string[];
  relations: string[];
}

export class MaximaCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
    
    // Get the line content up to the cursor position
    const lineText = document.lineAt(position).text.substring(0, position.character);
    
    const completions: vscode.CompletionItem[] = [];
    const rootPath = getMaximaRootPath();
    if (!rootPath) {
      return completions;
    }

    const models = this.getModels(rootPath);

    // 1. Check for config('...') or Config.get('...') or config()->string('...') autocomplete
    // Support: Config::getMany(['...']) array elements, or fluid config()->string('...')
    const configRegex = /(?:config|Config\.get|Config\.getMany|config\(\)(?:\.[a-zA-Z0-9_]+)*)\(['"]([^'"]*)$/;
    const configMatch = configRegex.exec(lineText);
    if (configMatch) {
      const keys = this.getConfigKeys(rootPath);
      for (const key of keys) {
        const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Value);
        item.detail = 'Config Key';
        completions.push(item);
      }
      return completions;
    }

    // Config.getMany array elements trigger (e.g. inside Config.getMany([ '...' ]))
    if (lineText.includes('Config.getMany') && /['"]([^'"]*)$/.test(lineText)) {
      const keys = this.getConfigKeys(rootPath);
      for (const key of keys) {
        const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Value);
        item.detail = 'Config Key';
        completions.push(item);
      }
      return completions;
    }

    // 2. Check for view('...') or viewExists('...') or renderEmail('...') or Route.view('/path', '...') autocomplete
    const viewRegex = /(?:view|viewExists|renderEmail|viewFirst)\(['"]([^'"]*)$/;
    const routeViewRegex = /Route\.view\(\s*['"][^'"]*['"]\s*,\s*['"]([^'"]*)$/;
    const viewMatch = viewRegex.exec(lineText) || routeViewRegex.exec(lineText);
    if (viewMatch) {
      const keys = this.getViewKeys(rootPath);
      for (const key of keys) {
        const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.File);
        item.detail = 'View Template (.edge)';
        completions.push(item);
      }
      return completions;
    }

    // 3. Check for route('...') or signedRoute('...') or Redirect.route('...') autocomplete
    const routeRegex = /(?:route|signedRoute|Redirect\.route|Redirect\.signedRoute|URL\.route|URL\.signedRoute|redirect\(\)\.route)\(['"]([^'"]*)$/;
    const routeMatch = routeRegex.exec(lineText);
    if (routeMatch) {
      const names = this.getRouteNames(rootPath);
      for (const name of names) {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Reference);
        item.detail = 'Route Name';
        completions.push(item);
      }
      return completions;
    }


    // 3c. Check for middleware('...') or Route.middleware(['...']) autocomplete
    const middlewareRegex = /(?:middleware|withoutMiddleware)\(\s*\[?\s*['"]([^'"]*)$/;
    const middlewareArrayRegex = /(?:middleware|withoutMiddleware)\(\s*\[\s*(?:['"][^'"]+['"]\s*,\s*)*['"]([^'"]*)$/;
    const middlewareMatch = middlewareRegex.exec(lineText) || middlewareArrayRegex.exec(lineText);
    if (middlewareMatch) {
      const keys = this.getMiddlewareKeys(rootPath);
      for (const key of keys) {
        const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.EnumMember);
        item.detail = 'Middleware Alias/Group';
        completions.push(item);
      }
      return completions;
    }

    // 3d. Check for trans('...') or __('...') translation autocomplete
    const transRegex = /(?:trans|__|Lang\.get|Lang\.has)\(['"]([^'"]*)$/;
    const transMatch = transRegex.exec(lineText);
    if (transMatch) {
      const keys = this.getTranslationKeys(rootPath);
      for (const key of keys) {
        const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Text);
        item.detail = 'Translation Key';
        completions.push(item);
      }
      return completions;
    }

    // 3e. Check for translation parameter autocomplete, e.g. __('auth.welcome', { |[cursor] })
    const transParamRegex = /(?:trans|__|Lang\.get)\(['"]([^'"]+)['"]\s*,\s*\{\s*([^}]*)$/;
    const transParamMatch = transParamRegex.exec(lineText);
    if (transParamMatch) {
      const transKey = transParamMatch[1];
      const placeholders = this.getTranslationPlaceholders(rootPath, transKey);
      for (const placeholder of placeholders) {
        const item = new vscode.CompletionItem(placeholder, vscode.CompletionItemKind.Variable);
        item.detail = 'Translation Placeholder';
        item.insertText = new vscode.SnippetString(`${placeholder}: '\${1:value}',`);
        completions.push(item);
      }
      return completions;
    }

    // 3f. Check for app('...') or App.make('...') trigger
    const appBindingRegex = /(?:app|App\.make|App\.bound|App\.isShared|app\(\)\.make)\(['"]([^'"]*)$/;
    const appBindingMatch = appBindingRegex.exec(lineText);
    if (appBindingMatch) {
      const bindings = this.getAppBindings(rootPath);
      for (const binding of bindings) {
        const item = new vscode.CompletionItem(binding, vscode.CompletionItemKind.Interface);
        item.detail = 'Container Binding';
        completions.push(item);
      }
      return completions;
    }

    // 4. Check for asset('...') autocomplete
    const assetRegex = /asset\(['"]([^'"]*)$/;
    const assetMatch = assetRegex.exec(lineText);
    if (assetMatch) {
      const files = this.getAssetsList(rootPath);
      for (const file of files) {
        const item = new vscode.CompletionItem(file, vscode.CompletionItemKind.File);
        item.detail = 'Asset File';
        completions.push(item);
      }
      return completions;
    }

    // 5. Check for Storage method path autocomplete
    const storagePathRegex = /Storage\.(?:get|put|exists|delete|url|path|size)\(['"]([^'"]*)$/;
    const storagePathMatch = storagePathRegex.exec(lineText);
    if (storagePathMatch) {
      const storageAppDir = path.join(rootPath, 'storage', 'app');
      const files = this.getDirFiles(storageAppDir, storageAppDir);
      for (const file of files) {
        const item = new vscode.CompletionItem(file, vscode.CompletionItemKind.File);
        item.detail = 'Storage File';
        completions.push(item);
      }
      return completions;
    }

    // 6. Check for path helper autocompletions (base_path, app_path, config_path, database_path, resource_path, storage_path, public_path)
    const pathHelpers = [
      { regex: /(?:base_path|basePath)\(['"]([^'"]*)$/, subDir: '' },
      { regex: /(?:app_path|appPath)\(['"]([^'"]*)$/, subDir: 'src/app' },
      { regex: /(?:config_path|configPath)\(['"]([^'"]*)$/, subDir: 'src/config' },
      { regex: /(?:database_path|databasePath)\(['"]([^'"]*)$/, subDir: 'src/database' },
      { regex: /(?:resource_path|resourcePath)\(['"]([^'"]*)$/, subDir: 'src/resources' },
      { regex: /(?:storage_path|storagePath)\(['"]([^'"]*)$/, subDir: 'storage' },
      { regex: /(?:public_path|publicPath)\(['"]([^'"]*)$/, subDir: 'public' }
    ];

    for (const helper of pathHelpers) {
      const helperMatch = helper.regex.exec(lineText);
      if (helperMatch) {
        const targetDir = path.join(rootPath, helper.subDir);
        const files = this.getDirFiles(targetDir, targetDir);
        for (const file of files) {
          const item = new vscode.CompletionItem(file, vscode.CompletionItemKind.File);
          item.detail = 'Path Helper File';
          completions.push(item);
        }
        return completions;
      }
    }

    // --- Eloquent Autocomplete Checks ---

    // Eloquent: 1. Model Static methods trigger (e.g., User.)
    const modelNames = models.map(m => m.className);
    if (modelNames.length > 0) {
      const modelStaticRegex = new RegExp(`\\b(${modelNames.join('|')})\\.$`);
      const modelStaticMatch = modelStaticRegex.exec(lineText);
      if (modelStaticMatch) {
        const methods = [
          { name: 'query', desc: 'Begin querying the model', snippet: 'query()' },
          { name: 'find', desc: 'Find a model by its primary key', snippet: "find(${1:id})" },
          { name: 'findOrFail', desc: 'Find a model by its primary key or throw an error', snippet: "findOrFail(${1:id})" },
          { name: 'all', desc: 'Get all of the models from the database', snippet: 'all()' },
          { name: 'where', desc: 'Add a basic where clause to the query', snippet: "where('${1:column}', ${2:value})" },
          { name: 'create', desc: 'Save a new model and return the instance', snippet: "create({ $1 })" },
          { name: 'make', desc: 'Create a new instance of the model without saving it', snippet: "make({ $1 })" },
          { name: 'with', desc: 'Begin querying the model with relations', snippet: "with([$1])" },
          { name: 'first', desc: 'Execute the query and get the first result', snippet: 'first()' }
        ];
        this.addMethods(completions, modelStaticMatch[1], methods);
        return completions;
      }

      // Eloquent: 2. Where / orderBy field auto-completion (e.g. User.where(')
      const whereFieldRegex = new RegExp(`\\b(${modelNames.join('|')})\\b.*?(?:where|whereNull|whereNotNull|whereIn|orderBy)\\(['"]([^'"]*)$`);
      const whereFieldMatch = whereFieldRegex.exec(lineText);
      if (whereFieldMatch) {
        const modelName = whereFieldMatch[1];
        const model = models.find(m => m.className === modelName);
        if (model) {
          for (const field of model.fields) {
            const item = new vscode.CompletionItem(field, vscode.CompletionItemKind.Field);
            item.detail = `${modelName} Field`;
            completions.push(item);
          }
          return completions;
        }
      }

      // Eloquent: 3. Create / Make key-value field autocomplete (e.g. User.create({ )
      const createKeysRegex = new RegExp(`\\b(${modelNames.join('|')})\\b.*?(?:create|make|new\\s+\\1)\\(\\s*\\{\\s*([^}]*)$`);
      const createKeysMatch = createKeysRegex.exec(lineText);
      if (createKeysMatch) {
        const modelName = createKeysMatch[1];
        const model = models.find(m => m.className === modelName);
        if (model) {
          for (const field of model.fields) {
            if (field === 'id' || field === 'created_at' || field === 'updated_at') continue;
            const item = new vscode.CompletionItem(field, vscode.CompletionItemKind.Property);
            item.detail = `${modelName} Fillable Field`;
            item.insertText = new vscode.SnippetString(`${field}: \${1:value},`);
            completions.push(item);
          }
          return completions;
        }
      }

      // Eloquent: 4. With relations autocomplete (e.g. User.with(')
      const withRelationRegex = new RegExp(`\\b(${modelNames.join('|')})\\b.*?\\bwith\\(\\s*\\[?\\s*['"]([^'"]*)$`);
      const withRelationMatch = withRelationRegex.exec(lineText);
      if (withRelationMatch) {
        const modelName = withRelationMatch[1];
        const model = models.find(m => m.className === modelName);
        if (model) {
          for (const rel of model.relations) {
            const item = new vscode.CompletionItem(rel, vscode.CompletionItemKind.Reference);
            item.detail = `${modelName} Relation`;
            completions.push(item);
          }
          return completions;
        }
      }
    }

    // Eloquent: 5. Query Builder chain methods (e.g. after a query() or where())
    if (/\.(?:query\(\)|where\([^)]*\)|with\([^)]*\)|orderBy\([^)]*\)|limit\(\d+\))\.$/.test(lineText)) {
      const builderMethods = [
        { name: 'where', desc: 'Add a basic where clause to the query', snippet: "where('${1:column}', ${2:value})" },
        { name: 'whereNull', desc: 'Add a where null clause to the query', snippet: "whereNull('${1:column}')" },
        { name: 'whereNotNull', desc: 'Add a where not null clause to the query', snippet: "whereNotNull('${1:column}')" },
        { name: 'whereIn', desc: 'Add a where in clause to the query', snippet: "whereIn('${1:column}', [${2:values}])" },
        { name: 'orWhere', desc: 'Add an or where clause to the query', snippet: "orWhere('${1:column}', ${2:value})" },
        { name: 'with', desc: 'Eager load relationships', snippet: "with([$1])" },
        { name: 'orderBy', desc: 'Order results by column', snippet: "orderBy('${1:column}', '${2:asc}')" },
        { name: 'limit', desc: 'Limit the number of results', snippet: "limit(${1:10})" },
        { name: 'first', desc: 'Execute the query and get the first result', snippet: 'first()' },
        { name: 'firstOrFail', desc: 'Execute the query and get the first result or throw error', snippet: 'firstOrFail()' },
        { name: 'get', desc: 'Execute the query and get all results', snippet: 'get()' },
        { name: 'update', desc: 'Update records matching the query', snippet: "update({ $1 })" },
        { name: 'delete', desc: 'Delete records matching the query', snippet: 'delete()' }
      ];
      this.addMethods(completions, 'QueryBuilder', builderMethods);
      return completions;
    }

    // Eloquent: 6. Sub-query closure methods (e.g., query. or q.)
    if (/\b(query|q|builder|trx)\.$/.test(lineText)) {
      const queryMethods = [
        { name: 'where', desc: 'Add a basic where clause', snippet: "where('${1:column}', ${2:value})" },
        { name: 'whereNull', desc: 'Add a where null clause', snippet: "whereNull('${1:column}')" },
        { name: 'whereNotNull', desc: 'Add a where not null clause', snippet: "whereNotNull('${1:column}')" },
        { name: 'whereIn', desc: 'Add a where in clause', snippet: "whereIn('${1:column}', [${2:values}])" },
        { name: 'limit', desc: 'Limit results', snippet: 'limit(${1:10})' },
        { name: 'orderBy', desc: 'Order results', snippet: "orderBy('${1:column}', '${2:asc}')" },
        { name: 'select', desc: 'Select columns', snippet: "select(${1:'column'})" }
      ];
      this.addMethods(completions, 'Closure', queryMethods);
      return completions;
    }

    // --- Validation Rules Autocomplete Checks ---
    const isValidationContext = lineText.includes('validate') || lineText.includes('rules') || lineText.includes('sometimes');
    if (isValidationContext) {
      const stringLiteralMatch = /['"]([^'"]*)$/.exec(lineText);
      if (stringLiteralMatch) {
        const rules = [
          { name: 'required', desc: 'The field under validation must be present in the input data and not empty.' },
          { name: 'email', desc: 'The field under validation must be formatted as an email address.' },
          { name: 'string', desc: 'The field under validation must be a string.' },
          { name: 'numeric', desc: 'The field under validation must be numeric.' },
          { name: 'integer', desc: 'The field under validation must be an integer.' },
          { name: 'boolean', desc: 'The field under validation must be able to be cast as a boolean.' },
          { name: 'array', desc: 'The field under validation must be an array.' },
          { name: 'confirmed', desc: 'The field under validation must have a matching field of foo_confirmation.' },
          { name: 'nullable', desc: 'The field under validation may be null.' },
          { name: 'url', desc: 'The field under validation must be a valid URL.' },
          { name: 'date', desc: 'The field under validation must be a valid date.' },
          { name: 'accepted', desc: 'The field under validation must be yes, on, 1, or true.' },
          { name: 'min:', desc: 'The field under validation must have a minimum value/length.', snippet: 'min:${1:value}' },
          { name: 'max:', desc: 'The field under validation must have a maximum value/length.', snippet: 'max:${1:value}' },
          { name: 'unique:', desc: 'The field under validation must be unique in a given database table.', snippet: 'unique:${1:table},${2:column}' },
          { name: 'exists:', desc: 'The field under validation must exist in a given database table.', snippet: 'exists:${1:table},${2:column}' }
        ];

        for (const rule of rules) {
          const item = new vscode.CompletionItem(rule.name, vscode.CompletionItemKind.Keyword);
          item.detail = 'Validation Rule';
          item.documentation = new vscode.MarkdownString(rule.desc);
          if ('snippet' in rule) {
            item.insertText = new vscode.SnippetString(rule.snippet);
          }
          completions.push(item);
        }
        return completions;
      }
    }

    // 7. Check for Facade method triggers (e.g. Route., DB., Schema., etc.)
    if (lineText.endsWith('Route.')) {
      const methods: MethodSuggestion[] = [
        { name: 'get', desc: 'Define a GET route', snippet: "get('${1:/path}', async (${2:request}) => {\n\treturn ${3:{ status: 'success' }};\n})" },
        { name: 'post', desc: 'Define a POST route', snippet: "post('${1:/path}', async (${2:request}) => {\n\treturn ${3:{ status: 'success' }};\n})" },
        { name: 'put', desc: 'Define a PUT route', snippet: "put('${1:/path}', async (${2:request}) => {\n\treturn ${3:{ status: 'success' }};\n})" },
        { name: 'delete', desc: 'Define a DELETE route', snippet: "delete('${1:/path}', async (${2:request}) => {\n\treturn ${3:{ status: 'success' }};\n})" },
        { name: 'patch', desc: 'Define a PATCH route', snippet: "patch('${1:/path}', async (${2:request}) => {\n\treturn ${3:{ status: 'success' }};\n})" },
        { name: 'options', desc: 'Define an OPTIONS route', snippet: "options('${1:/path}', async (${2:request}) => {\n\treturn ${3:{ status: 'success' }};\n})" },
        { name: 'any', desc: 'Define a route that responds to all HTTP verbs', snippet: "any('${1:/path}', async (${2:request}) => {\n\treturn ${3:{ status: 'success' }};\n})" },
        { name: 'match', desc: 'Define a route that responds to specific HTTP verbs', snippet: "match([${1:'GET', 'POST'}], '${2:/path}', async (${3:request}) => {\n\treturn ${4:{ status: 'success' }};\n})" },
        { name: 'group', desc: 'Create a route group to share attributes', snippet: "group({ prefix: '${1:/api}', middleware: [${2:'auth'}] }, () => {\n\t$0\n})" },
        { name: 'prefix', desc: 'Define a route group with a common prefix', snippet: "prefix('${1:prefix}').group(() => {\n\t$0\n})" },
        { name: 'middleware', desc: 'Apply middleware to a route group or route', snippet: "middleware([${1:'auth'}]).group(() => {\n\t$0\n})" },
        { name: 'redirect', desc: 'Define a redirect route', snippet: "redirect('${1:from}', '${2:to}', ${3:302})" },
        { name: 'fallback', desc: 'Define a fallback route for unmatched requests', snippet: "fallback(async (${1:request}) => {\n\treturn ${2:{ error: 'Not Found' }};\n})" }
      ];
      this.addMethods(completions, 'Route', methods);
    } 
    else if (lineText.endsWith('DB.')) {
      const methods: MethodSuggestion[] = [
        { name: 'table', desc: 'Begin a query against a database table', snippet: "table('${1:users}')" },
        { name: 'transaction', desc: 'Execute database operations inside a transaction', snippet: "transaction(async (trx) => {\n\tawait DB.table('${1:users}').transacting(trx).insert({ $2 });\n\t$0\n})" },
        { name: 'raw', desc: 'Create a raw query expression', snippet: "raw('${1:sql}', [${2:bindings}])" },
        { name: 'select', desc: 'Run a select statement against the database', snippet: "select('${1:SELECT * FROM users}')" },
        { name: 'insert', desc: 'Run an insert statement', snippet: "insert('${1:INSERT INTO users (name) VALUES (?)}', [${2:name}])" },
        { name: 'update', desc: 'Run an update statement', snippet: "update('${1:UPDATE users SET status = ? WHERE id = ?}', [${2:status, id}])" },
        { name: 'delete', desc: 'Run a delete statement', snippet: "delete('${1:DELETE FROM users WHERE id = ?}', [${2:id}])" },
        { name: 'connection', desc: 'Select a specific database connection', snippet: "connection('${1:mysql}')" }
      ];
      this.addMethods(completions, 'DB', methods);
    } 
    else if (lineText.endsWith('Schema.')) {
      const methods: MethodSuggestion[] = [
        { name: 'create', desc: 'Create a new table on the database schema', snippet: "create('${1:table}', (table) => {\n\ttable.increments('id');\n\t$0\n\ttable.timestamps();\n})" },
        { name: 'table', desc: 'Alter an existing table on the database schema', snippet: "table('${1:table}', (table) => {\n\t$0\n})" },
        { name: 'drop', desc: 'Drop a table from the schema', snippet: "drop('${1:table}')" },
        { name: 'dropIfExists', desc: 'Drop a table from the schema if it exists', snippet: "dropIfExists('${1:table}')" },
        { name: 'hasTable', desc: 'Determine if the given table exists', snippet: "hasTable('${1:table}')" },
        { name: 'hasColumn', desc: 'Determine if the given table has a given column', snippet: "hasColumn('${1:table}', '${2:column}')" },
        { name: 'rename', desc: 'Rename a table on the schema', snippet: "rename('${1:from}', '${2:to}')" },
        { name: 'dropColumns', desc: 'Drop columns from a table', snippet: "dropColumns('${1:table}', [${2:'column1'}])" },
        { name: 'renameColumn', desc: 'Rename a column on a table', snippet: "renameColumn('${1:table}', '${2:from}', '${3:to}')" },
        { name: 'createCacheTable', desc: 'Generate standard schema for cache table', snippet: "createCacheTable('${1:cache}')" },
        { name: 'createSessionTable', desc: 'Generate standard schema for sessions table', snippet: "createSessionTable('${1:sessions}')" },
        { name: 'createNotificationsTable', desc: 'Generate standard schema for notifications table', snippet: "createNotificationsTable('${1:notifications}')" },
        { name: 'createQueueTables', desc: 'Generate standard schema for queue and failed jobs tables', snippet: "createQueueTables('${1:jobs}', '${2:failed_jobs}')" },
        { name: 'createBatchTable', desc: 'Generate standard schema for job batches table', snippet: "createBatchTable('${1:job_batches}')" }
      ];
      this.addMethods(completions, 'Schema', methods);
    } 
    else if (lineText.endsWith('Cache.')) {
      const methods: MethodSuggestion[] = [
        { name: 'get', desc: 'Retrieve an item from the cache', snippet: "get('${1:key}', ${2:defaultValue})" },
        { name: 'set', desc: 'Store an item in the cache', snippet: "set('${1:key}', ${2:value}, ${3:ttlInSeconds})" },
        { name: 'has', desc: 'Determine if an item exists in the cache', snippet: "has('${1:key}')" },
        { name: 'forget', desc: 'Remove an item from the cache', snippet: "forget('${1:key}')" },
        { name: 'remember', desc: 'Get an item from the cache, or store the default value if it doesn\'t exist', snippet: "remember('${1:key}', ${2:ttlInSeconds}, async () => {\n\treturn $3;\n})" },
        { name: 'rememberForever', desc: 'Get an item from the cache, or store the default value forever', snippet: "rememberForever('${1:key}', async () => {\n\treturn $2;\n})" },
        { name: 'increment', desc: 'Increment the value of an item in the cache', snippet: "increment('${1:key}', ${2:1})" },
        { name: 'decrement', desc: 'Decrement the value of an item in the cache', snippet: "decrement('${1:key}', ${2:1})" },
        { name: 'flush', desc: 'Wipe the entire cache', snippet: "flush()" }
      ];
      this.addMethods(completions, 'Cache', methods);
    } 
    else if (lineText.endsWith('Storage.')) {
      const methods: MethodSuggestion[] = [
        { name: 'disk', desc: 'Get a storage disk instance by name', snippet: "disk('${1:local}')" },
        { name: 'get', desc: 'Retrieve the contents of a file', snippet: "get('${1:path}')" },
        { name: 'put', desc: 'Write the contents of a file to disk', snippet: "put('${1:path}', ${2:contents})" },
        { name: 'exists', desc: 'Determine if a file exists on disk', snippet: "exists('${1:path}')" },
        { name: 'delete', desc: 'Delete the file at a given path', snippet: "delete('${1:path}')" },
        { name: 'url', desc: 'Get the URL for the file at the given path', snippet: "url('${1:path}')" },
        { name: 'path', desc: 'Get the fully qualified path to the file', snippet: "path('${1:path}')" },
        { name: 'size', desc: 'Get the size of a file in bytes', snippet: "size('${1:path}')" }
      ];
      this.addMethods(completions, 'Storage', methods);
    } 
    else if (lineText.endsWith('Log.')) {
      const methods: MethodSuggestion[] = [
        { name: 'info', desc: 'Log an informational message', snippet: "info('${1:message}', ${2:{}})" },
        { name: 'debug', desc: 'Log a debug message', snippet: "debug('${1:message}', ${2:{}})" },
        { name: 'warning', desc: 'Log a warning message', snippet: "warning('${1:message}', ${2:{}})" },
        { name: 'error', desc: 'Log an error message', snippet: "error('${1:message}', ${2:{}})" },
        { name: 'critical', desc: 'Log a critical message', snippet: "critical('${1:message}', ${2:{}})" },
        { name: 'alert', desc: 'Log an alert message', snippet: "alert('${1:message}', ${2:{}})" },
        { name: 'emergency', desc: 'Log an emergency message', snippet: "emergency('${1:message}', ${2:{}})" }
      ];
      this.addMethods(completions, 'Log', methods);
    } 
    else if (lineText.endsWith('Auth.')) {
      const methods: MethodSuggestion[] = [
        { name: 'user', desc: 'Get the currently authenticated user instance', snippet: "user()" },
        { name: 'check', desc: 'Determine if the current user is authenticated', snippet: "check()" },
        { name: 'guest', desc: 'Determine if the current user is a guest', snippet: "guest()" },
        { name: 'id', desc: 'Get the ID of the currently authenticated user', snippet: "id()" },
        { name: 'login', desc: 'Log a user instance into the application', snippet: "login(${1:user})" },
        { name: 'logout', desc: 'Log the user out of the application', snippet: "logout()" },
        { name: 'attempt', desc: 'Attempt to authenticate a user using the credentials', snippet: "attempt(${1:credentials})" },
        { name: 'validate', desc: 'Validate user credentials without logging them in', snippet: "validate(${1:credentials})" }
      ];
      this.addMethods(completions, 'Auth', methods);
    } 
    else if (lineText.endsWith('Mail.')) {
      const methods: MethodSuggestion[] = [
        { name: 'to', desc: 'Specify the recipients of the mailable', snippet: "to('${1:email@example.com}')" },
        { name: 'send', desc: 'Send a mailable synchronously', snippet: "send(new ${1:WelcomeMail}($2))" },
        { name: 'queue', desc: 'Queue a mailable for background delivery', snippet: "queue(new ${1:WelcomeMail}($2))" },
        { name: 'later', desc: 'Schedule a mailable to be delivered in the future', snippet: "later(${1:delayInSeconds}, new ${2:WelcomeMail}($3))" }
      ];
      this.addMethods(completions, 'Mail', methods);
    } 
    else if (lineText.endsWith('Queue.')) {
      const methods: MethodSuggestion[] = [
        { name: 'push', desc: 'Push a new job onto the queue', snippet: "push(new ${1:ProcessPodcast}($2))" },
        { name: 'later', desc: 'Push a new job onto the queue after a delay', snippet: "later(${1:delayInSeconds}, new ${2:ProcessPodcast}($3))" },
        { name: 'bulk', desc: 'Push an array of jobs onto the queue', snippet: "bulk([new ${1:ProcessPodcast}($2)])" },
        { name: 'size', desc: 'Get the size of a given queue', snippet: "size('${1:default}')" }
      ];
      this.addMethods(completions, 'Queue', methods);
    } 
    else if (lineText.endsWith('Event.')) {
      const methods: MethodSuggestion[] = [
        { name: 'dispatch', desc: 'Dispatch an event to all registered listeners', snippet: "dispatch(new ${1:OrderPlaced}($2))" },
        { name: 'listen', desc: 'Register an event listener', snippet: "listen(${1:OrderPlaced}, async (event) => {\n\t$0\n})" }
      ];
      this.addMethods(completions, 'Event', methods);
    } 
    else if (lineText.endsWith('Schedule.')) {
      const methods: MethodSuggestion[] = [
        { name: 'command', desc: 'Add a console command to the schedule', snippet: "command('${1:command:name}').everyMinute()" },
        { name: 'job', desc: 'Add a queue job to the schedule', snippet: "job(new ${1:ProcessPodcast}()).daily()" },
        { name: 'call', desc: 'Add a callback closure to the schedule', snippet: "call(async () => {\n\t$1\n}).hourly()" }
      ];
      this.addMethods(completions, 'Schedule', methods);
    } 
    else if (lineText.endsWith('Validator.')) {
      const methods: MethodSuggestion[] = [
        { name: 'make', desc: 'Create a validator instance with rules and messages', snippet: "make(${1:data}, {\n\t${2:email}: 'required|email'\n})" },
        { name: 'validate', desc: 'Validate data and return verified inputs directly', snippet: "validate(${1:data}, {\n\t${2:email}: 'required|email'\n})" }
      ];
      this.addMethods(completions, 'Validator', methods);
    }
    // 8. Check for Table Builder schema definitions (e.g. table., builder.)
    else if (lineText.endsWith('table.') || lineText.endsWith('builder.')) {
      const varName = lineText.endsWith('table.') ? 'table' : 'builder';
      const methods: MethodSuggestion[] = [
        { name: 'increments', desc: 'Adds an auto-incrementing integer primary key column', snippet: "increments('${1:id}')" },
        { name: 'string', desc: 'Adds a string column', snippet: "string('${1:name}', ${2:255})" },
        { name: 'integer', desc: 'Adds an integer column', snippet: "integer('${1:age}')" },
        { name: 'bigInteger', desc: 'Adds a bigInteger column', snippet: "bigInteger('${1:user_id}')" },
        { name: 'text', desc: 'Adds a text column', snippet: "text('${1:description}')" },
        { name: 'float', desc: 'Adds a float column', snippet: "float('${1:price}')" },
        { name: 'decimal', desc: 'Adds a decimal column', snippet: "decimal('${1:price}', ${2:8}, ${3:2})" },
        { name: 'boolean', desc: 'Adds a boolean column', snippet: "boolean('${1:is_active}')" },
        { name: 'date', desc: 'Adds a date column', snippet: "date('${1:birthday}')" },
        { name: 'dateTime', desc: 'Adds a dateTime column', snippet: "dateTime('${1:published_at}')" },
        { name: 'timestamp', desc: 'Adds a timestamp column', snippet: "timestamp('${1:created_at}')" },
        { name: 'timestamps', desc: 'Adds created_at and updated_at columns', snippet: "timestamps(true, true)" },
        { name: 'json', desc: 'Adds a json column', snippet: "json('${1:meta}')" },
        { name: 'uuid', desc: 'Adds a uuid column', snippet: "uuid('${1:id}')" },
        { name: 'primary', desc: 'Marks column as primary key', snippet: "primary()" },
        { name: 'nullable', desc: 'Allows null values for column', snippet: "nullable()" },
        { name: 'notNullable', desc: 'Disallows null values for column', snippet: "notNullable()" },
        { name: 'unique', desc: 'Adds a unique index constraint', snippet: "unique()" },
        { name: 'defaultTo', desc: 'Sets a default value for column', snippet: "defaultTo(${1:defaultValue})" },
        { name: 'index', desc: 'Adds an index constraint', snippet: "index()" },
        { name: 'references', desc: 'Sets up a foreign key references', snippet: "references('${1:id}')" },
        { name: 'onTable', desc: 'Specifies target table for foreign key', snippet: "onTable('${1:users}')" },
        { name: 'onDelete', desc: 'Specifies onDelete behavior', snippet: "onDelete('${1:CASCADE}')" },
        { name: 'onUpdate', desc: 'Specifies onUpdate behavior', snippet: "onUpdate('${1:CASCADE}')" }
      ];
      this.addMethods(completions, varName, methods);
    }
    // 9. Fallback: Suggest Facade Classes when user starts typing them
    else {
      const wordRange = document.getWordRangeAtPosition(position);
      if (wordRange) {
        const word = document.getText(wordRange);
        const classes = [
          { name: 'Route', desc: 'Maxima Routing Facade' },
          { name: 'DB', desc: 'Maxima Database Facade' },
          { name: 'Schema', desc: 'Maxima Database Schema Builder' },
          { name: 'Cache', desc: 'Maxima Cache Facade' },
          { name: 'Storage', desc: 'Maxima File Storage Facade' },
          { name: 'Log', desc: 'Maxima Logger Facade' },
          { name: 'Auth', desc: 'Maxima Authentication Facade' },
          { name: 'Validator', desc: 'Maxima Validator Facade' },
          { name: 'Mail', desc: 'Maxima Mail Facade' },
          { name: 'Queue', desc: 'Maxima Queue Facade' },
          { name: 'Event', desc: 'Maxima Event Dispatcher' },
          { name: 'Schedule', desc: 'Maxima Scheduler Facade' },
          { name: 'Model', desc: 'Maxima Eloquent Model base class' }
        ];

        for (const c of classes) {
          if (c.name.toLowerCase().startsWith(word.toLowerCase())) {
            const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Class);
            item.detail = `Maxima Framework: ${c.name}`;
            item.documentation = new vscode.MarkdownString(c.desc);
            completions.push(item);
          }
        }
      }
    }

    return completions;
  }

  private addMethods(completions: vscode.CompletionItem[], parent: string, methods: MethodSuggestion[]) {
    for (const m of methods) {
      const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.Method);
      item.detail = `${parent}.${m.name}`;
      item.documentation = new vscode.MarkdownString(m.desc);
      item.insertText = new vscode.SnippetString(m.snippet);
      completions.push(item);
    }
  }

  // --- Helper methods to extract config, views, paths and routes keys statically ---

  private getDirFiles(dirPath: string, rootDir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dirPath)) {
      return results;
    }

    const traverse = (currentDir: string) => {
      const files = fs.readdirSync(currentDir);
      for (const file of files) {
        const fullPath = path.join(currentDir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          traverse(fullPath);
        } else {
          // Get relative path using forward slashes
          const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
          // Skip system files
          if (!file.startsWith('.')) {
            results.push(relPath);
          }
        }
      }
    };

    try {
      traverse(dirPath);
    } catch (e) {
      console.error('Error traversing files for autocomplete:', e);
    }
    return results;
  }

  private getConfigKeys(rootPath: string): string[] {
    const keys: string[] = [];
    const configDir = path.join(rootPath, 'src', 'config');
    if (!fs.existsSync(configDir)) {
      return keys;
    }

    try {
      const files = fs.readdirSync(configDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
      for (const file of files) {
        const prefix = path.basename(file, path.extname(file));
        const content = fs.readFileSync(path.join(configDir, file), 'utf-8');
        
        // Grab top-level property keys inside the config default object
        const keyRegex = /\b([a-zA-Z0-9_]+)\s*:/g;
        let match;
        while ((match = keyRegex.exec(content)) !== null) {
          const key = match[1];
          if (key !== 'default') {
            const fullKey = `${prefix}.${key}`;
            if (!keys.includes(fullKey)) {
              keys.push(fullKey);
            }
          }
        }
      }
    } catch (e) {
      console.error('Error parsing config keys:', e);
    }
    return keys;
  }

  private getViewKeys(rootPath: string): string[] {
    const keys: string[] = [];
    const viewsDir = path.join(rootPath, 'src', 'resources', 'views');
    if (!fs.existsSync(viewsDir)) {
      return keys;
    }

    const traverse = (dir: string, currentPrefix = '') => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          traverse(fullPath, currentPrefix ? `${currentPrefix}.${file}` : file);
        } else if (file.endsWith('.edge')) {
          const name = path.basename(file, '.edge');
          const viewKey = currentPrefix ? `${currentPrefix}.${name}` : name;
          keys.push(viewKey);
        }
      }
    };

    try {
      traverse(viewsDir);
    } catch (e) {
      console.error('Error parsing view files:', e);
    }
    return keys;
  }

  private getRouteNames(rootPath: string): string[] {
    const names: string[] = [];
    const routesDir = path.join(rootPath, 'src', 'routes');
    if (!fs.existsSync(routesDir)) {
      return names;
    }

    try {
      const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(routesDir, file), 'utf-8');
        const nameRegex = /\.name\(['"]([^'"]+)['"]\)/g;
        let match;
        while ((match = nameRegex.exec(content)) !== null) {
          const name = match[1];
          if (!names.includes(name)) {
            names.push(name);
          }
        }
      }
    } catch (e) {
      console.error('Error parsing route names:', e);
    }
    return names;
  }

  private getMiddlewareKeys(rootPath: string): string[] {
    const keys: string[] = [];
    const mConfig = path.join(rootPath, 'src', 'config', 'middleware.ts');
    if (!fs.existsSync(mConfig)) return keys;

    try {
      const content = fs.readFileSync(mConfig, 'utf-8');
      
      const aliasesMatch = /aliases\s*:\s*\{([^}]+)\}/.exec(content);
      if (aliasesMatch) {
        const keyRegex = /\b([a-zA-Z0-9_-]+)\s*:/g;
        let match;
        while ((match = keyRegex.exec(aliasesMatch[1])) !== null) {
          keys.push(match[1]);
        }
      }

      const groupsMatch = /groups\s*:\s*\{([^}]+)\}/.exec(content);
      if (groupsMatch) {
        const keyRegex = /\b([a-zA-Z0-9_-]+)\s*:/g;
        let match;
        while ((match = keyRegex.exec(groupsMatch[1])) !== null) {
          keys.push(match[1]);
        }
      }
    } catch {}
    return keys;
  }

  private getTranslationKeys(rootPath: string): string[] {
    const keys: string[] = [];
    const langDir = path.join(rootPath, 'src', 'resources', 'lang');
    if (!fs.existsSync(langDir)) return keys;

    try {
      const locales = fs.readdirSync(langDir);
      for (const locale of locales) {
        const localePath = path.join(langDir, locale);
        if (fs.statSync(localePath).isDirectory()) {
          const files = fs.readdirSync(localePath).filter(f => f.endsWith('.json'));
          for (const file of files) {
            const prefix = path.basename(file, '.json');
            const content = fs.readFileSync(path.join(localePath, file), 'utf-8');
            try {
              const data = JSON.parse(content);
              for (const key of Object.keys(data)) {
                const fullKey = `${prefix}.${key}`;
                if (!keys.includes(fullKey)) keys.push(fullKey);
              }
            } catch {}
          }
        }
      }
    } catch {}
    return keys;
  }

  private getTranslationPlaceholders(rootPath: string, transKey: string): string[] {
    const parts = transKey.split('.');
    if (parts.length < 2) return [];

    const file = parts[0];
    const target = parts[parts.length - 1];
    const langDir = path.join(rootPath, 'src', 'resources', 'lang');
    if (!fs.existsSync(langDir)) return [];

    try {
      const locales = fs.readdirSync(langDir);
      for (const locale of locales) {
        const jsonPath = path.join(langDir, locale, `${file}.json`);
        if (fs.existsSync(jsonPath)) {
          const content = fs.readFileSync(jsonPath, 'utf-8');
          const data = JSON.parse(content);
          const val = data[target];
          if (typeof val === 'string') {
            const placeholders: string[] = [];
            const regex = /:([a-zA-Z0-9_]+)/g;
            let m;
            while ((m = regex.exec(val)) !== null) {
              placeholders.push(m[1]);
            }
            return placeholders;
          }
        }
      }
    } catch {}
    return [];
  }

  private getAppBindings(rootPath: string): string[] {
    const keys: string[] = [
      'auth', 'cache', 'queue', 'session', 'events', 'broadcast', 'filesystem', 'mail', 'notifications', 'router', 'validator', 'logger'
    ];
    
    const providers = [
      path.join(rootPath, 'lib', 'providers', 'FrameworkServiceProvider.ts'),
      path.join(rootPath, 'src', 'app', 'Providers', 'AppServiceProvider.ts')
    ];

    for (const provider of providers) {
      if (fs.existsSync(provider)) {
        try {
          const content = fs.readFileSync(provider, 'utf-8');
          const bindingRegex = /(?:\.singleton|\.instance|\.bind)\(['"]([^'"]+)['"]/g;
          let match;
          while ((match = bindingRegex.exec(content)) !== null) {
            if (!keys.includes(match[1])) keys.push(match[1]);
          }
        } catch {}
      }
    }
    return keys;
  }

  private getAssetsList(rootPath: string): string[] {
    const assets: string[] = [];
    const publicDir = path.join(rootPath, 'public');
    const storagePublicDir = path.join(rootPath, 'storage', 'app', 'public');

    const traverse = (dir: string, baseDir: string) => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          traverse(fullPath, baseDir);
        } else {
          const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          if (!file.startsWith('.')) assets.push(rel);
        }
      }
    };

    traverse(publicDir, publicDir);
    traverse(storagePublicDir, storagePublicDir);
    return assets;
  }

  private getModels(rootPath: string): ModelMeta[] {
    const models: ModelMeta[] = [];
    const dirs = [
      path.join(rootPath, 'src', 'app', 'Models'),
      path.join(rootPath, 'src', 'Models')
    ];

    for (const dir of dirs) {
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
          for (const file of files) {
            const content = fs.readFileSync(path.join(dir, file), 'utf-8');
            const classMatch = /export\s+class\s+([A-Za-z0-9_]+)\s+extends\s+Model/.exec(content);
            if (!classMatch) continue;
            const className = classMatch[1];

            const fields: string[] = ['id', 'created_at', 'updated_at'];
            const fillableMatch = /fillable\s*=\s*\[([^\]]+)\]/.exec(content);
            if (fillableMatch) {
              const fieldRegex = /['"]([^'"]+)['"]/g;
              let m;
              while ((m = fieldRegex.exec(fillableMatch[1])) !== null) {
                if (!fields.includes(m[1])) fields.push(m[1]);
              }
            }

            const relations: string[] = [];
            const relRegex = /([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{[^}]*this\.(?:hasMany|belongsTo|hasOne|belongsToMany|morphMany|morphTo|morphOne)\(/g;
            let m;
            while ((m = relRegex.exec(content)) !== null) {
              if (!relations.includes(m[1])) relations.push(m[1]);
            }

            models.push({ className, fields, relations });
          }
        } catch (e) {
          console.error('Error parsing models:', e);
        }
      }
    }
    return models;
  }
}

