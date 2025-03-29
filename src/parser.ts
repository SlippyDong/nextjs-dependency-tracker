// src/parser.ts
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { ExportInfo, ImportInfo, InterfaceInfo, RouteInfo, UsageInfo } from './types';
import { log, logError, relativePath, getWorkspacePath } from './utils';

interface ParseFileResult {
    exports: ExportInfo[];
    imports: ImportInfo[];
    interfaces: InterfaceInfo[];
    potentialInterfaceUsage: { name: string; usage: UsageInfo }[]; // Simple identifier usage
}

function getLineAndCharacter(sourceFile: ts.SourceFile, pos: number): { line: number; character: number } {
    return sourceFile.getLineAndCharacterOfPosition(pos);
}

/** Parses a single TypeScript/JavaScript file using the TS Compiler API. */
function parseFile(filePath: string, program: ts.Program): ParseFileResult | null {
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) {
        logError(`Could not get source file via program: ${relativePath(filePath, getWorkspacePath())}`);
        // Fallback: try reading and parsing directly (less accurate type info)
        try {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const fallbackSourceFile = ts.createSourceFile(filePath, fileContent, ts.ScriptTarget.Latest, true);
            if (fallbackSourceFile) {
                log(`Using fallback parser for ${relativePath(filePath, getWorkspacePath())}`);
                return visitNodes(fallbackSourceFile, filePath);
            } else {
                 logError(`Fallback parser also failed for ${relativePath(filePath, getWorkspacePath())}`);
                 return null;
            }
        } catch (readError) {
            logError(`Failed to read file for fallback parser: ${relativePath(filePath, getWorkspacePath())}`, readError);
            return null;
        }
    }

    return visitNodes(sourceFile, filePath);
}


