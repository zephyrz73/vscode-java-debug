// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as compareVersions from "compare-versions";
import * as _ from "lodash";
import * as path from "path";
import * as vscode from "vscode";
import { dispose as disposeTelemetryWrapper, initializeFromJsonFile, instrumentOperation,
    instrumentOperationAsVsCodeCommand, sendInfo, setUserError } from "vscode-extension-telemetry-wrapper";
import * as commands from "./commands";
import { JavaDebugConfigurationProvider, lastUsedLaunchConfig } from "./configurationProvider";
import { HCR_EVENT, JAVA_LANGID, TELEMETRY_EVENT, USER_NOTIFICATION_EVENT } from "./constants";
import { NotificationBar } from "./customWidget";
import { initializeCodeLensProvider, startDebugging } from "./debugCodeLensProvider";
import { initExpService } from "./experimentationService";
import { handleHotCodeReplaceCustomEvent, initializeHotCodeReplace, NO_BUTTON, YES_BUTTON } from "./hotCodeReplace";
import { JavaDebugAdapterDescriptorFactory } from "./javaDebugAdapterDescriptorFactory";
import { JavaInlineValuesProvider } from "./JavaInlineValueProvider";
import { logJavaException, logJavaInfo } from "./javaLogger";
import { IMainClassOption, IMainMethod, resolveMainMethod } from "./languageServerPlugin";
import { mainClassPicker  } from "./mainClassPicker";
import { pickJavaProcess } from "./processPicker";
import { IProgressReporter } from "./progressAPI";
import { progressProvider } from "./progressImpl";
import { JavaTerminalLinkProvder } from "./terminalLinkProvider";
import { initializeThreadOperations } from "./threadOperations";
import * as utility from "./utility";
import { registerVariableMenuCommands } from "./variableMenu";
import { promisify } from "util";
import { CANCELLED } from "dns";
import * as fs from 'fs';
import { writeFileSync } from 'fs';

export async function activate(context: vscode.ExtensionContext): Promise<any> {
    console.log("activate yeah!");

    await initializeFromJsonFile(context.asAbsolutePath("./package.json"), {
        firstParty: true,
    });
    await initExpService(context);
    return instrumentOperation("activation", initializeExtension)(context);
}

function initializeExtension(_operationId: string, context: vscode.ExtensionContext): any {
    registerDebugEventListener(context);
    registerVariableMenuCommands(context);
    context.subscriptions.push(vscode.window.registerTerminalLinkProvider(new JavaTerminalLinkProvder()));
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("java", new JavaDebugConfigurationProvider()));
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("java", new JavaDebugAdapterDescriptorFactory()));
    context.subscriptions.push(instrumentOperationAsVsCodeCommand("JavaDebug.SpecifyProgramArgs", async () => {
        return specifyProgramArguments(context);
    }));
    context.subscriptions.push(instrumentOperationAsVsCodeCommand("JavaDebug.PickJavaProcess", async () => {
        let javaProcess;
        try {
            javaProcess = await pickJavaProcess();
        } catch (error) {
            vscode.window.showErrorMessage(error.message ? error.message : String(error));
        }

        // tslint:disable-next-line
        return javaProcess ? String(javaProcess.pid) : "${command:PickJavaProcess}";
    }));
    const hcrStatusBar: NotificationBar = new NotificationBar("java.hcrStatusBar", "Java HotCodeReplace");
    context.subscriptions.push(hcrStatusBar);
    context.subscriptions.push(instrumentOperationAsVsCodeCommand("java.debug.hotCodeReplace", async () => {
        await applyHCR(hcrStatusBar);
    }));
    context.subscriptions.push(instrumentOperationAsVsCodeCommand("java.debug.runJavaFile", async (uri: vscode.Uri) => {
        await runJavaFile(uri, true);
    }));
    context.subscriptions.push(instrumentOperationAsVsCodeCommand("java.debug.debugJavaFile", async (uri: vscode.Uri) => {
        await runJavaFile(uri, false);
    }));
    context.subscriptions.push(instrumentOperationAsVsCodeCommand("java.debug.runFromProjectView", async (node: any) => {
        await runJavaProject(node, true);
    }));
    context.subscriptions.push(instrumentOperationAsVsCodeCommand("java.debug.debugFromProjectView", async (node: any) => {
        await runJavaProject(node, false);
    }));
    initializeHotCodeReplace(context);
    initializeCodeLensProvider(context);
    initializeThreadOperations(context);
    subscribeToJavaExtensionEvents();
    console.log("initialize yeah!");
    context.subscriptions.push(vscode.languages.registerInlineValuesProvider("java", new JavaInlineValuesProvider()));
    return {
        progressProvider,
    };
}

