# Maxima Framework Assistant for VS Code

The **Maxima Framework Assistant** provides rich integrations and developer tools for the **Maxima Framework**—a Laravel-inspired TypeScript framework powered by Fastify.

---

## Features

### 🚀 1. Commands & CLI Dashboard
Run Maxima Artisan-style CLI commands directly inside VS Code through the Command Palette or the Maxima Sidebar Dashboard:
*   **Development Server**: Start/Stop the dev server with one click (`npm run dev`).
*   **Generators**: Create controllers, models, database migrations, middleware, forms requests, mailables, jobs, and notifications with interactive input prompts.
*   **Database Tools**: Run migrations (`migrate`), rollback (`migrate:rollback`), refresh, fresh database installs with seeding, or seed manually (`db:seed`).
*   **Cache Management**: Warm framework caches (`optimize`) or clear everything (`optimize:clear`).
*   **Diagnostics**: List all defined routes (`route:list`), inspect the project layout/details (`about`), check active Horizon status, and execute unit/integration tests with Vitest.

### 📁 2. Maxima App Explorer Tree View
Browse only the relevant components of your Maxima application:
*   Lists all **Controllers**, **Models**, **Middleware**, **Requests**, **Routes**, **Migrations**, and **Configuration** files.
*   Click files to open them immediately.
*   Shows indicators if a specific directory has not been generated yet.
*   Automatically refreshes in real-time as files are created, renamed, or deleted via the integrated VS Code FileSystemWatcher.

### 📝 3. Rich Code Snippets
Start writing Maxima APIs faster using built-in, highly optimized code snippets:
*   `mxroute-get`: Create a standard GET route.
*   `mxroute-post`: Create a standard POST route.
*   `mxroute-group`: Define a nested route group.
*   `mxmodel`: Create a Maxima Eloquent-style model structure.
*   `mxrelation-hasmany`: Define a HasMany relationship.
*   `mxrelation-belongsto`: Define a BelongsTo relationship.
*   `mxdb-table`: Query the DB directly.
*   `mxdb-transaction`: Wrap DB queries inside transactions.
*   `mxschema-create`: Scaffold a new database migration table.
*   `mxcontroller`: Create standard MVC controllers.
*   `mxmiddleware`: Scaffold custom middleware.
*   `mxprovider`: Write a framework Service Provider.

---

## Extension Settings

You can customize the following configuration options under VS Code Settings (`Ctrl+,` or `Cmd+,`):

*   `maxima.path`: Relative or absolute path to the Maxima project root directory. Helpful for monorepos where Maxima is nested. (Default: `""` / Workspace root).
*   `maxima.port`: Target port number for the development server. (Default: `3000`).

---

## Requirements & Setup

1.  Make sure you have Node.js and npm installed.
2.  Open a Maxima project in your VS Code workspace.
3.  Install dependencies:
    ```bash
    npm install
    ```
4.  Run commands using the `Maxima` icon on the Activity Bar.

Enjoy developing on the Maxima Framework! 🚀
