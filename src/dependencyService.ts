// src/dependencyService.ts
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as nodeFs from 'fs'; // Use sync methods for path resolution/checking
import * as path from 'path';
import * as ts from 'typescript'; // Import the typescript library itself
import { findProjectFiles } from './fileFinder';
import { parseProject } from './parser';
import { AnalysisResult, ExportInfo, UsageInfo, InterfaceInfo, RouteInfo, MissingImportInfo, ImportInfo } from './types';
import { log, logError, getWorkspacePath, relativePath } from './utils';

const OUTPUT_DIR_NAME = '.dependencies';

/** Represents the relevant compiler options for path resolution. */
interface TsConfigPaths {
    baseUrl: string;
    paths: ts.MapLike<string[]>;
}

let cachedTsConfigPaths: TsConfigPaths | null = null;
let tsConfigReadAttempted = false;

/** Ensures the output directory exists. */
async function ensureOutputDir(workspacePath: string): Promise<string | null> {
    // ... (keep this function as is)
    const outputDirPath = path.join(workspacePath, OUTPUT_DIR_NAME);
    try {
        await fs.mkdir(outputDirPath, { recursive: true });
        return outputDirPath;
    } catch (error) {
        logError(`Failed to create output directory: ${relativePath(outputDirPath, workspacePath)}`, error);
        vscode.window.showErrorMessage(`Dependency Tracker: Could not create output directory '${OUTPUT_DIR_NAME}'.`);
        return null;
    }
}

/**
 * Finds and parses the tsconfig.json (or jsconfig.json) to extract baseUrl and paths.
 * Caches the result for performance.
 */
function getTsConfigOptions(workspacePath: string): TsConfigPaths | null {
    if (tsConfigReadAttempted) {
        return cachedTsConfigPaths; // Return cached result (even if null)
    }
    tsConfigReadAttempted = true;

    try {
        const configFileName = ts.findConfigFile(
            workspacePath,
            ts.sys.fileExists,
            'tsconfig.json'
        ) || ts.findConfigFile( // Fallback to jsconfig.json
            workspacePath,
            ts.sys.fileExists,
            'jsconfig.json'
        );

        if (!configFileName) {
            log('No tsconfig.json or jsconfig.json found in the workspace root.');
            return null;
        }
        log(`Found config file: ${relativePath(configFileName, workspacePath)}`);

        const configFile = ts.readConfigFile(configFileName, ts.sys.readFile);
        if (configFile.error) {
            logError(`Error reading config file ${configFileName}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
            return null;
        }

        const parseConfigHost: ts.ParseConfigHost = {
            fileExists: ts.sys.fileExists,
            readFile: ts.sys.readFile,
            readDirectory: ts.sys.readDirectory,
            useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames
        };

        const parsedCommandLine = ts.parseJsonConfigFileContent(
            configFile.config,
            parseConfigHost,
            path.dirname(configFileName),
            { noEmit: true }
        );

        if (parsedCommandLine.errors.length > 0) {
            parsedCommandLine.errors.forEach(error => {
                 logError(`Error parsing config file ${configFileName}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
            });
        }

        const options = parsedCommandLine.options;
        const baseUrl = path.resolve(path.dirname(configFileName), options.baseUrl || '.');
        const paths = options.paths || {};

        log(`Using baseUrl: ${relativePath(baseUrl, workspacePath)}`);
        if (Object.keys(paths).length > 0) {
            log(`Found paths: ${JSON.stringify(paths)}`);
        }

        cachedTsConfigPaths = { baseUrl, paths };
        return cachedTsConfigPaths;

    } catch (error) {
        logError('Error processing tsconfig/jsconfig file', error);
        return null;
    }
}

// Function to reset the cache
export function clearTsConfigCache() {
    cachedTsConfigPaths = null;
    tsConfigReadAttempted = false;
}