/** Extracts information by visiting AST nodes. */
function visitNodes(sourceFile: ts.SourceFile, filePath: string): ParseFileResult {
    const exports: ExportInfo[] = [];
    const imports: ImportInfo[] = [];
    const interfaces: InterfaceInfo[] = [];
    const potentialInterfaceUsage: { name: string; usage: UsageInfo }[] = [];

    function visit(node: ts.Node) {
        const posDetails = getLineAndCharacter(sourceFile, node.getStart(sourceFile));
        const line = posDetails.line + 1;

        // --- Extract Exports ---
        // Use type guards before accessing specific properties like 'modifiers'
        if (ts.isExportDeclaration(node)) {
            // Handles: export { name1, name2 } [from './module']; export * from './module';
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
                node.exportClause.elements.forEach(specifier => {
                    const name = specifier.name.getText(sourceFile);
                    const localName = specifier.propertyName?.getText(sourceFile) || name;
                    exports.push({ name, localName, filePath, line, isDefault: false });
                });
            } // export * is implicitly handled by analyzing the target module if needed
        }
        else if (ts.isExportAssignment(node) && !node.isExportEquals) {
            // Handles: export default ...;
            let name = 'default';
            let localName : string | undefined = undefined;
             if (ts.isIdentifier(node.expression)) {
                 localName = node.expression.getText(sourceFile);
             }
            exports.push({ name, localName, filePath, line, isDefault: true });
        }
        // Check for modifiers using .some() without explicit type annotation for 'mod'
        else if (ts.isVariableStatement(node) && node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) { // FIX 1: Removed ': ts.Modifier'
            // Handles: export const x = ...;
            // Note: 'export default const x = ...' is invalid syntax. Default handled by ExportAssignment or function/class declaration.
             const isDefault = node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.DefaultKeyword); // FIX 2: Removed ': ts.Modifier'
             node.declarationList.declarations.forEach(declaration => {
                if (ts.isIdentifier(declaration.name)) {
                    const name = declaration.name.getText(sourceFile);
                    const declLine = getLineAndCharacter(sourceFile, declaration.name.getStart(sourceFile)).line + 1;
                    // If somehow 'export default const' was valid, handle it, otherwise assume named export
                    exports.push({ name: isDefault ? 'default' : name, localName: name, filePath, line: declLine, isDefault: !!isDefault });
                } // Could handle object/array binding patterns if needed
            });
        }
        else if ( (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
                   node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) ) // FIX 3: Removed ': ts.Modifier'
        {
            // Handles: export function f() {}; export class C {}; export default function() {}; etc.
            const isDefault = node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.DefaultKeyword); // FIX 4: Removed ': ts.Modifier'
            let name = isDefault ? 'default' : (node.name?.getText(sourceFile) || '__anonymous__'); // Use actual name if not default, or 'default'
            let localName = node.name?.getText(sourceFile); // Capture the local name regardless

            // For default anonymous functions/classes, localName will be undefined
            if (isDefault && !localName) {
                 name = 'default';
            } else if (!isDefault && !localName) {
                name = '__anonymous__'; // Should be rare/invalid for named exports
            }

            const declLine = node.name ? getLineAndCharacter(sourceFile, node.name.getStart(sourceFile)).line + 1 : line;
            // Don't export interfaces etc. as 'default' if they have a name - TS doesn't allow `export default interface I {}`
            if(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
                 if (isDefault) { /* This is likely a syntax error */ }
                 else if (node.name) {
                     exports.push({ name: node.name.getText(sourceFile), localName: node.name.getText(sourceFile), filePath, line: declLine, isDefault: false });
                 }
            } else {
                 // Function or Class
                 exports.push({ name, localName, filePath, line: declLine, isDefault: !!isDefault });
            }
        }


        // --- Extract Imports ---
        if (ts.isImportDeclaration(node)) {
            const sourceModule = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
            let importedNames: string[] = [];
            const importLine = getLineAndCharacter(sourceFile, node.getStart(sourceFile)).line + 1;

            if (node.importClause) {
                // Default import: import DefaultName from 'module';
                if (node.importClause.name) {
                    importedNames.push(node.importClause.name.getText(sourceFile)); // This is the local name
                }
                // Named imports: import { Name1, Name2 as Alias } from 'module';
                if (node.importClause.namedBindings) {
                    if (ts.isNamespaceImport(node.importClause.namedBindings)) {
                        importedNames.push(node.importClause.namedBindings.name.getText(sourceFile)); // Local namespace name
                    } else if (ts.isNamedImports(node.importClause.namedBindings)) {
                        node.importClause.namedBindings.elements.forEach(element => {
                            importedNames.push(element.name.getText(sourceFile)); // This is the local name (could be alias)
                        });
                    }
                }
            }
            imports.push({ sourcePath: filePath, importedNames, sourceModule, line: importLine });
        }

        // --- Extract Interface Declarations ---
        if (ts.isInterfaceDeclaration(node)) {
            const name = node.name.getText(sourceFile);
            const declLine = getLineAndCharacter(sourceFile, node.name.getStart(sourceFile)).line + 1;
            interfaces.push({ name, filePath, line: declLine });
        }

        // --- Extract Potential Interface Usage (simple identifier check) ---
        // Primary check: Explicit type reference like `let x: MyInterface;`
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
            const name = node.typeName.getText(sourceFile);
            const usageLine = getLineAndCharacter(sourceFile, node.typeName.getStart(sourceFile)).line + 1;
             // Avoid duplicates if the same identifier node triggers multiple conditions (unlikely but possible)
            if (!potentialInterfaceUsage.some(p => p.name === name && p.usage.filePath === filePath && p.usage.line === usageLine)) {
                potentialInterfaceUsage.push({ name, usage: { filePath, line: usageLine } });
            }
        }
        // Secondary check: Identifiers in heritage clauses (`extends B`, `implements C`)
        else if (node.parent && ts.isExpressionWithTypeArguments(node.parent) && node.parent.expression === node && ts.isIdentifier(node)) {
             const name = node.getText(sourceFile);
             const usageLine = getLineAndCharacter(sourceFile, node.getStart(sourceFile)).line + 1;
             // Avoid double counting from TypeReferenceNode if the structure is similar enough
             if (!potentialInterfaceUsage.some(p => p.name === name && p.usage.filePath === filePath && p.usage.line === usageLine)) {
                 potentialInterfaceUsage.push({ name, usage: { filePath, line: usageLine } });
             }
         }


        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return { exports, imports, interfaces, potentialInterfaceUsage };
}


