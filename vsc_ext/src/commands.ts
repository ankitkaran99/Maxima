import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Resolves the absolute path to the Maxima project root directory.
 */
export function getMaximaRootPath(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }
  const rootPath = workspaceFolders[0].uri.fsPath;
  const configuredPath = vscode.workspace.getConfiguration('maxima').get<string>('path');
  if (configuredPath) {
    if (path.isAbsolute(configuredPath)) {
      return configuredPath;
    }
    return path.join(rootPath, configuredPath);
  }
  return rootPath;
}

/**
 * Runs a command in the shared Maxima CLI terminal.
 */
export function runMaximaCommand(subCommand: string): void {
  const rootPath = getMaximaRootPath();
  if (!rootPath) {
    vscode.window.showErrorMessage('Maxima: Unable to resolve workspace root.');
    return;
  }

  // Find or create terminal
  let terminal = vscode.window.terminals.find(t => t.name === 'Maxima CLI');
  if (!terminal) {
    terminal = vscode.window.createTerminal({
      name: 'Maxima CLI',
      cwd: rootPath
    });
  }

  terminal.sendText(`npm run maxima -- ${subCommand}`);
  terminal.show();
}

/**
 * Starts the Maxima development server.
 */
export function runDevServer(): void {
  const rootPath = getMaximaRootPath();
  if (!rootPath) {
    vscode.window.showErrorMessage('Maxima: Unable to resolve workspace root.');
    return;
  }

  let terminal = vscode.window.terminals.find(t => t.name === 'Maxima Server');
  if (terminal) {
    terminal.show();
    vscode.window.showInformationMessage('Maxima Dev Server is already running.');
    return;
  }

  terminal = vscode.window.createTerminal({
    name: 'Maxima Server',
    cwd: rootPath
  });

  terminal.sendText('npm run dev');
  terminal.show();
  vscode.window.showInformationMessage('Starting Maxima Dev Server...');
}

/**
 * Stops the Maxima development server.
 */
export function stopDevServer(): void {
  const terminal = vscode.window.terminals.find(t => t.name === 'Maxima Server');
  if (terminal) {
    terminal.dispose();
    vscode.window.showInformationMessage('Maxima Dev Server stopped.');
  } else {
    vscode.window.showInformationMessage('Maxima Dev Server is not running.');
  }
}

/**
 * Runs database migrations.
 */
export function runMigrations(): void {
  runMaximaCommand('migrate');
}

/**
 * Rolls back the last database migration batch.
 */
export function rollbackMigrations(): void {
  runMaximaCommand('migrate:rollback');
}

/**
 * Refreshes database migrations (rollback + migrate).
 */
export function refreshMigrations(): void {
  runMaximaCommand('migrate:refresh');
}

/**
 * Fresh migrations (drop all tables + migrate + optional seed).
 */
export async function freshMigrations(): Promise<void> {
  const seedOption = await vscode.window.showQuickPick(['No', 'Yes'], {
    placeHolder: 'Run database seeders (db:seed) after fresh migration?'
  });

  if (seedOption === 'Yes') {
    runMaximaCommand('migrate:fresh --seed');
  } else if (seedOption === 'No') {
    runMaximaCommand('migrate:fresh');
  }
}

/**
 * Runs database seeders.
 */
export function dbSeed(): void {
  runMaximaCommand('db:seed');
}

/**
 * Clears application cache.
 */
export function clearCache(): void {
  runMaximaCommand('optimize:clear');
}

/**
 * Caches configurations and routes for optimization.
 */
export function optimize(): void {
  runMaximaCommand('optimize');
}

/**
 * Shows list of application routes.
 */
export function routeList(): void {
  runMaximaCommand('route:list');
}

/**
 * Checks Horizon queue status.
 */
export function horizonStatus(): void {
  runMaximaCommand('horizon:status');
}

/**
 * Runs the application test suite.
 */
export function runTests(): void {
  const rootPath = getMaximaRootPath();
  if (!rootPath) {
    vscode.window.showErrorMessage('Maxima: Unable to resolve workspace root.');
    return;
  }

  let terminal = vscode.window.terminals.find(t => t.name === 'Maxima CLI');
  if (!terminal) {
    terminal = vscode.window.createTerminal({
      name: 'Maxima CLI',
      cwd: rootPath
    });
  }

  terminal.sendText('npm test');
  terminal.show();
}

/**
 * Shows about application information.
 */
export function about(): void {
  runMaximaCommand('about');
}

/**
 * Interactive input wrapper for running generators.
 */
async function promptAndGenerate(
  generatorName: string,
  typeName: string,
  placeholder: string
): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: `Enter the name of the ${typeName} to generate:`,
    placeHolder: placeholder,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return 'Name is required';
      }
      // Check for valid alphanumeric class names (usually pascal case or alphanumeric + folder prefix)
      if (!/^[a-zA-Z0-9_\/]+$/.test(value)) {
        return 'Name must contain only letters, numbers, underscores, and forward slashes for folders';
      }
      return null;
    }
  });

  if (name) {
    runMaximaCommand(`make:${generatorName} ${name}`);
  }
}

export function makeController(): void {
  promptAndGenerate('controller', 'Controller', 'UserController or Admin/UserController');
}

export function makeModel(): void {
  promptAndGenerate('model', 'Model', 'User or Post');
}

export function makeMigration(): void {
  promptAndGenerate('migration', 'Migration', 'create_users_table or add_role_to_users_table');
}

export function makeMiddleware(): void {
  promptAndGenerate('middleware', 'Middleware', 'EnsureTokenIsValid');
}