/** Tries to resolve a module path, supporting tsconfig paths and manual TS/TSX checks. */
function resolveModulePath(
    sourceModule: string,
    importerPath: string,
    workspacePath: string
): { resolvedPath?: string; error?: string } {

    const allowedExts = ['.ts', '.tsx', '.js', '.jsx']; // Extensions we check

    // --- 1. Handle Relative Paths ---
    if (sourceModule.startsWith('.')) {
        const importerDir = path.dirname(importerPath);
        let resolvedViaNode: string | undefined;
        let nodeResolutionError: string | undefined;

        // Try Node's require.resolve first
        try {
            resolvedViaNode = require.resolve(sourceModule, { paths: [importerDir] });
            // Check if Node resolved to one of our allowed extensions
            if (allowedExts.includes(path.extname(resolvedViaNode))) {
                 if (resolvedViaNode.includes('node_modules')) {
                     return { error: "require.resolve led to node_modules" };
                 }
                 log(`Resolved relative path '${sourceModule}' via require.resolve to '${relativePath(resolvedViaNode, workspacePath)}'`);
                 return { resolvedPath: nodeFs.realpathSync(path.normalize(resolvedViaNode)) };
            }
            // If require.resolve found something else (e.g., .node), ignore it for now and try manual check below.
            nodeResolutionError = `require.resolve found unsupported file type: ${path.extname(resolvedViaNode)}`;
            log(nodeResolutionError); // Log this info

        } catch (e: any) {
            // require.resolve failed, this is expected if it's a .ts/.tsx file usually
            nodeResolutionError = e.message; // Store the error message
        }

        // Manual Check Fallback for relative paths (if require.resolve failed or gave wrong type)
        const candidateAbsolutePath = path.resolve(importerDir, sourceModule);
        let foundManualPath: string | undefined = undefined;

        for (const ext of allowedExts) { // Check direct file.ext
            const filePath = candidateAbsolutePath + ext;
            if (nodeFs.existsSync(filePath) && nodeFs.statSync(filePath).isFile()) {
                foundManualPath = filePath;
                break;
            }
        }
        if (!foundManualPath && nodeFs.existsSync(candidateAbsolutePath) && nodeFs.statSync(candidateAbsolutePath).isDirectory()) { // Check directory/index.ext
            for (const ext of allowedExts) {
                const filePath = path.join(candidateAbsolutePath, 'index' + ext);
                if (nodeFs.existsSync(filePath) && nodeFs.statSync(filePath).isFile()) {
                    foundManualPath = filePath;
                    break;
                }
            }
        }

        if (foundManualPath) {
            if (foundManualPath.includes('node_modules')) {
                return { error: "Manual check resolved to node_modules" };
            }
            log(`Resolved relative path '${sourceModule}' to '${relativePath(foundManualPath, workspacePath)}' via manual check`);
            return { resolvedPath: nodeFs.realpathSync(path.normalize(foundManualPath)) };
        }

        // If both require.resolve and manual check failed
        return { error: `Relative path resolution failed: Cannot find file or index for '${sourceModule}'. require.resolve error: ${nodeResolutionError}` };
    }
    // --- END Relative Path Handling ---


    // --- 2. Handle Non-Relative Paths (Aliases / External) ---
    const tsConfig = getTsConfigOptions(workspacePath);

    if (tsConfig && tsConfig.paths) {
        // Attempt to resolve using tsconfig paths
        let longestMatch: string | undefined = undefined;
        for (const key in tsConfig.paths) {
            if (key.endsWith('*')) {
                const prefix = key.slice(0, -1);
                if (sourceModule.startsWith(prefix)) {
                    if (longestMatch === undefined || prefix.length > longestMatch.length) {
                        longestMatch = key;
                    }
                }
            } else if (sourceModule === key) {
                 longestMatch = key;
                 break;
            }
        }

        if (longestMatch) {
             const remainingPath = longestMatch.endsWith('*') ? sourceModule.substring(longestMatch.slice(0,-1).length) : '';
             const potentialTargets = tsConfig.paths[longestMatch];

            for (const targetPattern of potentialTargets) {
                 const targetPath = targetPattern.endsWith('*')
                    ? targetPattern.slice(0, -1) + remainingPath
                    : targetPattern;

                const candidateAbsolutePath = path.resolve(tsConfig.baseUrl, targetPath);
                let foundAliasPath: string | undefined = undefined;

                 // Check direct file match
                for (const ext of allowedExts) {
                    const filePath = candidateAbsolutePath + ext;
                    if (nodeFs.existsSync(filePath) && nodeFs.statSync(filePath).isFile()) {
                        foundAliasPath = filePath;
                        break;
                    }
                }
                 // Check for index file in directory
                 if (!foundAliasPath && nodeFs.existsSync(candidateAbsolutePath) && nodeFs.statSync(candidateAbsolutePath).isDirectory()) {
                     for (const ext of allowedExts) {
                         const filePath = path.join(candidateAbsolutePath, 'index' + ext);
                         if (nodeFs.existsSync(filePath) && nodeFs.statSync(filePath).isFile()) {
                             foundAliasPath = filePath;
                             break;
                         }
                     }
                 }
                 // Check candidate itself (less common)
                 if (!foundAliasPath && nodeFs.existsSync(candidateAbsolutePath) && nodeFs.statSync(candidateAbsolutePath).isFile()) {
                     foundAliasPath = candidateAbsolutePath;
                 }


                if (foundAliasPath) {
                    if (foundAliasPath.includes('node_modules')) {
                         continue;
                    }
                    log(`Resolved alias '${sourceModule}' to '${relativePath(foundAliasPath, workspacePath)}' via tsconfig`);
                    return { resolvedPath: nodeFs.realpathSync(path.normalize(foundAliasPath)) };
                }
            }
             // If loop finishes without finding a path from tsconfig aliases
             return { error: `Alias resolution failed: Path mapping for '${sourceModule}' did not lead to an existing file.` };
        }
    }
    // --- END Alias Handling ---

    // --- 3. Assume External ---
    return { error: "Module is not relative and not resolved via tsconfig paths (likely external or unresolved alias)." };
}