// this method is called when your extension is deactivated
export async function deactivate() {
    await disposeTelemetryWrapper();
}

const delay = promisify(setTimeout);
async function subscribeToJavaExtensionEvents(): Promise<void> {
    const javaExt = vscode.extensions.getExtension("redhat.java");
    if (!javaExt) {
       return;
    }

    // wait javaExt to activate
    const timeout = 30 * 60 * 1000; // wait 30 min at most
    let count = 0;
    while (!javaExt.isActive && count < timeout) {
       await delay(1000);
       count += 1000;
    }

    if (javaExt.isActive) {
        javaExt.exports?.onDidSourceInvalidate?.((event: any) => {
            if (event?.affectedRootPaths?.length) {
                const activeDebugSession = vscode.debug.activeDebugSession;
                if (activeDebugSession?.type === "java") {
                    activeDebugSession.customRequest("refreshFrames", {
                        affectedRootPaths: event.affectedRootPaths,
                    });
                }
            }
        });
    }
}

function registerDebugEventListener(context: vscode.ExtensionContext) {
    const measureKeys = ["duration"];
    let log: LogLine[] = [];
    interface LogLine {
        Type: string; // bp or regular
        LineNumber: number;
        variable: any;
        LineContent: string;
        StackTrace: any;
        CodeBlocks: any;
    }

    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((e) => {
        const jsonContent = JSON.stringify(log, null, 4); // Using 4 spaces for indentation

        // Save to a JSON file
        const filePath = 'log.json'; // Path where you want to save the JSON file
        writeFileSync('/Users/xuanhezhou/272/vscode-debugger/javaDebugger/vscode-java-debug/debugLogs/'+filePath, jsonContent, 'utf8'); // Write the file synchronously

        console.log(`File saved to ${filePath}`);

        if (e.type !== "java") {
            return;
        }
        fetchUsageData().then((ret) => {
    
            if (Array.isArray(ret) && ret.length) {
                ret.forEach((entry) => {
                    const commonProperties: any = {};
                    const measureProperties: any = {};
                    for (const key of Object.keys(entry)) {
                        if (measureKeys.indexOf(key) >= 0) {
                            measureProperties[key] = entry[key];
                        } else {
                            commonProperties[key] = String(entry[key]);
                        }
                    }
                    if (entry.scope === "exception") {
                        logJavaException(commonProperties);
                    } else {
                        logJavaInfo(commonProperties, measureProperties);
                    }
                });
            }
        });
    }));
    let isFetchingVariables = false;
    let previousBreakpointNumber = -1;
    


    let breakpointsLineNumber: number[] = [];
    context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(async (customEvent) => {
        // get stack trace
        const session = customEvent.session;
        if (!session || isFetchingStackFrames) return;

        // if (session.type === JAVA_LANGID && customEvent.event === 'stopped' && customEvent.body.reason === 'breakpoint') {
        //     // The reason 'breakpoint' may need to be adjusted based on actual event details
        //     isFetchingStackFrames = true;
        //     const stackFrames = await fetchStackFramesFromActiveSession(session);
        //     isFetchingStackFrames = false;

        //     console.log('Stack Frames:', stackFrames);
        //     // Further processing and organization of stack frames as needed
        // }

        // get breakpoint number
        if (breakpointsLineNumber.length == 0) {
            const breakpoints = vscode.debug.breakpoints.filter(bp => bp instanceof vscode.SourceBreakpoint);
            breakpointsLineNumber = breakpoints.map((breakpoint) => {
                if (breakpoint instanceof vscode.SourceBreakpoint) {
                    return breakpoint.location.range.start.line;
                } else {
                    return -1;
                }
            });
        }
        console.log("breakpointslinenumber", breakpointsLineNumber);

        const t = customEvent.session ? customEvent.session.type : undefined;
        if (t !== JAVA_LANGID) {
            return;
        }

        if (customEvent.event === TELEMETRY_EVENT) {
            sendInfo("", {
                operationName: customEvent.body?.name,
                ...customEvent.body?.properties,
            });
            // variable response
            let variableResponse;
            let stackFrames;
            let codeBlocks = [];
            if (!isFetchingVariables) {
                isFetchingVariables = true;
                variableResponse = await fetchVariablesFromActiveSession();
                // stack frames
                stackFrames = await fetchStackFramesFromActiveSession(session);
                // get current line to nearest breakpoints
                if (stackFrames) {
                    for (const frame of stackFrames) {
                        let functionStartLine = await getFunctionStartLine(frame.file, frame.name);
                        if (functionStartLine) {
                            let codeBlock = getCodeBlockFromFile(frame.file, functionStartLine, frame.line);
                            codeBlocks.push(codeBlock);
                        }
                    }   
                }
                console.log("codeblocks", codeBlocks);

                isFetchingVariables = false;
            }
            console.log("variableResponse", variableResponse);
            console.log('Stack Frames:', stackFrames);

            // get current line number
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) return;
            const currentPosition = activeEditor.selection.active;
            const currentLine = currentPosition.line + 1;
            console.log("current line is", currentLine);
            const currentLineContent = activeEditor.document.lineAt(currentLine - 1).text;
            console.log("current content is", currentLineContent);    
            let logLine: LogLine = {
                Type: "",
                LineNumber: 0,
                variable: null, // Initialize with appropriate default value
                LineContent: "", // Initialize with appropriate default value
                StackTrace: null,
                CodeBlocks: null,
            };
            

            // save to log history
            if (breakpointsLineNumber.includes(currentLine)) {
                logLine.Type = "bp";
            } else {
                logLine.Type = "regular";
            }
            logLine.LineNumber = currentLine;
            logLine.variable = variableResponse;
            logLine.LineContent = currentLineContent;
            logLine.StackTrace = stackFrames;
            logLine.CodeBlocks = codeBlocks;
            if (logLine.variable !== undefined) {
                log.push(logLine);
                console.log("log", log);
            }
            
        } else if (customEvent.event === HCR_EVENT) {
            handleHotCodeReplaceCustomEvent(customEvent);
        } else if (customEvent.event === USER_NOTIFICATION_EVENT) {
            handleUserNotification(customEvent);
        }
    }));
}

