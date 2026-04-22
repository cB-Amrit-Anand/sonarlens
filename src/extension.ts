import * as vscode from 'vscode';
import { SonarQubeWebviewProvider } from './ui/webviewProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new SonarQubeWebviewProvider(context);

    const disposable = vscode.commands.registerCommand('sonarqube-ai-fixer.open', () => {
        provider.openPanel();
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