export function makeRequest(): void {
  promptAndGenerate('request', 'Form Request', 'StoreUserRequest');
}

export function makeNotification(): void {
  promptAndGenerate('notification', 'Notification', 'InvoicePaid');
}

export function makeMail(): void {
  promptAndGenerate('mail', 'Mailable', 'WelcomeMail');
}

export function makeJob(): void {
  promptAndGenerate('job', 'Queue Job', 'ProcessPodcast');
}

/**
 * Opens the file defining the given route path and attempts to select it.
 */
export function openRouteDefinition(routePath: string): void {
  const rootPath = getMaximaRootPath();
  if (!rootPath) {
    vscode.window.showErrorMessage('Maxima: Unable to resolve workspace root.');
    return;
  }

  // Determine if it is likely an API route
  const isApi = routePath.startsWith('/api');
  const relativeFile = isApi ? 'src/routes/api.ts' : 'src/routes/web.ts';
  const fullPath = path.join(rootPath, relativeFile);

  if (!fs.existsSync(fullPath)) {
    vscode.window.showErrorMessage(`Route file not found: ${relativeFile}`);
    return;
  }

  vscode.workspace.openTextDocument(fullPath).then(doc => {
    vscode.window.showTextDocument(doc).then(editor => {
      const text = doc.getText();
      // Clean path if it's API (since it is prefixed in Route.group)
      const cleanPath = routePath.startsWith('/api/') ? routePath.substring(4) : routePath;
      
      let index = text.indexOf(`'${routePath}'`);
      if (index === -1) index = text.indexOf(`"${routePath}"`);
      if (index === -1) index = text.indexOf(`'${cleanPath}'`);
      if (index === -1) index = text.indexOf(`"${cleanPath}"`);

      if (index !== -1) {
        const position = doc.positionAt(index);
        const range = new vscode.Range(position, position.translate(0, routePath.length));
        editor.selection = new vscode.Selection(position, position.translate(0, routePath.length));
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    });
  }, err => {
    vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
  });
}

/**
 * Opens the latest log file in storage/logs
 */
export function viewLatestLog(): void {
  const rootPath = getMaximaRootPath();
  if (!rootPath) {
    vscode.window.showErrorMessage('Maxima: Unable to resolve workspace root.');
    return;
  }

  const logsDir = path.join(rootPath, 'storage', 'logs');
  if (!fs.existsSync(logsDir)) {
    vscode.window.showErrorMessage('Maxima: Log directory not found at storage/logs.');
    return;
  }

  try {
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
    if (files.length === 0) {
      vscode.window.showInformationMessage('Maxima: No log files found.');
      return;
    }

    // Sort files by modified time desc
    const sortedFiles = files.map(file => {
      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);
      return { file, filePath, mtime: stat.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);

    const latestLog = sortedFiles[0].filePath;

    vscode.workspace.openTextDocument(latestLog).then(doc => {
      vscode.window.showTextDocument(doc);
    }, err => {
      vscode.window.showErrorMessage(`Failed to open log file: ${err.message}`);
    });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to read log directory: ${err.message}`);
  }
}

/**
 * Adds an environment key directly to the .env file.
 */
export function addEnvKey(envKey: string): void {
  const rootPath = getMaximaRootPath();
  if (!rootPath) return;

  const envPath = path.join(rootPath, '.env');
  try {
    fs.appendFileSync(envPath, `\n${envKey}=\n`);
    vscode.window.showInformationMessage(`Added ${envKey} to .env`);
    
    vscode.workspace.openTextDocument(envPath).then(doc => {
      vscode.window.showTextDocument(doc).then(editor => {
        const lineCount = doc.lineCount;
        const position = new vscode.Position(lineCount - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      });
    });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to write to .env: ${err.message}`);
  }
}

/**
 * Copies an environment key along with its default value from .env.example to .env.
 */
export function copyEnvKeyFromExample(envKey: string): void {
  const rootPath = getMaximaRootPath();
  if (!rootPath) return;

  const envPath = path.join(rootPath, '.env');
  const envExamplePath = path.join(rootPath, '.env.example');

  if (!fs.existsSync(envExamplePath)) {
    vscode.window.showErrorMessage('.env.example file not found.');
    return;
  }

  try {
    const exampleContent = fs.readFileSync(envExamplePath, 'utf-8');
    const match = new RegExp(`^${envKey}=(.*)$`, 'm').exec(exampleContent);
    const lineToWrite = match ? match[0] : `${envKey}=`;

    fs.appendFileSync(envPath, `\n${lineToWrite}\n`);
    vscode.window.showInformationMessage(`Copied ${envKey} from .env.example`);
    
    vscode.workspace.openTextDocument(envPath).then(doc => {
      vscode.window.showTextDocument(doc).then(editor => {
        const lineCount = doc.lineCount;
        const position = new vscode.Position(lineCount - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      });
    });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to copy to .env: ${err.message}`);
  }
}

/**
 * Creates a missing view template file and opens it.
 */
export function createViewTemplate(viewKey: string): void {
  const rootPath = getMaximaRootPath();
  if (!rootPath) return;

  const relativePath = viewKey.replace(/\./g, '/') + '.edge';
  const fullPath = path.join(rootPath, 'src', 'resources', 'views', relativePath);

  try {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(fullPath)) {
      const basicTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${viewKey}</title>
</head>
<body>
  <h1>${viewKey} View</h1>
</body>
</html>
`;
      fs.writeFileSync(fullPath, basicTemplate, 'utf-8');
    }

    vscode.workspace.openTextDocument(fullPath).then(doc => {
      vscode.window.showTextDocument(doc);
    });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to create view: ${err.message}`);
  }
}

