// src/types.ts

/** Information about a named or default export. */
export interface ExportInfo {
    name: string;        // Exported name ('default' for default exports)
    localName?: string;  // Original name in the file if different (e.g., export default myFunction -> name: 'default', localName: 'myFunction')
    filePath: string;
    line: number;        // Line number where exported/declared
    isDefault: boolean;
    // New field to categorize export types (route handler, server action, hook, etc.)
    category?: 'route-handler' | 'server-action' | 'hook' | 'component' | 'utility';
}

/** Information about an import statement. */
export interface ImportInfo {
    sourcePath: string;     // File where the import occurs
    importedNames: string[]; // Names imported or used locally (e.g., ['useState', 'myAlias'] for import { x as myAlias } from ..)
    sourceModule: string;   // The module path literal (e.g., 'react', './utils', '@/components/button')
    line: number;           // Line number of the import statement
}

/** Enhanced dynamic usage patterns for functions that may not be imported directly */
export interface DynamicUsageInfo {
    usageType: 'fetch' | 'form-action' | 'hook-call' | 'server-action-call';
    targetPath: string;     // Target API path for fetch or component for form action
    method?: string;        // HTTP method (GET, POST, etc.) for fetch calls
    sourceFile: string;     // File where the usage occurs
    line: number;           // Line number of the usage
}

/** Information about an interface declaration. */
export interface InterfaceInfo {
    name: string;
    filePath: string;
    line: number; // Line number where declared
}

/** Represents a location where an export or interface is used. */
export interface UsageInfo {
    filePath: string;
    line: number;
}

/** Information about a detected route in Next.js App Router. */
export interface RouteInfo {
    routePath: string; // e.g., /about, /api/users/[id]
    filePath: string; // Path relative to workspace root
    isApi: boolean;   // True if it's an API route (route.ts)
    exportedMethods?: string[]; // HTTP methods exported (GET, POST, etc.)
    usedIn?: DynamicUsageInfo[]; // Where this route is used (fetch calls, etc.)
}

/** Information about a detected server action. */
export interface ServerActionInfo {
    name: string;
    filePath: string;
    line: number;
    usedIn?: DynamicUsageInfo[]; // Where this server action is used
}

/** Information about a detected React hook. */
export interface HookInfo {
    name: string;
    filePath: string;
    line: number;
    usedIn?: DynamicUsageInfo[]; // Where this hook is used
}

/** Information about an import that couldn't be resolved to a valid export. */
export interface MissingImportInfo {
    importingFilePath: string; // Path to the file with the bad import
    importingLine: number;     // Line number of the import statement
    missingName: string;       // The specific name that couldn't be found
    targetModule: string;      // The module path literal being imported from
    resolvedTargetPath?: string; // The file path the targetModule resolved to (if it resolved)
    resolutionError?: string;  // Error message if module resolution failed
}

/** Structure holding the results of the full analysis. */
export interface AnalysisResult {
    usedExports: Map<string, ExportInfo & { usedIn: UsageInfo[] }>; // Key: unique identifier (filePath + name + isDefault)
    unusedExports: ExportInfo[];
    missingImports: MissingImportInfo[];
    interfaces: Map<string, InterfaceInfo & { usedIn: UsageInfo[] }>; // Key: interface name (global map)
    routes: RouteInfo[];
    serverActions: ServerActionInfo[];
    hooks: HookInfo[];
    dynamicUsages: DynamicUsageInfo[];
    errors: string[]; // Store parsing/finding/resolution errors encountered
}

/** Result from the file finder. */
export interface FileFinderResult {
    files: string[];
    error?: string;
}