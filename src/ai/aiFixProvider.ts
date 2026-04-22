import OpenAI from 'openai';
import { SonarIssue } from '../api/sonarqubeApi';

export interface AiFixResult {
    fixedCode: string;
}

export class AiFixProvider {
    private readonly client: OpenAI;

    constructor(apiKey?: string) {
        this.client = new OpenAI({
            apiKey: apiKey || process.env.OPENAI_API_KEY
        });
    }

    async fixIssue(
        issue: SonarIssue,
        codeSnippet: string,
        fullFileContent: string,
        startLine: number,
        endLine: number
    ): Promise<AiFixResult> {
        const filePath = issue.component.includes(':')
            ? issue.component.split(':').slice(1).join(':')
            : issue.component;

        const systemPrompt = [
            'You are an expert code quality engineer specializing in fixing SonarQube issues.',
            'Your job is to return ONLY the fixed version of the provided code block.',
            'Rules:',
            '- Return the fixed code only, no explanations, no markdown, no code fences.',
            '- Preserve original indentation exactly.',
            '- Do not add line numbers.',
            '- Fix ONLY the reported issue, do not refactor unrelated code.',
            '- If the fix requires importing a new module, add the import at the top of the returned snippet.'
        ].join('\n');

        const userPrompt = this.buildPrompt(issue, codeSnippet, fullFileContent, filePath, startLine, endLine);

        const response = await this.client.chat.completions.create({
            model: 'gpt-4o',
            max_tokens: 4096,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt }
            ]
        });

        const rawText = response.choices[0]?.message?.content || '';
        const fixedCode = this.stripMarkdownFences(rawText);
        return { fixedCode };
    }

    private buildPrompt(
        issue: SonarIssue,
        codeSnippet: string,
        fullFileContent: string,
        filePath: string,
        startLine: number,
        endLine: number
    ): string {
        const context = fullFileContent.length > 4000
            ? fullFileContent.substring(0, 4000) + '\n... (truncated for brevity)'
            : fullFileContent;

        return `Fix the following SonarQube issue.

## Issue
- Rule: ${issue.rule}
- Severity: ${issue.severity}
- Type: ${issue.type}
- Message: ${issue.message}
- File: ${filePath}
- Lines: ${startLine}–${endLine}

## Code to Fix (lines ${startLine}–${endLine})
${codeSnippet}

## Full File (for context only — do NOT return this)
${context}

Return ONLY the fixed version of lines ${startLine}–${endLine}. No explanation. No markdown.`;
    }

    private stripMarkdownFences(text: string): string {
        const fenced = /^```\w*\n([\s\S]*?)```\s*$/m.exec(text);
        if (fenced) {
            return fenced[1].trimEnd();
        }
        return text.trim();
    }
}
