import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { getMaximaRootPath } from './commands';

// --- Maxima Commands Tree View ---

export class MaximaCommandsProvider implements vscode.TreeDataProvider<CommandTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<CommandTreeItem | undefined | null | void> = new vscode.EventEmitter<CommandTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CommandTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CommandTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CommandTreeItem): Thenable<CommandTreeItem[]> {
    if (!element) {
      // Root Categories
      return Promise.resolve([
        new CommandTreeItem('Development Server', vscode.TreeItemCollapsibleState.Expanded, 'server-group'),
        new CommandTreeItem('Generators', vscode.TreeItemCollapsibleState.Collapsed, 'generators-group'),
        new CommandTreeItem('Database', vscode.TreeItemCollapsibleState.Collapsed, 'database-group'),
        new CommandTreeItem('Cache & Optimizations', vscode.TreeItemCollapsibleState.Collapsed, 'cache-group'),
        new CommandTreeItem('Application Diagnostics', vscode.TreeItemCollapsibleState.Collapsed, 'diag-group')
      ]);
    }

    const category = element.contextValue;
    if (category === 'server-group') {
      return Promise.resolve([
        new CommandTreeItem('Start Dev Server', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.runDevServer', 'play'),
        new CommandTreeItem('Stop Dev Server', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.stopDevServer', 'terminate')
      ]);
    } else if (category === 'generators-group') {
      return Promise.resolve([
        new CommandTreeItem('Generate Controller', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.makeController', 'new-file'),
        new CommandTreeItem('Generate Model', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.makeModel', 'symbol-class'),
        new CommandTreeItem('Generate Migration', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.makeMigration', 'database'),
        new CommandTreeItem('Generate Middleware', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.makeMiddleware', 'shield'),
        new CommandTreeItem('Generate Form Request', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.makeRequest', 'checklist'),
        new CommandTreeItem('Generate Notification', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.makeNotification', 'bell'),
        new CommandTreeItem('Generate Mail', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.makeMail', 'mail'),
        new CommandTreeItem('Generate Queue Job', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.makeJob', 'run-all')
      ]);
    } else if (category === 'database-group') {
      return Promise.resolve([
        new CommandTreeItem('Run Migrations (migrate)', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.runMigrations', 'database'),
        new CommandTreeItem('Rollback Migrations', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.rollbackMigrations', 'discard'),
        new CommandTreeItem('Refresh Migrations', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.refreshMigrations', 'refresh'),
        new CommandTreeItem('Fresh Migrations & Seed', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.freshMigrations', 'trash'),
        new CommandTreeItem('Run Seeders (db:seed)', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.dbSeed', 'symbol-method')
      ]);
    } else if (category === 'cache-group') {
      return Promise.resolve([
        new CommandTreeItem('Cache Config & Routes', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.optimize', 'package'),
        new CommandTreeItem('Clear Caches (optimize:clear)', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.clearCache', 'clear-all')
      ]);
    } else if (category === 'diag-group') {
      return Promise.resolve([
        new CommandTreeItem('Show App Info (about)', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.about', 'info'),
        new CommandTreeItem('List Routes (route:list)', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.routeList', 'list-unordered'),
        new CommandTreeItem('Horizon Queue Status', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.horizonStatus', 'graph'),
        new CommandTreeItem('Run Tests', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.runTests', 'beaker'),
        new CommandTreeItem('View Latest Log File', vscode.TreeItemCollapsibleState.None, 'command', 'maxima.viewLatestLog', 'output')
      ]);
    }

    return Promise.resolve([]);
  }
}

export class CommandTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    public readonly commandId?: string,
    public readonly iconName?: string
  ) {
    super(label, collapsibleState);
    if (commandId) {
      this.command = {
        title: label,
        command: commandId
      };
    }
    if (iconName) {
      this.iconPath = new vscode.ThemeIcon(iconName);
    }
  }
}

// --- Maxima App Explorer Tree View ---

export class MaximaAppExplorerProvider implements vscode.TreeDataProvider<ExplorerTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ExplorerTreeItem | undefined | null | void> = new vscode.EventEmitter<ExplorerTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ExplorerTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ExplorerTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ExplorerTreeItem): Thenable<ExplorerTreeItem[]> {
    const rootPath = getMaximaRootPath();
    if (!rootPath) {
      return Promise.resolve([
        new ExplorerTreeItem('No Open Maxima Project', vscode.TreeItemCollapsibleState.None, false, 'info')
      ]);
    }

    if (!element) {
      // Define root folders to track
      const categories = [
        { name: 'Controllers', subPath: 'src/app/Http/Controllers', icon: 'server' },
        { name: 'Models', subPath: 'src/app/Models', icon: 'symbol-class' },
        { name: 'Middleware', subPath: 'src/app/Http/Middleware', icon: 'shield' },
        { name: 'Form Requests', subPath: 'src/app/Http/Requests', icon: 'checklist' },
        { name: 'Routes', subPath: 'src/routes', icon: 'split-horizontal' },
        { name: 'Migrations', subPath: 'src/database/migrations', icon: 'database' },
        { name: 'Config', subPath: 'src/config', icon: 'settings-gear' }
      ];

      const items = categories.map(cat => {
        const fullPath = path.join(rootPath, cat.subPath);
        const exists = fs.existsSync(fullPath);
        return new ExplorerTreeItem(
          cat.name,
          exists ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
          true,
          cat.icon,
          fullPath,
          exists
        );
      });

      return Promise.resolve(items);
    }

    // Children are files/subfolders inside target paths
    if (element.fullPath && element.exists) {
      try {
        const files = fs.readdirSync(element.fullPath);
        const items = files.map(file => {
          const itemPath = path.join(element.fullPath!, file);
          const stat = fs.statSync(itemPath);
          const isDir = stat.isDirectory();
          return new ExplorerTreeItem(
            file,
            isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            isDir,
            isDir ? 'folder' : 'file',
            itemPath,
            true
          );
        });

        // Sort: directories first, then alphabetically
        items.sort((a, b) => {
          if (a.isDir && !b.isDir) {return -1;}
          if (!a.isDir && b.isDir) {return 1;}
          return a.label.localeCompare(b.label);
        });

        return Promise.resolve(items);
      } catch (err) {
        return Promise.resolve([
          new ExplorerTreeItem('Failed to read directory', vscode.TreeItemCollapsibleState.None, false, 'warning')
        ]);
      }
    }

    return Promise.resolve([]);
  }
}

export class ExplorerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly isDir: boolean,
    public readonly iconName: string,
    public readonly fullPath?: string,
    public readonly exists: boolean = false
  ) {
    super(label, collapsibleState);
    
    if (iconName) {
      this.iconPath = new vscode.ThemeIcon(iconName);
    }

    if (!isDir && fullPath) {
      this.resourceUri = vscode.Uri.file(fullPath);
      this.command = {
        title: 'Open File',
        command: 'maxima.openFile',
        arguments: [fullPath]
      };
      this.contextValue = 'fileItem';
    } else if (isDir && fullPath) {
      this.contextValue = 'dirItem';
    } else {
      this.contextValue = 'infoItem';
    }

    // If it's a root category that doesn't exist yet, show that it is inactive
    if (fullPath && !exists) {
      this.description = '(not created yet)';
      this.tooltip = `Path does not exist: ${fullPath}`;
    }
  }
}

// --- Maxima Routes Tree View ---

export class MaximaRoutesProvider implements vscode.TreeDataProvider<RouteTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<RouteTreeItem | undefined | null | void> = new vscode.EventEmitter<RouteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<RouteTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RouteTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RouteTreeItem): Thenable<RouteTreeItem[]> {
    const rootPath = getMaximaRootPath();
    if (!rootPath) {
      return Promise.resolve([
        new RouteTreeItem('No Open Maxima Project', vscode.TreeItemCollapsibleState.None)
      ]);
    }

    if (element) {
      return Promise.resolve([]);
    }

    return new Promise((resolve) => {
      // Run the maxima route:list --json command
      exec('npm run maxima -- route:list --json', { cwd: rootPath }, (error, stdout) => {
        if (error) {
          return resolve([
            new RouteTreeItem('Failed to load routes', vscode.TreeItemCollapsibleState.None, undefined, undefined, `Error: ${error.message}`)
          ]);
        }

        try {
          const lines = stdout.split('\n');
          const jsonLine = lines.find(l => l.trim().startsWith('[') && l.trim().endsWith(']'));
          if (!jsonLine) {
            return resolve([
              new RouteTreeItem('No routes found', vscode.TreeItemCollapsibleState.None)
            ]);
          }

          const routes = JSON.parse(jsonLine.trim()) as { method: string; path: string; name?: string; middleware?: string[] }[];
          
          if (routes.length === 0) {
            return resolve([
              new RouteTreeItem('No routes defined', vscode.TreeItemCollapsibleState.None)
            ]);
          }

          const items = routes.map(r => {
            const label = `[${r.method}] ${r.path}`;
            const tooltip = `Method: ${r.method}\nPath: ${r.path}\nName: ${r.name || 'none'}\nMiddleware: ${(r.middleware || []).join(', ')}`;
            const description = r.name ? `${r.name}` : '';
            return new RouteTreeItem(label, vscode.TreeItemCollapsibleState.None, r.path, r.method, tooltip, description);
          });

          resolve(items);
        } catch (e: any) {
          resolve([
            new RouteTreeItem('Failed to parse routes', vscode.TreeItemCollapsibleState.None, undefined, undefined, `JSON Parse Error: ${e.message}`)
          ]);
        }
      });
    });
  }
}

export class RouteTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly routePath?: string,
    public readonly method?: string,
    public readonly tooltipString?: string,
    public readonly descriptionString?: string
  ) {
    super(label, collapsibleState);
    this.tooltip = tooltipString;
    this.description = descriptionString;

    if (method) {
      // Choose an icon based on method
      let icon = 'symbol-interface';
      if (method === 'GET') icon = 'go-to-file';
      else if (method === 'POST') icon = 'new-file';
      else if (method === 'PUT') icon = 'edit';
      else if (method === 'DELETE') icon = 'trash';
      this.iconPath = new vscode.ThemeIcon(icon);
    }

    if (routePath) {
      this.command = {
        title: 'Open Route Definition',
        command: 'maxima.openRouteDefinition',
        arguments: [routePath]
      };
      this.contextValue = 'routeItem';
    }
  }
}
