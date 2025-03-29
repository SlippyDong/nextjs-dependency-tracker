// src/fileFinder.ts
import * as vscode from 'vscode';
import { log, logError, getConfig, getWorkspacePath } from './utils';
import { FileFinderResult } from './types';
import * as path from 'path';
import * as fs from 'fs';

const RELEVANT_EXTENSIONS = '{ts,tsx,js,jsx}';
const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_FILES = 10000;

/** Finds relevant project files using VS Code's findFiles API. */
export async function findProjectFiles(): Promise<FileFinderResult> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return { files: [], error: "Workspace path not found." };
    }

    log(`Finding project files using VS Code API in workspace: ${workspacePath}`);

    // Retrieve user/default configuration for excluded folders
    const excludedFoldersSetting = getConfig<string[]>('excludedFolders') ?? [];

    // Base excludes that should always apply regardless of user settings
    const baseExcludes = ['.git', 'node_modules', '.next', '.dependencies', 'dist', 'out', '.vscode'];

    // Combine the user/default settings with essential base excludes
    const combinedExcludes = [...new Set([...baseExcludes, ...excludedFoldersSetting])];
    // log(`Using combined exclusions: ${JSON.stringify(combinedExcludes)}`); // Optional: Keep for less verbose debug

    // Generate the exclude pattern for vscode.workspace.findFiles
    // Example: {**/node_modules/**,**/.git/**,**/.vibesync/**}
    const excludeFoldersPattern = combinedExcludes.map(folder => `**/${folder}/**`).join(',');
    const excludePattern = `{${excludeFoldersPattern}}`;
    const includePattern = `**/*.${RELEVANT_EXTENSIONS}`;

    // log(`Include pattern: ${includePattern}`); // Optional: Keep for less verbose debug
    // log(`Exclude pattern: ${excludePattern}`); // Optional: Keep for less verbose debug

    try {
        const findStartTime = Date.now();
        // Use VS Code's API to find files matching include pattern, excluding the generated exclude pattern
        const filesUri = await vscode.workspace.findFiles(includePattern, excludePattern);
        const findEndTime = Date.now();

        // Normalize paths and ensure they are within the workspace
        const files = filesUri.map(uri => path.normalize(uri.fsPath));
        const workspaceFiles = files.filter(f => f.startsWith(workspacePath));

        log(`VS Code findFiles found ${workspaceFiles.length} potentially relevant files in ${findEndTime - findStartTime}ms.`);

        if (workspaceFiles.length !== files.length) {
            log(`Filtered out ${files.length - workspaceFiles.length} files initially found outside the primary workspace folder.`);
        }

        // Explicit Post-Filtering (Keep as a safety measure in case glob pattern misses something)
        const explicitlyFilteredFiles = workspaceFiles.filter(f => {
            const relativeFilePath = path.relative(workspacePath, f);
            // Check if the relative path starts with any of the excluded folder names + path separator
            const isExcluded = combinedExcludes.some(excludedFolder =>
                relativeFilePath.startsWith(excludedFolder + path.sep) || relativeFilePath === excludedFolder
            );
            // If you need to debug exclusions, uncomment the log below:
            // if (isExcluded) {
            //     log(`FILTER DEBUG: Excluding file because relative path '${relativeFilePath}' starts with excluded folder '${excludedFolder}'`);
            // }
            return !isExcluded; // Keep if it's NOT excluded
        });

        if (explicitlyFilteredFiles.length !== workspaceFiles.length) {
            log(`Explicitly filtered out ${workspaceFiles.length - explicitlyFilteredFiles.length} additional files matching excluded folder names.`);
        }

        return { files: explicitlyFilteredFiles }; // Return the final, filtered list

    } catch (error) {
        const errMsg = `Error using VS Code findFiles: ${error instanceof Error ? error.message : String(error)}`;
        logError(errMsg, error);
        return { files: [], error: errMsg };
    }
}

export async function findProjectFilesWithRetry(): Promise<FileFinderResult> {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const result = await findProjectFiles();
            
            // Apply resource limits
            if (result.files.length > MAX_FILES) {
                return {
                    files: [],
                    error: `Too many files found (${result.files.length}). Maximum is ${MAX_FILES}.`
                };
            }

            // Check file sizes
            const oversizedFiles = await Promise.all(
                result.files.map(async file => {
                    const stats = await fs.promises.stat(file);
                    return stats.size > MAX_FILE_SIZE ? file : null;
                })
            );

            const largeFiles = oversizedFiles.filter((f): f is string => f !== null);
            if (largeFiles.length > 0) {
                return {
                    files: [],
                    error: `Files exceeding size limit (${MAX_FILE_SIZE} bytes): ${largeFiles.join(', ')}`
                };
            }

            return result;
        } catch (error) {
            if (i === maxRetries - 1) {throw error;}
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    throw new Error('Unexpected error in retry logic');
}