// get lines from file
function getCodeBlockFromFile(filePath: string, startLine: number, endLine: number): string {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split(/\r?\n/);
    // Adjust line numbers from 1-based to 0-based indexing
    return lines.slice(startLine - 1, endLine).join('\n');
}

async function getFunctionStartLine(filePath: string, functionSignature: string): Promise<number | null> {
    const document = await vscode.workspace.openTextDocument(filePath);
    const symbols: vscode.DocumentSymbol[] = await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        document.uri
    );

    if (!symbols) {
        return null; // No symbols found in the document
    }

    // Flatten all symbols (including nested symbols)
    const allSymbols = flattenSymbols(symbols);

    // Parse the class and method from the function signature
    const [className, methodSignature] = functionSignature.split('.');
    const methodName = methodSignature.split('(')[0];
    
    // Find the class symbol
    const classSymbol = allSymbols.find(symbol =>
        symbol.kind === vscode.SymbolKind.Class && symbol.name === className
    );

    if (!classSymbol) {
        return null; // No matching class found
    }

    // Find the method symbol within the class
    const methodSymbol = classSymbol.children.find(symbol =>
        symbol.kind === vscode.SymbolKind.Method && symbol.name.startsWith(methodName)
    );

    return methodSymbol ? methodSymbol.range.start.line : null; // zero-based line number
}

function flattenSymbols(symbols: vscode.DocumentSymbol[], allSymbols: vscode.DocumentSymbol[] = []): vscode.DocumentSymbol[] {
    symbols.forEach(symbol => {
        allSymbols.push(symbol);
        if (symbol.children && symbol.children.length > 0) {
            flattenSymbols(symbol.children, allSymbols);
        }
    });
    return allSymbols;
}



// get the stackframe
interface StackFrameInfo {
    name: string;
    line: number;
    file: string;
}

let isFetchingStackFrames = false; // Flag to prevent overlapping fetch operations

async function fetchStackFramesFromActiveSession(session: vscode.DebugSession): Promise<StackFrameInfo[]> {
    if (!session) {
        console.log('No active debug session.');
        return [];
    }

    // Request the stack trace from the current debug session
    try {
        const stackTraceResponse = await session.customRequest('stackTrace', { threadId: 1 }); // Adjust threadId as necessary
        return stackTraceResponse.stackFrames.map((frame: any): StackFrameInfo => ({
            name: frame.name,
            line: frame.line,
            file: frame.source.path,
        }));
    } catch (error) {
        console.error('Error fetching stack frames:', error);
        return [];
    }
}


