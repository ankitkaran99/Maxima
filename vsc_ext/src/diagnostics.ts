import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getMaximaRootPath } from './commands';

// Standard diagnostic codes
export const DIAGNOSTIC_CODE_MISSING_ENV = 'maxima_missing_env';
export const DIAGNOSTIC_CODE_MISSING_VIEW = 'maxima_missing_view';
export const DIAGNOSTIC_CODE_MISSING_CONFIG = 'maxima_missing_config';
export const DIAGNOSTIC_CODE_MISSING_ROUTE = 'maxima_missing_route';
export const DIAGNOSTIC_CODE_MISSING_MIDDLEWARE = 'maxima_missing_middleware';
export const DIAGNOSTIC_CODE_MISSING_TRANSLATION = 'maxima_missing_translation';
export const DIAGNOSTIC_CODE_MISSING_BINDING = 'maxima_missing_binding';
export const DIAGNOSTIC_CODE_MISSING_ASSET = 'maxima_missing_asset';

export function registerDiagnostics(context: vscode.ExtensionContext) {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('maxima');
  context.subscriptions.push(diagnosticCollection);

  // Run diagnostics when a text document is opened or saved, or on change
  if (vscode.window.activeTextEditor) {
    runDiagnostics(vscode.window.activeTextEditor.document, diagnosticCollection);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => runDiagnostics(doc, diagnosticCollection)),
    vscode.workspace.onDidSaveTextDocument(doc => runDiagnostics(doc, diagnosticCollection)),
    vscode.workspace.onDidChangeTextDocument(event => runDiagnostics(event.document, diagnosticCollection))
  );
}

function runDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
  const rootPath = getMaximaRootPath();
  // Only check typescript or javascript files in the workspace
  if (!rootPath || (document.languageId !== 'typescript' && document.languageId !== 'javascript' && document.languageId !== 'typescriptreact' && document.languageId !== 'javascriptreact')) {
    return;
  }

  const text = document.getText();
  const diagnostics: vscode.Diagnostic[] = [];

  // Index project metadata (doing it statically is extremely fast)
  const envKeys = getEnvKeys(rootPath);
  const configKeys = getConfigKeys(rootPath);
  const viewKeys = getViewKeys(rootPath);
  const routeNames = getRouteNames(rootPath);
  const middlewareKeys = getMiddlewareKeys(rootPath);
  const translationKeys = getTranslationKeys(rootPath);
  const appBindings = getAppBindings(rootPath);
  const assets = getAssets(rootPath);

  const lines = text.split('\n');

  // Check lines one by one
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1. Env check: env('KEY')
    checkRegex(line, i, /(?:env|Env\.get)\(['"]([^'"]+)['"]/g, (key, range) => {
      if (!envKeys.includes(key)) {
        const diag = new vscode.Diagnostic(
          range,
          `Env key '${key}' is not defined in .env.`,
          vscode.DiagnosticSeverity.Warning
        );
        diag.code = DIAGNOSTIC_CODE_MISSING_ENV;
        diagnostics.push(diag);
      }
    });

    // 2. Config check: config('key') or fluid config().string('key')
    checkRegex(line, i, /(?:config|Config\.get|config\(\)(?:\.[a-zA-Z0-9_]+)*)\(['"]([^'"]+)['"]/g, (key, range) => {
      const parts = key.split('.');
      const file = parts[0];
      const hasKey = configKeys.includes(key) || configKeys.some(k => k.startsWith(`${file}.`));
      if (!hasKey) {
        const diag = new vscode.Diagnostic(
          range,
          `Configuration key '${key}' is not defined in src/config/.`,
          vscode.DiagnosticSeverity.Warning
        );
        diag.code = DIAGNOSTIC_CODE_MISSING_CONFIG;
        diagnostics.push(diag);
      }
    });

    // Config.getMany array check
    const getManyCallRegex = /Config\.getMany\(\s*\[([^\]]*)\]\s*\)/g;
    let getManyMatch;
    getManyCallRegex.lastIndex = 0;
    while ((getManyMatch = getManyCallRegex.exec(line)) !== null) {
      const arraySegment = getManyMatch[1];
      const segmentStart = getManyMatch.index + getManyMatch[0].indexOf(arraySegment);
      const stringRegex = /['"]([^'"]+)['"]/g;
      let strMatch;
      while ((strMatch = stringRegex.exec(arraySegment)) !== null) {
        const key = strMatch[1];
        const parts = key.split('.');
        const file = parts[0];
        const hasKey = configKeys.includes(key) || configKeys.some(k => k.startsWith(`${file}.`));
        if (!hasKey) {
          const charStart = segmentStart + strMatch.index + 1;
          const range = new vscode.Range(new vscode.Position(i, charStart), new vscode.Position(i, charStart + key.length));
          const diag = new vscode.Diagnostic(
            range,
            `Configuration key '${key}' is not defined in src/config/.`,
            vscode.DiagnosticSeverity.Warning
          );
          diag.code = DIAGNOSTIC_CODE_MISSING_CONFIG;
          diagnostics.push(diag);
        }
      }
    }

    // 3. View check: view('welcome')
    checkRegex(line, i, /(?:view|viewExists|renderEmail)\(['"]([^'"]+)['"]/g, (key, range) => {
      if (!viewKeys.includes(key)) {
        const diag = new vscode.Diagnostic(
          range,
          `View or email template '${key}' does not exist under src/resources/views/ or src/resources/emails/.`,
          vscode.DiagnosticSeverity.Warning
        );
        diag.code = DIAGNOSTIC_CODE_MISSING_VIEW;
        diagnostics.push(diag);
      }
    });

    // Route.view check
    checkRegex(line, i, /Route\.view\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/g, (key, range) => {
      if (!viewKeys.includes(key)) {
        const diag = new vscode.Diagnostic(
          range,
          `View or email template '${key}' does not exist under src/resources/views/ or src/resources/emails/.`,
          vscode.DiagnosticSeverity.Warning
        );
        diag.code = DIAGNOSTIC_CODE_MISSING_VIEW;
        diagnostics.push(diag);
      }
    });


    // 4. Route check: route('dashboard')
    checkRegex(line, i, /(?:route|signedRoute|Redirect\.route|Redirect\.signedRoute|URL\.route|URL\.signedRoute|redirect\(\)\.route)\(['"]([^'"]+)['"]/g, (key, range) => {
      if (!routeNames.includes(key)) {
        const diag = new vscode.Diagnostic(
          range,
          `Route name '${key}' is not registered.`,
          vscode.DiagnosticSeverity.Warning
        );
        diag.code = DIAGNOSTIC_CODE_MISSING_ROUTE;
        diagnostics.push(diag);
      }
    });

    // 5. Middleware check: single or array elements inside middleware call
    const midCallRegex = /(?:middleware|withoutMiddleware)\(\s*(\[[^\]]*\]|['"][^'"]+['"])\s*\)/g;
    let midMatch;
    midCallRegex.lastIndex = 0;
    while ((midMatch = midCallRegex.exec(line)) !== null) {
      const argumentSegment = midMatch[1];
      const segmentStart = midMatch.index + midMatch[0].indexOf(argumentSegment);
      const stringRegex = /['"]([^'"]+)['"]/g;
      let strMatch;
      while ((strMatch = stringRegex.exec(argumentSegment)) !== null) {
        const key = strMatch[1];
        if (!middlewareKeys.includes(key)) {
          const charStart = segmentStart + strMatch.index + 1;
          const range = new vscode.Range(new vscode.Position(i, charStart), new vscode.Position(i, charStart + key.length));
          const diag = new vscode.Diagnostic(
            range,
            `Middleware alias/group '${key}' is not registered in src/config/middleware.ts.`,
            vscode.DiagnosticSeverity.Warning
          );
          diag.code = DIAGNOSTIC_CODE_MISSING_MIDDLEWARE;
          diagnostics.push(diag);
        }
      }
    }

    // 6. Translation check: trans('auth.failed') or __('auth.failed')
    checkRegex(line, i, /(?:trans|__|Lang\.get|Lang\.has)\(['"]([^'"]+)['"]/g, (key, range) => {
      if (!translationKeys.includes(key) && key.includes('.')) {
        const diag = new vscode.Diagnostic(
          range,
          `Translation key '${key}' does not exist in any JSON language files.`,
          vscode.DiagnosticSeverity.Information
        );
        diag.code = DIAGNOSTIC_CODE_MISSING_TRANSLATION;
        diagnostics.push(diag);
      }
    });

    // 7. App Binding check: app('auth') or App.make('auth')
    checkRegex(line, i, /(?:app|App\.make|App\.bound|App\.isShared|app\(\)\.make)\(['"]([^'"]+)['"]/g, (key, range) => {
      // Ignore Class constructors (they start with Capital letters and contain Controller, Provider, etc.)
      const isClass = /^[A-Z]/.test(key);
      if (!isClass && !appBindings.includes(key)) {
        const diag = new vscode.Diagnostic(
          range,
          `Container binding '${key}' is not registered.`,
          vscode.DiagnosticSeverity.Warning
        );
        diag.code = DIAGNOSTIC_CODE_MISSING_BINDING;
        diagnostics.push(diag);
      }
    });

    // 8. Asset check: asset('img.png')
    checkRegex(line, i, /asset\(['"]([^'"]+)['"]/g, (key, range) => {
      if (!assets.includes(key)) {
        const diag = new vscode.Diagnostic(
          range,
          `Asset file '${key}' does not exist under public/ or storage/app/public/.`,
          vscode.DiagnosticSeverity.Warning
        );
        diag.code = DIAGNOSTIC_CODE_MISSING_ASSET;
        diagnostics.push(diag);
      }
    });
  }

  collection.set(document.uri, diagnostics);
}

function checkRegex(line: string, lineIndex: number, regex: RegExp, callback: (matchText: string, range: vscode.Range) => void) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(line)) !== null) {
    const key = match[1];
    const keyIndex = line.indexOf(key, match.index);
    const range = new vscode.Range(
      new vscode.Position(lineIndex, keyIndex),
      new vscode.Position(lineIndex, keyIndex + key.length)
    );
    callback(key, range);
  }
}