/** Parses route structure based on Next.js App Router conventions. */
function parseRoutes(files: string[], workspacePath: string): RouteInfo[] {
    log("Parsing route structure for App Router...");
    const routes: RouteInfo[] = [];
    const appDirNames = ['app', 'src/app']; // Potential locations for the app directory

    const appDirs = appDirNames
        .map(dir => path.join(workspacePath, dir))
        .filter(dirPath => fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory());

    if (appDirs.length === 0) {
        log("No 'app' or 'src/app' directory found. Skipping App Router route parsing.");
        return [];
    }

    // Typically there's only one, but use the first found if multiple exist (e.g. unlikely edge case)
    const appDir = appDirs[0];
    log(`Found App Router directory: ${relativePath(appDir, workspacePath)}`);

    files.forEach(filePath => {
        if (!filePath.startsWith(appDir + path.sep)) {return;} // Only process files within the found app dir

        const relativeToAppDir = path.relative(appDir, filePath);
        const parts = relativeToAppDir.split(path.sep);
        const fileName = parts.pop() || '';

        // Check for page or route files
        const isApi = fileName === 'route.ts' || fileName === 'route.js';
        const isPage = ['page.ts', 'page.tsx', 'page.js', 'page.jsx'].includes(fileName);

        if (!isApi && !isPage) {return;} // Not a route definition file

        // Construct the route path from directory structure
        let routePath = '/';
        routePath += parts
            .filter(part => !part.startsWith('(') || !part.endsWith(')')) // Ignore route groups like (marketing)
            // Filter out segments starting with '@' (interception routes) or '_' (private folders)
            .filter(part => !part.startsWith('@') && !part.startsWith('_'))
            .map(part => {
                // Handle dynamic segments: [slug], [...slug], [[...slug]]
                 if (part.startsWith('[') && part.endsWith(']')) {
                     return part;
                 }
                return part; // Static segment
            })
            .join('/');

         // Normalize path separators and remove trailing slash if not root
        routePath = routePath.replace(/\\/g, '/');
        if (routePath !== '/' && routePath.endsWith('/')) {
             routePath = routePath.slice(0, -1);
        }
         // Ensure root path is just '/' if parts resulted in empty string
         if (routePath === '') {
             routePath = '/';
         }


        routes.push({
            routePath: routePath,
            filePath: relativePath(filePath, workspacePath), // Path relative to workspace root
            isApi: isApi,
        });
    });

    // Sort routes for readability
    routes.sort((a, b) => a.routePath.localeCompare(b.routePath));
    log(`Found ${routes.length} App Router routes.`);
    return routes;
}


/** Orchestrates parsing of all project files. */
export function parseProject(files: string[], workspacePath: string): {
    allExports: ExportInfo[],
    allImports: ImportInfo[],
    allInterfaces: InterfaceInfo[],
    allPotentialUsage: { name: string; usage: UsageInfo }[],
    routes: RouteInfo[],
    parseErrors: string[]
} {
    const allExports: ExportInfo[] = [];
    const allImports: ImportInfo[] = [];
    const allInterfaces: InterfaceInfo[] = [];
    const allPotentialUsage: { name: string; usage: UsageInfo }[] = [];
    const parseErrors: string[] = [];

    log(`Starting AST parsing for ${files.length} files...`);
    const parseStartTime = Date.now();

    // Create a single TypeScript program for better performance and type checking context
    const program = ts.createProgram(files, {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.CommonJS, // Adjust if project uses ESM primarily
        jsx: ts.JsxEmit.Preserve,
        allowJs: true,
        checkJs: false,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        noEmit: true,
        skipLibCheck: true,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
    });
    log(`TypeScript program created in ${Date.now() - parseStartTime}ms.`);


    files.forEach(file => {
        const relativeFilePath = relativePath(file, workspacePath);
        try {
            const result = parseFile(file, program); // Use the program
            if (result) {
                allExports.push(...result.exports);
                allImports.push(...result.imports);
                allInterfaces.push(...result.interfaces);
                allPotentialUsage.push(...result.potentialInterfaceUsage);
            }
        } catch (error) {
            const errMsg = `Failed to parse ${relativeFilePath}: ${error instanceof Error ? error.message : String(error)}`;
            logError(errMsg, error);
            parseErrors.push(`Parse Error: ${relativeFilePath} - ${error instanceof Error ? error.message : String(error)}`);
        }
    });
     log(`Finished AST parsing in ${Date.now() - parseStartTime}ms.`);

    // --- Parse Routes ---
    const routes = parseRoutes(files, workspacePath);

    return { allExports, allImports, allInterfaces, allPotentialUsage, routes, parseErrors };
}