// get precondition before current active line
async function fetchVariablesFromActiveSession() {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
        console.log("No active debug session.");
        return;
    }

    // Normally, you'd get the threadId and frameId dynamically, but for illustration:
    const threadId = 1; // This is hypothetical; you need the actual thread ID.
    let runned = false;
    try {
        // Fetch stack frames to get a valid frameId
        const stackResponse = await session.customRequest('stackTrace', { threadId });
        if (stackResponse && stackResponse.stackFrames.length > 0) {
            const frameId = stackResponse.stackFrames[0].id; // Get the first frame's ID
            
            // Now fetch variables for this frame
            const scopesResponse = await session.customRequest('scopes', { frameId });
            if (scopesResponse && scopesResponse.scopes.length > 0) {
                const variablesReference = scopesResponse.scopes[0].variablesReference;
                
                // Finally, get the variables using the variablesReference obtained from the scope
                const variablesResponse = await session.customRequest('variables', { variablesReference });
                return variablesResponse.variables; // Log or process variables
            }
        }
    } catch (error) {
        console.error("Failed to fetch variables:", error);
    }
}

function handleUserNotification(customEvent: vscode.DebugSessionCustomEvent) {
    if (customEvent.body.notificationType === "ERROR") {
        utility.showErrorMessageWithTroubleshooting({
            message: customEvent.body.message,
        });
    } else if (customEvent.body.notificationType === "WARNING") {
        utility.showWarningMessageWithTroubleshooting({
            message: customEvent.body.message,
        });
    } else {
        vscode.window.showInformationMessage(customEvent.body.message);
    }
}

function fetchUsageData() {
    return commands.executeJavaLanguageServerCommand(commands.JAVA_FETCH_USAGE_DATA);
}

function specifyProgramArguments(context: vscode.ExtensionContext): Thenable<string> {
    const javaDebugProgramArgsKey = "JavaDebugProgramArgs";

    const options: vscode.InputBoxOptions = {
        ignoreFocusOut: true,
        placeHolder: "Enter program arguments or leave empty to pass no args",
    };

    const prevArgs = context.workspaceState.get(javaDebugProgramArgsKey, "");
    if (prevArgs.length > 0) {
        options.value = prevArgs;
    }

    return vscode.window.showInputBox(options).then((text) => {
        // When user cancels the input box (by pressing Esc), the text value is undefined.
        if (text !== undefined) {
            context.workspaceState.update(javaDebugProgramArgsKey, text);
        }

        return text || " ";
    });
}

async function applyHCR(hcrStatusBar: NotificationBar) {
    const debugSession: vscode.DebugSession | undefined = vscode.debug.activeDebugSession;
    if (!debugSession) {
        return;
    }

    if (debugSession.configuration.noDebug) {
        vscode.window.showWarningMessage("Failed to apply the changes because hot code replace is not supported by run mode, "
            + "would you like to restart the program?", YES_BUTTON, NO_BUTTON).then((res) => {
            if (res === YES_BUTTON) {
                vscode.commands.executeCommand("workbench.action.debug.restart");
            }
        });

        return;
    }

    const autobuildConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("java.autobuild");
    if (!autobuildConfig.enabled) {
        // If autobuild is disabled, force an incremental build before HCR.
        try {
            hcrStatusBar.show("$(sync~spin)Compiling...");
            await commands.executeJavaExtensionCommand(commands.JAVA_BUILD_WORKSPACE, JSON.stringify({
                isFullBuild: false
            }));
        } catch (err) {
            // do nothing.
        }
    }

    hcrStatusBar.show("$(sync~spin)Applying code changes...");
    const start = new Date().getTime();
    const response = await debugSession.customRequest("redefineClasses");
    const elapsed = new Date().getTime() - start;
    const humanVisibleDelay = elapsed < 150 ? 150 : 0;
    if (humanVisibleDelay) {
        await new Promise((resolve) => {
            setTimeout(resolve, humanVisibleDelay);
        });
    }

    if (response && response.errorMessage) {
        // The detailed error message is handled by hotCodeReplace#handleHotCodeReplaceCustomEvent
        hcrStatusBar.clear();
        return;
    }

    if (!response || !response.changedClasses || !response.changedClasses.length) {
        hcrStatusBar.clear();
        vscode.window.showWarningMessage("Cannot find any changed classes for hot replace!");
        return;
    }

    const changed = response.changedClasses.length;
    hcrStatusBar.show("$(check)" + `${changed} changed class${changed > 1 ? "es are" : " is"} reloaded`, 5 * 1000);
}

