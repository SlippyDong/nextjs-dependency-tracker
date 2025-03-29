// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { updateDependencyReports } from './dependencyService';
import { log, logError, debounce, getConfig, getWorkspacePath, getOutputChannel } from './utils'; // Removed relativePath, not used here

let pollingInterval: NodeJS.Timeout | null = null;
let debouncedUpdate: (() => void) | null = null;
let isInitialScanComplete = false; // Flag to control save listener activation
let saveListenerDisposable: vscode.Disposable | null = null;

/** Main activation function */
export function activate(context: vscode.ExtensionContext) {
    log('Extension "nextjs-dependency-tracker" activating...');
    const outputChannel = getOutputChannel();
    // outputChannel.show(true); // Decide if you want to force-show the channel

    // --- Register Command ---
    let disposableCommand = vscode.commands.registerCommand('next-dependency-tracker.updateDependencies', async () => {
        log("Manual update/scan command triggered.");
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Dependency Tracker: Scanning project...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "Starting analysis..." });
            try {
                await updateDependencyReports(workspacePath);
                progress.report({ increment: 100, message: "Analysis complete." });
                log("Scan complete. Enabling save listener.");
                isInitialScanComplete = true; // Enable save listener AFTER successful scan
                setupSaveListener(context); // Ensure listener is registered/updated
            } catch (error) {
                 logError("Error during scan command execution", error);
                 progress.report({ increment: 100, message: "Analysis failed." });
            }
        });
    });
    context.subscriptions.push(disposableCommand);

    // --- Debounced Update Function ---
    const setupDebouncer = () => {
        // ... (keep setupDebouncer function as is)
        const delay = getConfig<number>('debounceDelayMs') ?? 2000;
        log(`Setting up debouncer with delay: ${delay}ms`);
        debouncedUpdate = debounce(async () => {
            const workspacePath = getWorkspacePath();
             if (!workspacePath) {return;}
             log(`Debounced save trigger executing update...`);
             await updateDependencyReports(workspacePath);
        }, delay);
    };
    setupDebouncer();

    // --- File Save Listener Setup ---
    setupSaveListener(context);


    // --- Polling Trigger Setup ---
    const setupPolling = () => {
        // ... (keep setupPolling function as is)
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
        const enablePolling = getConfig<boolean>('enablePolling');
        if (enablePolling) {
            const intervalSeconds = getConfig<number>('pollingIntervalSeconds') ?? 60;
            const intervalMs = Math.max(10000, intervalSeconds * 1000);
            log(`Setting up polling every ${intervalMs / 1000} seconds.`);
            pollingInterval = setInterval(async () => {
                 const workspacePath = getWorkspacePath();
                 if (!workspacePath) {return;}
                 log("Polling interval triggered update.");
                 await updateDependencyReports(workspacePath);
            }, intervalMs);
             context.subscriptions.push({ dispose: () => {
                 if(pollingInterval) {clearInterval(pollingInterval);}
                 log("Polling interval cleared.");
             }});
        } else {
            log("Polling is disabled.");
        }
    };
    setupPolling();

    // --- Configuration Change Listener ---
    let disposableConfigChange = vscode.workspace.onDidChangeConfiguration(event => {
        // ... (keep onDidChangeConfiguration listener as is)
        let needsDebounceRestart = false;
        let needsPollingRestart = false;
        if (event.affectsConfiguration('nextjs-dependency-tracker.debounceDelayMs')) {
            log("Debounce delay configuration changed.");
            needsDebounceRestart = true;
        }
        if (event.affectsConfiguration('nextjs-dependency-tracker.enablePolling') ||
            event.affectsConfiguration('nextjs-dependency-tracker.pollingIntervalSeconds')) {
            log("Polling configuration changed.");
            needsPollingRestart = true;
        }
         if (event.affectsConfiguration('nextjs-dependency-tracker.excludedFolders')) {
             log("Excluded folders configuration changed. Manual scan recommended to apply changes.");
         }
        if (needsDebounceRestart) {setupDebouncer();}
        if (needsPollingRestart) {setupPolling();}
    });
    context.subscriptions.push(disposableConfigChange);

    log('Extension "nextjs-dependency-tracker" activated.');

    // --- Show Startup Notification with Buttons ---
    vscode.window.showInformationMessage(
        "Dependency Tracker: Ready. Generate initial dependency reports?", // Updated message
        'Scan Now', // Button 1 title
        'Skip'      // Button 2 title
    ).then(selection => {
        // This block executes after the user clicks a button or dismisses the notification
        if (selection === 'Scan Now') {
            log("User clicked 'Scan Now' on activation notification.");
            // Execute the command that performs the scan and shows progress
            vscode.commands.executeCommand('next-dependency-tracker.updateDependencies');
        } else {
            // User clicked 'Skip' or dismissed the notification
            log("User skipped initial scan via activation notification. Run command manually later.");
        }
    });
}


/** Sets up or replaces the file save listener. */
function setupSaveListener(context: vscode.ExtensionContext) {
     // ... (keep setupSaveListener function as is)
     if (saveListenerDisposable) {
         saveListenerDisposable.dispose();
         log("Disposed existing save listener.");
     }
     saveListenerDisposable = vscode.workspace.onDidSaveTextDocument(document => {
        if (!isInitialScanComplete) {
            return;
        }
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {return;}
        const langId = document.languageId;
        const relevantLangIds = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'];
        const normPath = path.normalize(document.uri.fsPath);

        if (relevantLangIds.includes(langId) && normPath.startsWith(workspacePath)) {
            const excluded = getConfig<string[]>('excludedFolders') ?? [];
            const relativeDocPath = path.relative(workspacePath, normPath);
            const isInExcluded = excluded.some(folder => relativeDocPath.startsWith(folder + path.sep) || relativeDocPath === folder);

            if (!isInExcluded && debouncedUpdate) {
                 log(`Relevant file saved: ${relativeDocPath}. Triggering debounced update...`);
                 debouncedUpdate();
            }
        }
    });
     context.subscriptions.push(saveListenerDisposable);
     log("Save listener registered/updated.");
}


/** Deactivation function */
export function deactivate() {
    // ... (keep deactivate function as is)
    log('Extension "nextjs-dependency-tracker" deactivating...');
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
     if (saveListenerDisposable) {
         saveListenerDisposable.dispose();
     }
    log('Extension "nextjs-dependency-tracker" deactivated.');
}