import * as vscode from 'vscode';
import { SonarQubeBaseProvider } from './baseProvider';

export class SonarQubeSidebarProvider extends SonarQubeBaseProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'sonarlens.sidebar';

    private view?: vscode.WebviewView;

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'webview')
            ]
        };

        webviewView.webview.html = this.getWebviewContent();

        webviewView.webview.onDidReceiveMessage(
            this.handleMessage.bind(this),
            null,
            this.context.subscriptions
        );

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this.initConfig(); }
        });

        this.initConfig();
    }

    protected post(message: Record<string, unknown>): void {
        this.view?.webview.postMessage(message);
    }
}
