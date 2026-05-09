import * as vscode from 'vscode';
import { SonarQubeSidebarProvider } from './ui/sidebarProvider';
import { SonarQubeWebviewProvider } from './ui/webviewProvider';

export function activate(context: vscode.ExtensionContext) {
    const panelProvider   = new SonarQubeWebviewProvider(context);
    const sidebarProvider = new SonarQubeSidebarProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SonarQubeSidebarProvider.viewId,
            sidebarProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.commands.registerCommand('sonarlens.openPanel', () => {
            panelProvider.openPanel();
        })
    );
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivate() {}
