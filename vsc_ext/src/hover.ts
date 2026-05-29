import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getMaximaRootPath } from './commands';

export class MaximaHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    const rootPath = getMaximaRootPath();
    if (!rootPath) return null;

    const lineText = document.lineAt(position.line).text;
    const char = position.character;

    // Define regexes and their hover resolution functions
    const hoverMatchers = [
      {
        regex: /(?:config|Config\.get|Config\.getMany|config\(\)(?:\.[a-zA-Z0-9_]+)*)\(['"]([^'"]+)['"]/g,
        resolve: (key: string) => this.hoverConfig(rootPath, key)
      },
      {
        regex: /(?:env|Env\.get)\(['"]([^'"]+)['"]/g,
        resolve: (key: string) => this.hoverEnv(rootPath, key)
      },
      {
        regex: /(?:route|signedRoute|Redirect\.route|Redirect\.signedRoute|URL\.route|URL\.signedRoute|redirect\(\)\.route)\(['"]([^'"]+)['"]/g,
        resolve: (key: string) => this.hoverRoute(rootPath, key)
      },
      {
        regex: /(?:trans|__|Lang\.get|Lang\.has)\(['"]([^'"]+)['"]/g,
        resolve: (key: string) => this.hoverTranslation(rootPath, key)
      },
      {
        regex: /(?:middleware|withoutMiddleware)\(['"]([^'"]+)['"]/g,
        resolve: (key: string) => this.hoverMiddleware(rootPath, key)
      },
      {
        regex: /['"]([A-Za-z0-9_-]+)['"]/g,
        resolve: (key: string) => {
          if (lineText.includes('middleware') || lineText.includes('withoutMiddleware')) {
            return this.hoverMiddleware(rootPath, key);
          }
          return null;
        }
      },
      {
        regex: /(?:app|App\.make|App\.bound|App\.isShared|app\(\)\.make)\(['"]([^'"]+)['"]/g,
        resolve: (key: string) => this.hoverAppBinding(rootPath, key)
      },
    ];

    for (const matcher of hoverMatchers) {
      matcher.regex.lastIndex = 0;
      let match;
      while ((match = matcher.regex.exec(lineText)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (char >= start && char <= end) {
          const hoverText = matcher.resolve(match[1]);
          if (hoverText) {
            return new vscode.Hover(hoverText);
          }
        }
      }
    }

    return null;
  }

  private hoverConfig(rootPath: string, key: string): vscode.MarkdownString | null {
    const parts = key.split('.');
    const file = parts[0];
    const target = parts[parts.length - 1];

    const configPath = path.join(rootPath, 'src', 'config', `${file}.ts`);
    const jsPath = path.join(rootPath, 'src', 'config', `${file}.js`);
    const finalPath = fs.existsSync(configPath) ? configPath : (fs.existsSync(jsPath) ? jsPath : null);

    if (!finalPath) return null;

    try {
      const content = fs.readFileSync(finalPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`${target}:`) || lines[i].includes(`'${target}':`) || lines[i].includes(`"${target}":`)) {
          const valueStr = lines[i].substring(lines[i].indexOf(':') + 1).trim().replace(/,$/, '');
          const md = new vscode.MarkdownString();
          md.appendMarkdown(`### Maxima Config: \`${key}\`\n`);
          md.appendCodeblock(valueStr, 'typescript');
          return md;
        }
      }
    } catch {}
    return null;
  }

  private hoverEnv(rootPath: string, key: string): vscode.MarkdownString | null {
    const envPath = path.join(rootPath, '.env');
    const envExamplePath = path.join(rootPath, '.env.example');

    let value: string | null = null;
    let fileSource = '.env';

    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf-8');
        const match = new RegExp(`^${key}=(.*)$`, 'm').exec(content);
        if (match) {
          value = match[1].trim();
        }
      } catch {}
    }

    if (value === null && fs.existsSync(envExamplePath)) {
      try {
        const content = fs.readFileSync(envExamplePath, 'utf-8');
        const match = new RegExp(`^${key}=(.*)$`, 'm').exec(content);
        if (match) {
          value = match[1].trim();
          fileSource = '.env.example';
        }
      } catch {}
    }

    if (value !== null) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`### Environment Variable (from \`${fileSource}\`)\n`);
      md.appendMarkdown(`**${key}** = \`${value || '(empty)'}\``);
      return md;
    }
    return null;
  }

  private hoverRoute(rootPath: string, routeName: string): vscode.MarkdownString | null {
    const routesDir = path.join(rootPath, 'src', 'routes');
    if (!fs.existsSync(routesDir)) return null;

    try {
      const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
      for (const file of files) {
        const filePath = path.join(routesDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.includes(`.name('${routeName}')`) || line.includes(`.name("${routeName}")`)) {
            // Find Route method and path from current or preceding lines
            // Example: Route.get('/posts', [PostController, 'index']).name('posts.index')
            const routeMatch = /(?:Route\.)?(get|post|put|delete|patch|any|match)\(['"]([^'"]+)['"]/i.exec(line);
            const method = routeMatch ? routeMatch[1].toUpperCase() : 'ANY';
            const pathUrl = routeMatch ? routeMatch[2] : 'Unknown';

            const md = new vscode.MarkdownString();
            md.appendMarkdown(`### Maxima Route: \`${routeName}\`\n`);
            md.appendMarkdown(`* **Method**: \`${method}\`\n`);
            md.appendMarkdown(`* **Path**: \`${pathUrl}\`\n`);
            md.appendMarkdown(`* **Defined in**: \`src/routes/${file}\`\n`);
            return md;
          }
        }
      }
    } catch {}
    return null;
  }

  private hoverTranslation(rootPath: string, key: string): vscode.MarkdownString | null {
    const parts = key.split('.');
    if (parts.length < 2) return null;

    const file = parts[0];
    const target = parts[parts.length - 1];

    const langDir = path.join(rootPath, 'src', 'resources', 'lang');
    if (!fs.existsSync(langDir)) return null;

    try {
      const locales = fs.readdirSync(langDir);
      const values: { locale: string; text: string }[] = [];

      for (const locale of locales) {
        const jsonPath = path.join(langDir, locale, `${file}.json`);
        if (fs.existsSync(jsonPath)) {
          const content = fs.readFileSync(jsonPath, 'utf-8');
          try {
            const data = JSON.parse(content);
            if (data[target]) {
              values.push({ locale, text: data[target] });
            }
          } catch {}
        }
      }

      if (values.length > 0) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`### Maxima Translation: \`${key}\`\n`);
        for (const item of values) {
          md.appendMarkdown(`* **${item.locale.toUpperCase()}**: "${item.text}"\n`);
        }
        return md;
      }
    } catch {}
    return null;
  }

  private hoverMiddleware(rootPath: string, key: string): vscode.MarkdownString | null {
    const middlewareConfig = path.join(rootPath, 'src', 'config', 'middleware.ts');
    if (!fs.existsSync(middlewareConfig)) return null;

    try {
      const content = fs.readFileSync(middlewareConfig, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`${key}:`) || lines[i].includes(`'${key}':`) || lines[i].includes(`"${key}":`)) {
          const valueStr = lines[i].substring(lines[i].indexOf(':') + 1).trim().replace(/,$/, '');
          const md = new vscode.MarkdownString();
          md.appendMarkdown(`### Maxima Middleware: \`${key}\`\n`);
          md.appendMarkdown(`* **Class**: \`${valueStr}\`\n`);
          md.appendMarkdown(`* **Defined in**: \`src/config/middleware.ts\` (line ${i + 1})\n`);
          return md;
        }
      }
    } catch {}
    return null;
  }

  private hoverAppBinding(rootPath: string, key: string): vscode.MarkdownString | null {
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
            if (lines[i].includes(`'${key}'`) || lines[i].includes(`"${key}"`)) {
              const md = new vscode.MarkdownString();
              md.appendMarkdown(`### Container Binding: \`${key}\`\n`);
              md.appendMarkdown(`* **Defined in**: \`${path.relative(rootPath, provider).replace(/\\/g, '/')}\` (line ${i + 1})\n`);
              md.appendCodeblock(lines[i].trim(), 'typescript');
              return md;
            }
          }
        } catch {}
      }
    }

    const defaults: Record<string, string> = {
      auth: 'Authentication Service',
      cache: 'Cache Store Manager',
      queue: 'Queue Manager / Queue connections',
      session: 'Session Store Driver',
      events: 'Event Dispatcher',
      broadcast: 'Broadcasting Manager',
      filesystem: 'Filesystem Disk Manager',
      mail: 'Mailer Service',
      notifications: 'Notification Sender',
      router: 'HTTP Router Service',
      validator: 'Data Validator Service',
      logger: 'Application Logger'
    };

    if (defaults[key]) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`### Container Binding: \`${key}\`\n`);
      md.appendMarkdown(`${defaults[key]}`);
      return md;
    }

    return null;
  }
}