/** Analyzes parsed data to find usage, unused items, and missing imports. */
function analyzeDependencies(
    allExports: ExportInfo[],
    allImports: ImportInfo[],
    allInterfaces: InterfaceInfo[],
    allPotentialUsage: { name: string; usage: UsageInfo }[],
    routes: RouteInfo[],
    workspacePath: string
): AnalysisResult {
    const analysisStartTime = Date.now();
    log("Starting dependency analysis...");

    clearTsConfigCache(); // Ensure fresh config check

    // 1. Index Exports
    const exportsMap = new Map<string, ExportInfo & { usedIn: UsageInfo[] }>();
    allExports.forEach(exp => {
        const uniqueKey = `${path.normalize(exp.filePath)}|${exp.name}|${exp.isDefault}`;
        exportsMap.set(uniqueKey, { ...exp, usedIn: [] });
    });
    const exportsByFile = new Map<string, ExportInfo[]>();
    allExports.forEach(exp => {
        const normPath = path.normalize(exp.filePath);
        if (!exportsByFile.has(normPath)) {
            exportsByFile.set(normPath, []);
        }
        exportsByFile.get(normPath)!.push(exp);
    });

    // 2. Index Interfaces
    const interfacesMap = new Map<string, InterfaceInfo & { usedIn: UsageInfo[] }>();
    allInterfaces.forEach(intf => {
        if (!interfacesMap.has(intf.name)) {
            interfacesMap.set(intf.name, { ...intf, usedIn: [] });
        }
    });

    const missingImports: MissingImportInfo[] = [];
    const analysisErrors: string[] = [];

    // 3. Process Imports
    log(`Analyzing ${allImports.length} imports...`);
    allImports.forEach(imp => {
        const importerPath = path.normalize(imp.sourcePath);
        const resolution = resolveModulePath(imp.sourceModule, importerPath, workspacePath);

        if (resolution.resolvedPath) {
            const resolvedNormPath = resolution.resolvedPath;
            const targetExports = exportsByFile.get(resolvedNormPath);

            if (targetExports) {
                imp.importedNames.forEach(importedName => {
                    let foundExport = false;
                    for (const exp of targetExports) {
                         const uniqueKey = `${resolvedNormPath}|${exp.name}|${exp.isDefault}`;
                        const exportEntry = exportsMap.get(uniqueKey);
                        if (!exportEntry) {continue;}

                        if (!exp.isDefault && exp.name === importedName) {
                            exportEntry.usedIn.push({ filePath: imp.sourcePath, line: imp.line });
                            foundExport = true;
                            break;
                        } else if (exp.isDefault) {
                             if (exp.localName && exp.localName === importedName) {
                                 exportEntry.usedIn.push({ filePath: imp.sourcePath, line: imp.line });
                                 foundExport = true;
                                 break;
                             }
                             if (!exp.localName) {
                                exportEntry.usedIn.push({ filePath: imp.sourcePath, line: imp.line });
                                foundExport = true;
                                break;
                             }
                        }
                    }

                    if (!foundExport) {
                        missingImports.push({
                            importingFilePath: imp.sourcePath,
                            importingLine: imp.line,
                            missingName: importedName,
                            targetModule: imp.sourceModule,
                            resolvedTargetPath: resolvedNormPath,
                            resolutionError: "Export not found in target module"
                        });
                    }
                });
            } else {
                 imp.importedNames.forEach(importedName => {
                    missingImports.push({
                        importingFilePath: imp.sourcePath,
                        importingLine: imp.line,
                        missingName: importedName,
                        targetModule: imp.sourceModule,
                        resolvedTargetPath: resolvedNormPath,
                        resolutionError: "Target file resolved but no exports were parsed/found."
                    });
                 });
            }
        } else if (resolution.error && !resolution.error.includes("(likely external")) {
            imp.importedNames.forEach(importedName => {
                 missingImports.push({
                     importingFilePath: imp.sourcePath,
                     importingLine: imp.line,
                     missingName: importedName,
                     targetModule: imp.sourceModule,
                     resolutionError: resolution.error
                 });
            });
            const errorMsg = `Module resolution failed for '${imp.sourceModule}' in ${relativePath(importerPath, workspacePath)}: ${resolution.error}`;
            if (!analysisErrors.some(e => e.includes(imp.sourceModule))) {
                analysisErrors.push(errorMsg);
            }
        }
    });

    // 4. Determine Used vs. Unused Exports
    const usedExportsMap = new Map<string, ExportInfo & { usedIn: UsageInfo[] }>();
    const unusedExportsList: ExportInfo[] = [];
    exportsMap.forEach((expInfo, key) => {
        if (expInfo.usedIn.length > 0) {
            usedExportsMap.set(key, expInfo);
        } else {
            unusedExportsList.push(expInfo);
        }
    });

    // 5. Aggregate Interface Usage
    log(`Analyzing ${allPotentialUsage.length} potential interface usages...`);
    allPotentialUsage.forEach(potentialUse => {
        if (interfacesMap.has(potentialUse.name)) {
            interfacesMap.get(potentialUse.name)!.usedIn.push(potentialUse.usage);
        }
    });

    log(`Dependency analysis finished in ${Date.now() - analysisStartTime}ms.`);
    log(`Found ${usedExportsMap.size} used exports, ${unusedExportsList.length} unused exports, ${missingImports.length} missing imports.`);

    return {
        usedExports: usedExportsMap,
        unusedExports: unusedExportsList,
        missingImports: missingImports,
        interfaces: interfacesMap,
        routes: routes,
        errors: analysisErrors,
    };
}