async function runJavaFile(uri: vscode.Uri, noDebug: boolean) {
    const progressReporter = progressProvider.createProgressReporter(noDebug ? "Run" : "Debug");
    try {
        // Wait for Java Language Support extension being on Standard mode.
        const isOnStandardMode = await utility.waitForStandardMode(progressReporter);
        if (!isOnStandardMode) {
            throw new utility.OperationCancelledError("");
        }

        const activeEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
        if (!uri && activeEditor && _.endsWith(path.basename(activeEditor.document.fileName), ".java")) {
            uri = activeEditor.document.uri;
        }

        if (!uri) {
            vscode.window.showErrorMessage(`${noDebug ? "Run" : "Debug"} failed. Please open a Java file with main method first.`);
            throw new utility.OperationCancelledError("");
        }

        const mainMethods: IMainMethod[] = await resolveMainMethod(uri);
        const hasMainMethods: boolean = mainMethods.length > 0;
        const canRunTests: boolean = await canDelegateToJavaTestRunner(uri);
        const defaultPlaceHolder: string = "Select the main class to run";

        if (!hasMainMethods && !canRunTests) {
            // If current file is not a main class, "Run Java" will run previously used launch config.
            if (lastUsedLaunchConfig) {
                progressReporter.setJobName(utility.launchJobName(lastUsedLaunchConfig.name, noDebug));
                progressReporter.report("Resolving launch configuration...");
                lastUsedLaunchConfig.noDebug = noDebug;
                lastUsedLaunchConfig.__progressId = progressReporter.getId();
                vscode.debug.startDebugging(lastUsedLaunchConfig.__workspaceFolder, lastUsedLaunchConfig);
            } else {
                progressReporter.report("Resolving main class...");
                const mainClasses: IMainClassOption[] = await utility.searchMainMethods();
                if (progressReporter.isCancelled()) {
                    throw new utility.OperationCancelledError("");
                }

                const placeHolder: string = `The file '${path.basename(uri.fsPath)}' is not executable, please select a main class you want to run.`;
                await launchMain(mainClasses, uri, noDebug, progressReporter, placeHolder, false /*autoPick*/);
            }
        } else if (hasMainMethods && !canRunTests) {
            await launchMain(mainMethods, uri, noDebug, progressReporter, defaultPlaceHolder);
        } else if (!hasMainMethods && canRunTests) {
            launchTesting(uri, noDebug, progressReporter);
        } else {
            const launchMainChoice: string = "main() method";
            const launchTestChoice: string = "unit tests";
            const choice: string | undefined = await vscode.window.showQuickPick(
                [launchMainChoice, launchTestChoice],
                { placeHolder: "Please select which kind of task you would like to launch" },
            );
            if (choice === launchMainChoice) {
                await launchMain(mainMethods, uri, noDebug, progressReporter, defaultPlaceHolder);
            } else if (choice === launchTestChoice) {
                launchTesting(uri, noDebug, progressReporter);
            }
        }
    } catch (ex) {
        progressReporter.done();
        if (ex instanceof utility.OperationCancelledError) {
            return;
        }

        if (ex instanceof utility.JavaExtensionNotEnabledError) {
            utility.guideToInstallJavaExtension();
            return;
        }

        vscode.window.showErrorMessage(String((ex && ex.message) || ex));
    }
}

async function canDelegateToJavaTestRunner(uri: vscode.Uri): Promise<boolean> {
    const fsPath: string = uri.fsPath;
    const isTestFile: boolean = /.*[\/\\]src[\/\\]test[\/\\]java[\/\\].*[Tt]ests?\.java/.test(fsPath);
    if (!isTestFile) {
        return false;
    }
    return (await vscode.commands.getCommands()).includes("java.test.editor.run");
}

function launchTesting(uri: vscode.Uri, noDebug: boolean, progressReporter: IProgressReporter) {
    const command: string = noDebug ? "java.test.editor.run" : "java.test.editor.debug";
    vscode.commands.executeCommand(command, uri, progressReporter);
    if (compareVersions.compare(getTestExtensionVersion(), "0.26.1", "<=")) {
        throw new utility.OperationCancelledError("");
    }
}

function getTestExtensionVersion(): string {
    const extension: vscode.Extension<any> | undefined = vscode.extensions.getExtension("vscjava.vscode-java-test");
    return extension?.packageJSON.version || "0.0.0";
}