// --- Metadata Indexing Helpers (Sync & Fast) ---

function getEnvKeys(rootPath: string): string[] {
  const keys: string[] = [];
  const envPath = path.join(rootPath, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const match = /^([A-Z0-9_]+)=/.exec(line.trim());
        if (match) keys.push(match[1]);
      }
    } catch {}
  }
  return keys;
}

function getConfigKeys(rootPath: string): string[] {
  const keys: string[] = [];
  const configDir = path.join(rootPath, 'src', 'config');
  if (!fs.existsSync(configDir)) return keys;

  try {
    const files = fs.readdirSync(configDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
    for (const file of files) {
      const prefix = path.basename(file, path.extname(file));
      const content = fs.readFileSync(path.join(configDir, file), 'utf-8');
      const keyRegex = /\b([a-zA-Z0-9_]+)\s*:/g;
      let match;
      while ((match = keyRegex.exec(content)) !== null) {
        const key = match[1];
        if (key !== 'default') {
          keys.push(`${prefix}.${key}`);
        }
      }
    }
  } catch {}
  return keys;
}

function getViewKeys(rootPath: string): string[] {
  const keys: string[] = [];
  const viewsDir = path.join(rootPath, 'src', 'resources', 'views');
  const emailsDir = path.join(rootPath, 'src', 'resources', 'emails');

  const traverse = (dir: string, currentPrefix = '', allowedExtensions = ['.edge']) => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        traverse(fullPath, currentPrefix ? `${currentPrefix}.${file}` : file, allowedExtensions);
      } else {
        const ext = allowedExtensions.find(e => file.endsWith(e));
        if (ext) {
          const name = path.basename(file, ext);
          keys.push(currentPrefix ? `${currentPrefix}.${name}` : name);
        }
      }
    }
  };

  try {
    traverse(viewsDir, '', ['.edge']);
    traverse(emailsDir, '', ['.mjml']);
  } catch {}
  return keys;
}