// --- Markdown Generation ---
// ... (Keep all generate...Markdown functions exactly as they were) ...
function generateUsedExportsMarkdown(analysisResult: AnalysisResult, workspacePath: string): string {
    let md = '# ✅ Used Exports\n\n';
    if (analysisResult.usedExports.size === 0) {
        md += 'No used exports found (or none tracked).\n';
        return md;
    }

    const sortedUsedExports = Array.from(analysisResult.usedExports.values()).sort((a, b) =>
        a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name)
    );

    let currentFile = '';
    sortedUsedExports.forEach(exp => {
        const relFilePath = relativePath(exp.filePath, workspacePath);
        if (exp.filePath !== currentFile) {
            md += `## File: \`${relFilePath}\`\n`;
            currentFile = exp.filePath;
        }
        const exportName = exp.isDefault ? `${exp.name} (default${exp.localName ? `: ${exp.localName}`: ''})` : exp.name;
        md += `### Export: \`${exportName}\` (Line ${exp.line})\n`;
        exp.usedIn.forEach(usage => {
            md += `- Used in: \`${relativePath(usage.filePath, workspacePath)}\` (Line ${usage.line})\n`;
        });
        md += '\n';
    });
    return md;
}

function generateUnusedExportsMarkdown(analysisResult: AnalysisResult, workspacePath: string): string {
    let md = '# ❓ Unused Exports\n\n';
    if (analysisResult.unusedExports.length === 0) {
        md += 'No potentially unused exports found within the analyzed scope.\n';
        return md;
    }

    const sortedUnused = analysisResult.unusedExports.sort((a, b) =>
        a.filePath.localeCompare(b.filePath) || a.line - b.line
    );

    sortedUnused.forEach(exp => {
        const relFilePath = relativePath(exp.filePath, workspacePath);
         const exportName = exp.isDefault ? `${exp.name} (default${exp.localName ? `: ${exp.localName}`: ''})` : exp.name;
        md += `- \`${relFilePath}\` (Line ${exp.line}) → \`${exportName}\`\n`;
    });
    md += "\n*Note: This list includes exports not found in static imports within the project. They might be used dynamically, implicitly (e.g., Next.js page props), by external projects, or are genuinely unused.*\n";
    return md;
}

