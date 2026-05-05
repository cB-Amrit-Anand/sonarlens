import * as vscode from 'vscode';
import { SonarQubeBaseProvider } from './baseProvider';

export class SonarQubeWebviewProvider extends SonarQubeBaseProvider {
    private panel?: vscode.WebviewPanel;

    async openPanel(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'sonarqubeAiFixer',
            'SonarQube AI Fixer',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'webview')
                ]
            }
        );

        this.panel.webview.html = this.getWebviewContent();
        this.panel.onDidDispose(() => { this.panel = undefined; }, null, this.context.subscriptions);
        this.panel.webview.onDidReceiveMessage(this.handleMessage.bind(this), null, this.context.subscriptions);

        await this.initConfig();
    }

    protected post(message: Record<string, unknown>): void {
        this.panel?.webview.postMessage(message);
    }
}
