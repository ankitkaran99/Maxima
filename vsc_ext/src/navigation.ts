import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getMaximaRootPath } from './commands';

export class MaximaDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
    const rootPath = getMaximaRootPath();
    if (!rootPath) {
      return null;
    }

    const lineText = document.lineAt(position.line).text;
    const char = position.character;

    // Define regex patterns and their resolution functions
    const matchers = [
      {
        // 1. Controller Action: [PostController, 'show']
        regex: /\[\s*([A-Za-z0-9_]+)\s*,\s*['"]([A-Za-z0-9_]+)['"]\s*\]/g,
        resolve: (match: RegExpExecArray) => this.resolveController(document, rootPath, match[1], match[2])
      },
      {
        // 2. Config: config('app.name') or Config.get('app.name') or config()->string('app.name')
        regex: /(?:config|Config\.get|Config\.getMany|config\(\)(?:\.[a-zA-Z0-9_]+)*)\(['"]([^'"]+)['"]/g,
        resolve: (match: RegExpExecArray) => this.resolveConfig(rootPath, match[1])
      },
      {
        // 3. Env: env('APP_ENV') or Env.get('APP_ENV')
        regex: /(?:env|Env\.get)\(['"]([^'"]+)['"]/g,
        resolve: (match: RegExpExecArray) => this.resolveEnv(rootPath, match[1])
      },
      {
        // 4. Route: route('dashboard')
        regex: /(?:route|signedRoute|Redirect\.route|Redirect\.signedRoute|URL\.route|URL\.signedRoute|redirect\(\)\.route)\(['"]([^'"]+)['"]/g,
        resolve: (match: RegExpExecArray) => this.resolveRoute(rootPath, match[1])
      },
      {
        // 5. View: view('home') or Route.view('/', 'home')
        regex: /(?:view|viewExists|renderEmail|viewFirst|Route\.view)\(['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]\)/g,
        resolve: (match: RegExpExecArray) => this.resolveView(rootPath, match[1])
      },
      {
        // 5b. View (Single parameter): view('home')
        regex: /(?:view|viewExists|renderEmail)\(['"]([^'"]+)['"]/g,
        resolve: (match: RegExpExecArray) => this.resolveView(rootPath, match[1])
      },
      {
        // 6. Middleware: Route.middleware('auth') or Route.middleware(['auth'])
        regex: /(?:middleware|withoutMiddleware)\(['"]([^'"]+)['"]/g,
        resolve: (match: RegExpExecArray) => this.resolveMiddleware(rootPath, match[1])
      },
      {
        // 6b. Middleware array elements: 'auth' inside Route.middleware(['auth', 'web'])
        regex: /['"]([A-Za-z0-9_-]+)['"]/g,
        resolve: (match: RegExpExecArray) => {
          // Verify we are inside middleware list
          if (lineText.includes('middleware') || lineText.includes('withoutMiddleware')) {
            return this.resolveMiddleware(rootPath, match[1]);
          }
          return null;
        }
      },
      {
        // 7. Translation: trans('auth.failed') or __('auth.failed')
        regex: /(?:trans|__|Lang\.get|Lang\.has)\(['"]([^'"]+)['"]/g,
        resolve: (match: RegExpExecArray) => this.resolveTranslation(rootPath, match[1])
      },
      {
        // 8. App Bindings: app('auth') or App.make('auth')
        regex: /(?:app|App\.make|App\.bound|App\.isShared|app\(\)\.make)\(['"]([^'"]+)['"]/g,
        resolve: (match: RegExpExecArray) => this.resolveAppBinding(rootPath, match[1])
      },
      {
        // 9. Asset: asset('img.png')
        regex: /asset\(['"]([^'"]+)['"]/g,
        resolve: (match: RegExpExecArray) => this.resolveAsset(rootPath, match[1])
      }
    ];

    for (const matcher of matchers) {
      matcher.regex.lastIndex = 0;
      let match;
      while ((match = matcher.regex.exec(lineText)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (char >= start && char <= end) {
          const loc = matcher.resolve(match);
          if (loc) {
            return loc;
          }
        }
      }
    }

    return null;
  }

  // --- Resolution Helpers ---

  private resolveController(
    document: vscode.TextDocument,
    rootPath: string,
    controllerName: string,
    methodName: string
  ): vscode.Location | null {
    const fileText = document.getText();
    const importRegex = new RegExp(`import\\s+\\{[^}]*?\\b${controllerName}\\b[^}]*?\\}\\s+from\\s+['"]([^'"]+)['"]`);
    const importMatch = importRegex.exec(fileText);
    if (!importMatch) {
      return null;
    }

    let importPath = importMatch[1];
    let targetRelativePath = importPath;
    if (targetRelativePath.startsWith('@app/')) {
      targetRelativePath = targetRelativePath.replace('@app/', 'src/app/');
    } else if (targetRelativePath.startsWith('@src/')) {
      targetRelativePath = targetRelativePath.replace('@src/', 'src/');
    } else if (targetRelativePath.startsWith('@lib/')) {
      targetRelativePath = targetRelativePath.replace('@lib/', 'lib/');
    }

    let resolvedPath = importPath.startsWith('.') 
      ? path.resolve(path.dirname(document.uri.fsPath), targetRelativePath)
      : path.join(rootPath, targetRelativePath);

    if (resolvedPath.endsWith('.js')) {
      const tsPath = resolvedPath.substring(0, resolvedPath.length - 3) + '.ts';
      if (fs.existsSync(tsPath)) resolvedPath = tsPath;
    }

    if (!fs.existsSync(resolvedPath)) {
      return null;
    }

    try {
      const controllerContent = fs.readFileSync(resolvedPath, 'utf-8');
      const lines = controllerContent.split('\n');
      const methodPatterns = [
        new RegExp(`\\basync\\s+${methodName}\\b\\s*\\(`),
        new RegExp(`\\b${methodName}\\b\\s*\\(`),
        new RegExp(`\\b${methodName}\\b\\s*=\\s*\\(`),
        new RegExp(`\\b${methodName}\\b\\s*=\\s*async\\s*\\(`)
      ];

      for (let i = 0; i < lines.length; i++) {
        for (const pattern of methodPatterns) {
          const match = pattern.exec(lines[i]);
          if (match) {
            return new vscode.Location(vscode.Uri.file(resolvedPath), new vscode.Position(i, match.index));
          }
        }
      }
      return new vscode.Location(vscode.Uri.file(resolvedPath), new vscode.Position(0, 0));
    } catch {
      return null;
    }
  }

  private resolveConfig(rootPath: string, configKey: string): vscode.Location | null {
    const parts = configKey.split('.');
    const file = parts[0];
    const targetPath = path.join(rootPath, 'src', 'config', `${file}.ts`);
    const jsPath = path.join(rootPath, 'src', 'config', `${file}.js`);
    const finalPath = fs.existsSync(targetPath) ? targetPath : (fs.existsSync(jsPath) ? jsPath : null);

    if (!finalPath) return null;

    if (parts.length === 1) {
      return new vscode.Location(vscode.Uri.file(finalPath), new vscode.Position(0, 0));
    }

    try {
      const content = fs.readFileSync(finalPath, 'utf-8');
      const lines = content.split('\n');
      const target = parts[parts.length - 1];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`${target}:`) || lines[i].includes(`'${target}':`) || lines[i].includes(`"${target}":`)) {
          return new vscode.Location(vscode.Uri.file(finalPath), new vscode.Position(i, lines[i].indexOf(target)));
        }
      }
      return new vscode.Location(vscode.Uri.file(finalPath), new vscode.Position(0, 0));
    } catch {
      return null;
    }
  }

  private resolveEnv(rootPath: string, envKey: string): vscode.Location | null {
    const envPath = path.join(rootPath, '.env');
    const envExamplePath = path.join(rootPath, '.env.example');
    const finalPath = fs.existsSync(envPath) ? envPath : (fs.existsSync(envExamplePath) ? envExamplePath : null);

    if (!finalPath) return null;

    try {
      const content = fs.readFileSync(finalPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(`${envKey}=`)) {
          return new vscode.Location(vscode.Uri.file(finalPath), new vscode.Position(i, 0));
        }
      }
      return new vscode.Location(vscode.Uri.file(finalPath), new vscode.Position(0, 0));
    } catch {
      return null;
    }
  }

  private resolveRoute(rootPath: string, routeName: string): vscode.Location | null {
    const routesDir = path.join(rootPath, 'src', 'routes');
    if (!fs.existsSync(routesDir)) return null;

    try {
      const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
      for (const file of files) {
        const filePath = path.join(routesDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(`.name('${routeName}')`) || lines[i].includes(`.name("${routeName}")`)) {
            return new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(i, lines[i].indexOf(routeName)));
          }
        }
      }
    } catch {}
    return null;
  }

  private resolveView(rootPath: string, viewKey: string): vscode.Location | null {
    const relativePath = viewKey.replace(/\./g, '/') + '.edge';
    const fullPath = path.join(rootPath, 'src', 'resources', 'views', relativePath);
    if (fs.existsSync(fullPath)) {
      return new vscode.Location(vscode.Uri.file(fullPath), new vscode.Position(0, 0));
    }
    return null;
  }

  private resolveMiddleware(rootPath: string, middlewareKey: string): vscode.Location | null {
    const middlewareConfig = path.join(rootPath, 'src', 'config', 'middleware.ts');
    if (!fs.existsSync(middlewareConfig)) return null;

    try {
      const content = fs.readFileSync(middlewareConfig, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`${middlewareKey}:`) || lines[i].includes(`'${middlewareKey}':`) || lines[i].includes(`"${middlewareKey}":`)) {
          return new vscode.Location(vscode.Uri.file(middlewareConfig), new vscode.Position(i, lines[i].indexOf(middlewareKey)));
        }
      }
    } catch {}
    return null;
  }

  private resolveTranslation(rootPath: string, transKey: string): vscode.Location | null {
    const parts = transKey.split('.');
    if (parts.length < 2) return null;

    const file = parts[0];
    const target = parts[parts.length - 1];

    const langDir = path.join(rootPath, 'src', 'resources', 'lang');
    if (!fs.existsSync(langDir)) return null;

    try {
      const locales = fs.readdirSync(langDir);
      for (const locale of locales) {
        const jsonPath = path.join(langDir, locale, `${file}.json`);
        if (fs.existsSync(jsonPath)) {
          const content = fs.readFileSync(jsonPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`"${target}":`) || lines[i].includes(`'${target}':`)) {
              return new vscode.Location(vscode.Uri.file(jsonPath), new vscode.Position(i, lines[i].indexOf(target)));
            }
          }
          return new vscode.Location(vscode.Uri.file(jsonPath), new vscode.Position(0, 0));
        }
      }
    } catch {}
    return null;
  }

  private resolveAppBinding(rootPath: string, bindingKey: string): vscode.Location | null {
    const providers = [
      path.join(rootPath, 'lib', 'providers', 'FrameworkServiceProvider.ts'),
      path.join(rootPath, 'src', 'app', 'Providers', 'AppServiceProvider.ts')
    ];

    for (const provider of providers) {
      if (fs.existsSync(provider)) {
        try {
          const content = fs.readFileSync(provider, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`'${bindingKey}'`) || lines[i].includes(`"${bindingKey}"`)) {
              return new vscode.Location(vscode.Uri.file(provider), new vscode.Position(i, lines[i].indexOf(bindingKey)));
            }
          }
        } catch {}
      }
    }
    return null;
  }

  private resolveAsset(rootPath: string, assetPath: string): vscode.Location | null {
    const publicAsset = path.join(rootPath, 'public', assetPath);
    if (fs.existsSync(publicAsset)) {
      return new vscode.Location(vscode.Uri.file(publicAsset), new vscode.Position(0, 0));
    }
    const storageAsset = path.join(rootPath, 'storage', 'app', 'public', assetPath);
    if (fs.existsSync(storageAsset)) {
      return new vscode.Location(vscode.Uri.file(storageAsset), new vscode.Position(0, 0));
    }
    return null;
  }
}