function generateMissingImportsMarkdown(analysisResult: AnalysisResult, workspacePath: string): string {
    let md = '# ❌ Missing Imports\n\n';
    if (analysisResult.missingImports.length === 0) {
        md += 'No imports found that seem to be missing or unresolved.\n';
        return md;
    }

    const sortedMissing = analysisResult.missingImports.sort((a, b) =>
        a.importingFilePath.localeCompare(b.importingFilePath) || a.importingLine - b.importingLine
    );

    sortedMissing.forEach(mis => {
        const relFilePath = relativePath(mis.importingFilePath, workspacePath);
        md += `- File: \`${relFilePath}\` (Line ${mis.importingLine})\n`;
        md += `  - Tries to import: \`${mis.missingName}\`\n`;
        md += `  - From module: \`${mis.targetModule}\`\n`;
        if (mis.resolvedTargetPath) {
             const errorText = mis.resolutionError || 'Export not found in this file';
             md += `  - Resolved Target: \`${relativePath(mis.resolvedTargetPath, workspacePath)}\` (${errorText})\n`;
        } else {
            md += `  - Resolution Error: ${mis.resolutionError || 'Could not resolve module path'}\n`;
        }
        md += '\n';
    });
    md += "\n*Note: This indicates imports where the specified name couldn't be found in the target module's exports, or the module itself couldn't be resolved within the workspace. This could be due to typos, incorrect paths, missing exports, or path alias configurations.*\n";
    return md;
}

function generateInterfacesMarkdown(analysisResult: AnalysisResult, workspacePath: string): string {
    let md = '# 📐 Interface Usage\n\n';
    if (analysisResult.interfaces.size === 0) {
        md += 'No interface declarations found.\n';
        return md;
    }

    const sortedInterfaces = Array.from(analysisResult.interfaces.values()).sort((a, b) => a.name.localeCompare(b.name));

    sortedInterfaces.forEach(intf => {
        const relFilePath = relativePath(intf.filePath, workspacePath);
        md += `## ${intf.name}\n`;
        md += `- Declared in: \`${relFilePath}\` (Line ${intf.line})\n`;
        if (intf.usedIn.length > 0) {
            const sortedUsage = intf.usedIn.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
            sortedUsage.forEach(usage => {
                md += `- Used in: \`${relativePath(usage.filePath, workspacePath)}\` (Line ${usage.line})\n`;
            });
        } else {
            md += `- *No usage found based on simple type reference matching within the project.*\n`;
        }
        md += '\n';
    });
     md += "\n*Note: Usage detection is based on finding type references matching the interface name. It might miss complex type manipulations or include matches for identically named types from external sources.*\n";
    return md;
}

