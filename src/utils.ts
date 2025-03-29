// src/utils.ts
import * as vscode from 'vscode';
import * as path from 'path';

let outputChannel: vscode.OutputChannel | null = null;

/** Gets or creates the output channel for logging. */
export function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("Next.js Dependency Tracker");
    }
    return outputChannel;
}

/** Logs a message to the output channel. */
export function log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    getOutputChannel().appendLine(`[${timestamp}] ${message}`);
    console.log(`[Dependency Tracker] ${message}`); // Also log to debug console
}

/** Logs an error message and optionally an error object to the output channel. */
export function logError(message: string, error?: any) {
    const timestamp = new Date().toLocaleTimeString();
    getOutputChannel().appendLine(`[${timestamp}] [ERROR] ${message}`);
    console.error(`[Dependency Tracker] [ERROR] ${message}`);

    if (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        getOutputChannel().appendLine(`    ${errorMsg}`);
        console.error(`    ${errorMsg}`);
        if (error instanceof Error && error.stack) {
            // Log stack to output channel for detailed debugging if needed
             getOutputChannel().appendLine(`    Stack: ${error.stack}`);
        }
    }
}

/**
 * Creates a debounced function that delays invoking func until after wait milliseconds
 * have elapsed since the last time the debounced function was invoked.
 */
export function debounce<T extends (...args: any[]) => any>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout | null = null;
    return (...args: Parameters<T>) => {
        const later = () => {
            timeout = null;
            func(...args);
        };
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(later, wait);
    };
}

/** Gets the file system path of the first workspace folder. */
export function getWorkspacePath(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        // Normalize path to handle potential casing differences if necessary
        return path.normalize(workspaceFolders[0].uri.fsPath);
    }
    logError("No workspace folder found.");
    vscode.window.showWarningMessage("Dependency Tracker: Please open a folder or workspace to analyze.");
    return null;
}

/** Gets a configuration value from settings.json with type validation. */
export function getConfig<T>(key: string): T | undefined {
    const config = vscode.workspace.getConfiguration('nextjs-dependency-tracker');
    const shortKey = key.replace('nextjs-dependency-tracker.', '');
    const value = config.get<T>(shortKey);

    // Type validation based on key
    switch (shortKey) {
        case 'excludedFolders':
            if (value !== undefined && !Array.isArray(value)) {
                logError(`Configuration error: ${shortKey} must be an array`);
                return undefined;
            }
            break;
        case 'debounceDelayMs':
        case 'pollingIntervalSeconds':
            if (value !== undefined && typeof value !== 'number') {
                logError(`Configuration error: ${shortKey} must be a number`);
                return undefined;
            }
            break;
        case 'enablePolling':
            if (value !== undefined && typeof value !== 'boolean') {
                logError(`Configuration error: ${shortKey} must be a boolean`);
                return undefined;
            }
            break;
    }

    return value;
}

/** Sanitizes a path to prevent directory traversal attacks. */
export function sanitizePath(inputPath: string): string {
    // Normalize path and remove any attempts to traverse up
    const normalized = path.normalize(inputPath).replace(/^(\.\.[\/\\])+/, '');
    
    // Additional security: ensure path doesn't contain suspicious patterns
    if (normalized.includes('\0') || normalized.includes('..')) {
        throw new Error('Invalid path detected');
    }
    
    return normalized;
}

/** Converts an absolute path to a path relative to the workspace root. */
export function relativePath(absPath: string, workspacePath: string | null): string {
    if (!workspacePath) {
        return sanitizePath(absPath);
    }
    return path.relative(sanitizePath(workspacePath), sanitizePath(absPath))
        .replace(/\\/g, '/');
}