async function launchMain(mainMethods: IMainClassOption[], uri: vscode.Uri, noDebug: boolean, progressReporter: IProgressReporter,
                          placeHolder: string, autoPick: boolean = true): Promise<void> {
    if (!mainMethods || !mainMethods.length) {
        vscode.window.showErrorMessage(
            "Error: Main method not found in the file, please define the main method as: public static void main(String[] args)");
        throw new utility.OperationCancelledError("");
    }

    if (!mainClassPicker.isAutoPicked(mainMethods, autoPick)) {
        progressReporter.hide(true);
    }

    const pick = await mainClassPicker.showQuickPickWithRecentlyUsed(mainMethods, placeHolder, autoPick);
    if (!pick) {
        throw new utility.OperationCancelledError("");
    }

    const existConfig: vscode.DebugConfiguration | undefined = findLaunchConfiguration(
        pick.mainClass, pick.projectName, uri.fsPath);
    if (existConfig) {
        progressReporter.setJobName(utility.launchJobName(existConfig.name, noDebug));
    } else {
        progressReporter.setJobName(utility.launchJobNameByMainClass(pick.mainClass, noDebug));
    }
    progressReporter.report("Launching main class...");
    startDebugging(pick.mainClass, pick.projectName || "", uri, noDebug, progressReporter);
}

async function runJavaProject(node: any, noDebug: boolean) {
    if (!node || !node.name || !node.uri) {
        vscode.window.showErrorMessage(`Failed to ${noDebug ? "run" : "debug"} the project because of invalid project node. `
            + "This command only applies to Project Explorer view.");
        const error = new Error(`Failed to ${noDebug ? "run" : "debug"} the project because of invalid project node.`);
        setUserError(error);
        throw error;
    }

    const progressReporter = progressProvider.createProgressReporter(noDebug ? "Run" : "Debug");
    try {
        progressReporter.report("Resolving main class...");
        const mainClassesOptions: IMainClassOption[] = await utility.searchMainMethods(vscode.Uri.parse(node.uri));
        if (progressReporter.isCancelled()) {
            throw new utility.OperationCancelledError("");
        }

        if (!mainClassesOptions || !mainClassesOptions.length) {
            vscode.window.showErrorMessage(`Failed to ${noDebug ? "run" : "debug"} this project '${node._nodeData.displayName || node.name}' `
                + "because it does not contain any main class.");
            throw new utility.OperationCancelledError("");
        }

        if (!mainClassPicker.isAutoPicked(mainClassesOptions)) {
            progressReporter.hide(true);
        }
        const pick = await mainClassPicker.showQuickPickWithRecentlyUsed(mainClassesOptions,
            "Select the main class to run.");
        if (!pick || progressReporter.isCancelled()) {
            throw new utility.OperationCancelledError("");
        }

        const projectName: string | undefined = pick.projectName;
        const mainClass: string = pick.mainClass;
        const filePath: string | undefined = pick.filePath;
        const workspaceFolder: vscode.WorkspaceFolder | undefined =
            filePath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath)) : undefined;
        const existConfig: vscode.DebugConfiguration | undefined = findLaunchConfiguration(mainClass, projectName, filePath);
        const debugConfig = existConfig || {
            type: "java",
            name: `${mainClass.substr(mainClass.lastIndexOf(".") + 1)}`,
            request: "launch",
            mainClass,
            projectName,
        };
        debugConfig.noDebug = noDebug;
        debugConfig.__progressId = progressReporter.getId();
        debugConfig.__origin = "internal";
        progressReporter.setJobName(utility.launchJobName(debugConfig.name, noDebug));
        progressReporter.report("Launching main class...");
        vscode.debug.startDebugging(workspaceFolder, debugConfig);
    } catch (ex) {
        progressReporter.done();
        if (ex instanceof utility.OperationCancelledError) {
            return;
        }

        throw ex;
    }
}

function findLaunchConfiguration(mainClass: string, projectName: string | undefined, filePath?: string): vscode.DebugConfiguration | undefined {
    const workspaceFolder: vscode.WorkspaceFolder | undefined =
            filePath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath)) : undefined;
    const launchConfigurations: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("launch", workspaceFolder);
    const existingConfigs: vscode.DebugConfiguration[] = launchConfigurations.configurations;
    const existConfig: vscode.DebugConfiguration | undefined = _.find(existingConfigs, (config) => {
        return config.mainClass === mainClass && _.toString(config.projectName) === _.toString(projectName);
    });

    return existConfig;
}