function generateRoutesMarkdown(analysisResult: AnalysisResult): string {
    let md = '# 🧭 Route Structure (App Router)\n\n';
    if (analysisResult.routes.length === 0) {
        md += 'No App Router routes (`app/page.*` or `app/route.*`) found.\n';
        return md;
    }

    const pages = analysisResult.routes.filter(r => !r.isApi);
    const apiRoutes = analysisResult.routes.filter(r => r.isApi);

    if (pages.length > 0) {
        md += '## Pages (`page.*`)\n';
        pages.forEach(route => {
            md += `- \`${route.routePath}\` → \`${route.filePath}\`\n`;
        });
        md += '\n';
    }

    if (apiRoutes.length > 0) {
        md += '## API Routes (`route.*`)\n';
        apiRoutes.forEach(route => {
            md += `- \`${route.routePath}\` → \`${route.filePath}\`\n`;
        });
        md += '\n';
    }
     md += "\n*Note: Route paths are derived from the directory structure within `app/` or `src/app/`, ignoring route groups `(...)`.*\n";
    return md;
}


// --- Main Service Function ---
// ... (Keep updateDependencyReports exactly as it was) ...
let isRunning = false;

/** Performs the full analysis and updates report files. */
export async function updateDependencyReports(workspacePath: string) {
    if (isRunning) {
        log("Analysis is already in progress. Skipping trigger.");
        return;
    }
    isRunning = true;
    log("Starting full dependency analysis cycle...");
    const startTime = Date.now();

    try {
        const outputDir = await ensureOutputDir(workspacePath);
        if (!outputDir) {return;} // Error logged by ensureOutputDir

        // 1. Find Files
        const { files, error: findError } = await findProjectFiles();
        if (findError) {
            logError(`File finding failed: ${findError}. Analysis might be incomplete.`);
            if (files.length === 0) {
                 vscode.window.showErrorMessage(`Dependency Tracker: Could not find project files. ${findError}`);
                 return;
            }
        }
        if (files.length === 0) {
            log("No relevant source files found. Skipping analysis.");
            return;
        }

        // 2. Parse Files
        const { allExports, allImports, allInterfaces, allPotentialUsage, routes, parseErrors } = parseProject(files, workspacePath);

        // 3. Analyze Dependencies (Now uses improved resolution)
        const analysisResult = analyzeDependencies(allExports, allImports, allInterfaces, allPotentialUsage, routes, workspacePath);
        analysisResult.errors.push(...parseErrors); // Combine parsing errors with analysis errors

        if (analysisResult.errors.length > 0) {
            logError(`Encountered ${analysisResult.errors.length} errors/warnings during analysis. Check logs for details. Results may be incomplete.`);
        }

        // 4. Generate Markdown Reports
        log("Generating Markdown reports...");
        const usedExportsMd = generateUsedExportsMarkdown(analysisResult, workspacePath);
        const unusedExportsMd = generateUnusedExportsMarkdown(analysisResult, workspacePath);
        const missingImportsMd = generateMissingImportsMarkdown(analysisResult, workspacePath);
        const interfacesMd = generateInterfacesMarkdown(analysisResult, workspacePath);
        const routesMd = generateRoutesMarkdown(analysisResult);

        // 5. Write Reports to Files
        log(`Writing reports to ${relativePath(outputDir, workspacePath)}/...`);
        await fs.writeFile(path.join(outputDir, 'used_exports.md'), usedExportsMd);
        await fs.writeFile(path.join(outputDir, 'unused_exports.md'), unusedExportsMd);
        await fs.writeFile(path.join(outputDir, 'missing_imports.md'), missingImportsMd);
        await fs.writeFile(path.join(outputDir, 'interfaces.md'), interfacesMd);
        await fs.writeFile(path.join(outputDir, 'routes.md'), routesMd);

        const duration = (Date.now() - startTime) / 1000;
        log(`Dependency analysis complete in ${duration.toFixed(2)}s.`);

    } catch (error) {
        logError("An unexpected error occurred during the dependency analysis cycle", error);
        vscode.window.showErrorMessage("Dependency Tracker: An unexpected error occurred. Check Output panel (Next.js Dependency Tracker).");
    } finally {
        isRunning = false;
    }
}