function getRouteNames(rootPath: string): string[] {
  const names: string[] = [];
  const routesDir = path.join(rootPath, 'src', 'routes');
  if (!fs.existsSync(routesDir)) return names;

  try {
    const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(routesDir, file), 'utf-8');
      const nameRegex = /\.name\(['"]([^'"]+)['"]\)/g;
      let match;
      while ((match = nameRegex.exec(content)) !== null) {
        if (!names.includes(match[1])) names.push(match[1]);
      }
    }
  } catch {}
  return names;
}

function getMiddlewareKeys(rootPath: string): string[] {
  const keys: string[] = [];
  const mConfig = path.join(rootPath, 'src', 'config', 'middleware.ts');
  if (!fs.existsSync(mConfig)) return keys;

  try {
    const content = fs.readFileSync(mConfig, 'utf-8');
    
    // Parse aliases
    const aliasesMatch = /aliases\s*:\s*\{([^}]+)\}/.exec(content);
    if (aliasesMatch) {
      const keyRegex = /\b([a-zA-Z0-9_-]+)\s*:/g;
      let match;
      while ((match = keyRegex.exec(aliasesMatch[1])) !== null) {
        keys.push(match[1]);
      }
    }

    // Parse groups
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

function getTranslationKeys(rootPath: string): string[] {
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
              keys.push(`${prefix}.${key}`);
            }
          } catch {}
        }
      }
    }
  } catch {}
  return keys;
}

function getAppBindings(rootPath: string): string[] {
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

function getAssets(rootPath: string): string[] {
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

// --- Code Actions (Quick Fixes) Provider ---

export class MaximaCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      const lineText = document.lineAt(diagnostic.range.start.line).text;
      
      if (diagnostic.code === DIAGNOSTIC_CODE_MISSING_ENV) {
        const match = /(?:env|Env\.get)\(['"]([^'"]+)['"]/g.exec(lineText);
        if (match) {
          const envKey = match[1];
          // 1. Add to .env action
          const addToEnvAction = new vscode.CodeAction(`Add ${envKey} to .env`, vscode.CodeActionKind.QuickFix);
          addToEnvAction.command = {
            title: 'Add to .env',
            command: 'maxima.addEnvKey',
            arguments: [envKey]
          };
          addToEnvAction.diagnostics = [diagnostic];
          addToEnvAction.isPreferred = true;
          actions.push(addToEnvAction);

          // 2. Copy from .env.example
          const copyFromExample = new vscode.CodeAction(`Copy ${envKey} from .env.example`, vscode.CodeActionKind.QuickFix);
          copyFromExample.command = {
            title: 'Copy from .env.example',
            command: 'maxima.copyEnvKeyFromExample',
            arguments: [envKey]
          };
          copyFromExample.diagnostics = [diagnostic];
          actions.push(copyFromExample);
        }
      }

      if (diagnostic.code === DIAGNOSTIC_CODE_MISSING_VIEW) {
        const match = /(?:view|viewExists|renderEmail)\(['"]([^'"]+)['"]/g.exec(lineText) || /Route\.view\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/g.exec(lineText);
        if (match) {
          const viewKey = match[1];
          const createViewAction = new vscode.CodeAction(`Create view '${viewKey}'`, vscode.CodeActionKind.QuickFix);
          createViewAction.command = {
            title: 'Create view template',
            command: 'maxima.createViewTemplate',
            arguments: [viewKey]
          };
          createViewAction.diagnostics = [diagnostic];
          createViewAction.isPreferred = true;
          actions.push(createViewAction);
        }
      }
    }

    return actions;
  }
}


