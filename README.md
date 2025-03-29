# Next.js Dependency Tracker for VS Code

## Overview

Next.js Dependency Tracker is a VS Code extension that analyzes your Next.js codebase to provide comprehensive insights into dependencies, imports, exports, and routing structure. It's designed to help developers better understand their codebase, identify potential dead code, and visualize component relationships.

## Features

- **Export Analysis**: Track which exports are used and unused throughout your codebase
- **Next.js Framework Intelligence**: Special handling for Next.js-specific patterns:
  - Page components
  - Layout components
  - Route handlers
  - Server actions
  - Special exports like `generateMetadata`
- **Interface Tracking**: See where TypeScript interfaces are defined and used
- **Route Mapping**: Visualize the structure of your Next.js application's routes
- **Automatic Reporting**: Generates detailed markdown reports with all analyzed information

## Output Example

The extension generates a `.dependencies` folder in your project root with markdown files providing detailed insights:

```
.dependencies/
  ├── used_exports.md      # Exports imported in other files
  ├── unused_exports.md    # Potentially unused code - read the limitations section!
  ├── interfaces.md        # Interface/type definitions and usage
  ├── routes.md            # Next.js routes structure and usage
  └── missing_imports.md   # Imports that couldn't be resolved
```

These reports provide valuable information about your codebase structure, dependencies, and potential issues.

## Installation

The extension is currently NOT directly available from the VS Code Marketplace.

### Manual Installation (.vsix)

To install from a .vsix file:

1. Download the .vsix file from the [GitHub releases page](https://github.com/SlippyDong/nextjs-dependency-tracker/releases/)
2. In VS Code, go to Extensions (Ctrl+Shift+P)
3. Search and select: "Extensions: Install from VSIX
4. Navigate to the downloaded .vsix file and open it

### Building from Source

To build the extension yourself:

```bash
# Clone the repository
git clone https://github.com/SlippyDong/nextjs-dependency-tracker.git
cd nextjs-dependency-tracker

# Install dependencies
npm install

# Package the extension
npx vsce package
```

This will generate a .vsix file you can install manually.

## Usage

1. Open a Next.js project in VS Code
2. Upon opening a project, the extension will prompt to analyze the code base in the notification area. You can choose to run or skip this. Depending on the size of your code base, running a scan takes between seconds and minutes.
3. Run the extension manually:
   - Opening the Command Palette (Ctrl+Shift+P)
   - Typing "Next.js: Analyze Dependencies" and selecting the command
3. The extension will analyze your codebase and generate reports in the `.dependencies` folder at your workspace root

### Generated Reports

The extension creates five markdown files in the `.dependencies` folder:

1. **used_exports.md**: Lists all exports that are imported elsewhere in your project, showing where they're used
2. **unused_exports.md**: Shows exports that aren't imported anywhere (potential dead code)
3. **interfaces.md**: Details all TypeScript interfaces/types and where they're used
4. **routes.md**: Maps out your Next.js application's route structure, including API routes and their methods
5. **missing_imports.md**: Identifies imports that couldn't be resolved to a source file

### Viewing Reports

The reports are standard markdown files that can be viewed in VS Code or any markdown viewer. They provide detailed information about your codebase's structure and dependencies.

## Extension Settings

This extension contributes the following settings:

* `nextjsDependencyTracker.enableAutomaticAnalysis`: When true, automatically analyzes dependencies when a Next.js project is opened
* `nextjsDependencyTracker.outputDir`: Specify a custom output directory for dependency reports (default: `.dependencies`)
* `nextjsDependencyTracker.excludeFolders`: Array of folders to exclude from analysis (e.g., `["node_modules", ".next"]` etc.)
* `nextjsDependencyTracker.includeServerComponents`: When true, includes server components in the analysis (default: true)

## Limitations

- **Re-export Chains**: The extension doesn't fully track exports that are re-exported through index files
- **Dynamic Imports**: Cannot detect imports that use dynamic `import()` expressions with variables
- **Runtime Resolution**: Cannot detect usage patterns that are resolved at runtime
- **External Usage**: Cannot detect exports used only in external projects
- **Duplicate Type Definitions**: When the same interface is defined in multiple files, each is tracked separately

## Troubleshooting

If you encounter issues with the extension:

1. Ensure your Next.js project structure follows standard conventions. This extension was built with NextJS app router for testing purposes.
2. Check the extension's output in the VS Code Output panel (Next.js Dependency Tracker)
3. Consider adding problematic folders to the `excludeFolders` setting
4. For large projects, the initial analysis may take some time

## Contributing

Contributions are welcome! Feel free to submit pull requests or issues on the [GitHub repository](https://github.com/SlippyDong/nextjs-dependency-tracker.git).

## License

This extension is licensed under the MIT License. See the LICENSE file for details.

---

## How Reports Help Your Development

The reports generated by this extension provide valuable insights:

### 1. Identifying Dead Code
The `unused_exports.md` helps you identify potential dead code that could be removed to improve maintainability and reduce bundle size.

### 2. Understanding Component Relationships
The `interfaces.md` and `used_exports.md` files show relationships between components, making it easier to understand the structure of your application and easier to find duplicate or redundant code.

### 3. API Documentation
The `routes.md` file effectively documents your API endpoints, showing what routes are available and what HTTP methods they support.

### 4. Refactoring Support
Before making significant changes, you can review these reports to understand potential impacts across your codebase.

### 5. Onboarding New Developers
These reports provide a map of your codebase, helping new team members understand the project structure quickly.

