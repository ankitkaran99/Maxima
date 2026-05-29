import * as vscode from 'vscode';
import * as commands from './commands';
import { MaximaCommandsProvider, MaximaAppExplorerProvider, MaximaRoutesProvider } from './treeView';
import { MaximaCompletionProvider } from './autocomplete';
import { MaximaDefinitionProvider } from './navigation';
import { registerDiagnostics, MaximaCodeActionProvider } from './diagnostics';
import { MaximaHoverProvider } from './hover';

export function activate(context: vscode.ExtensionContext) {
  // Command registry
  const registeredCommands = [
    vscode.commands.registerCommand('maxima.runDevServer', commands.runDevServer),
    vscode.commands.registerCommand('maxima.stopDevServer', commands.stopDevServer),
    vscode.commands.registerCommand('maxima.runMigrations', commands.runMigrations),
    vscode.commands.registerCommand('maxima.rollbackMigrations', commands.rollbackMigrations),
    vscode.commands.registerCommand('maxima.refreshMigrations', commands.refreshMigrations),
    vscode.commands.registerCommand('maxima.freshMigrations', commands.freshMigrations),
    vscode.commands.registerCommand('maxima.dbSeed', commands.dbSeed),
    vscode.commands.registerCommand('maxima.makeController', commands.makeController),
    vscode.commands.registerCommand('maxima.makeModel', commands.makeModel),
    vscode.commands.registerCommand('maxima.makeMigration', commands.makeMigration),
    vscode.commands.registerCommand('maxima.makeMiddleware', commands.makeMiddleware),
    vscode.commands.registerCommand('maxima.makeRequest', commands.makeRequest),
    vscode.commands.registerCommand('maxima.makeNotification', commands.makeNotification),
    vscode.commands.registerCommand('maxima.makeMail', commands.makeMail),
    vscode.commands.registerCommand('maxima.makeJob', commands.makeJob),
    vscode.commands.registerCommand('maxima.clearCache', commands.clearCache),
    vscode.commands.registerCommand('maxima.optimize', commands.optimize),
    vscode.commands.registerCommand('maxima.routeList', commands.routeList),
    vscode.commands.registerCommand('maxima.horizonStatus', commands.horizonStatus),
    vscode.commands.registerCommand('maxima.runTests', commands.runTests),
    vscode.commands.registerCommand('maxima.about', commands.about),
    vscode.commands.registerCommand('maxima.openFile', (filePath: string) => {
      vscode.workspace.openTextDocument(filePath).then(doc => {
        vscode.window.showTextDocument(doc);
      }, err => {
        vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
      });
    }),
    vscode.commands.registerCommand('maxima.openRouteDefinition', commands.openRouteDefinition),
    vscode.commands.registerCommand('maxima.viewLatestLog', commands.viewLatestLog),
    vscode.commands.registerCommand('maxima.addEnvKey', commands.addEnvKey),
    vscode.commands.registerCommand('maxima.copyEnvKeyFromExample', commands.copyEnvKeyFromExample),
    vscode.commands.registerCommand('maxima.createViewTemplate', commands.createViewTemplate)
  ];

  context.subscriptions.push(...registeredCommands);

  // Register Completion Item Provider for JavaScript & TypeScript
  const autocompleteProvider = vscode.languages.registerCompletionItemProvider(
    [
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'typescriptreact' },
      { scheme: 'file', language: 'javascriptreact' }
    ],
    new MaximaCompletionProvider(),
    '.', "'", '"'
  );
  context.subscriptions.push(autocompleteProvider);

  // Register Go to Definition Provider
  const definitionProvider = vscode.languages.registerDefinitionProvider(
    [
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'typescriptreact' },
      { scheme: 'file', language: 'javascriptreact' }
    ],
    new MaximaDefinitionProvider()
  );
  context.subscriptions.push(definitionProvider);

  // Register Hover Provider
  const hoverProvider = vscode.languages.registerHoverProvider(
    [
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'typescriptreact' },
      { scheme: 'file', language: 'javascriptreact' }
    ],
    new MaximaHoverProvider()
  );
  context.subscriptions.push(hoverProvider);

  // Register Diagnostics
  registerDiagnostics(context);

  // Register Code Actions (Quick Fixes) Provider
  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    [
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'typescriptreact' },
      { scheme: 'file', language: 'javascriptreact' }
    ],
    new MaximaCodeActionProvider()
  );
  context.subscriptions.push(codeActionProvider);

  // Initialize and register Tree View Providers
  const commandsProvider = new MaximaCommandsProvider();
  vscode.window.registerTreeDataProvider('maxima-commands', commandsProvider);

  const appExplorerProvider = new MaximaAppExplorerProvider();
  vscode.window.registerTreeDataProvider('maxima-explorer', appExplorerProvider);

  const routesProvider = new MaximaRoutesProvider();
  vscode.window.registerTreeDataProvider('maxima-routes', routesProvider);

  // Refresh App Explorer when relevant folders change (controllers, models, migrations etc.)
  const rootPath = commands.getMaximaRootPath();
  if (rootPath) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootPath, '{src,routes}/**/*')
    );
    watcher.onDidCreate(() => {
      appExplorerProvider.refresh();
      commandsProvider.refresh();
      routesProvider.refresh();
    });
    watcher.onDidDelete(() => {
      appExplorerProvider.refresh();
      commandsProvider.refresh();
      routesProvider.refresh();
    });
    watcher.onDidChange(() => {
      appExplorerProvider.refresh();
      commandsProvider.refresh();
      routesProvider.refresh();
    });
    context.subscriptions.push(watcher);
  }

  // Handle manual terminal closures gracefully
  vscode.window.onDidCloseTerminal(t => {
    if (t.name === 'Maxima Server') {
      vscode.window.showInformationMessage('Maxima Dev Server stopped (terminal closed).');
    }
  });

  console.log('Maxima Framework Assistant activated.');
}

export function deactivate() {}
