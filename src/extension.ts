import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RepoManager } from './repoManager';
import { SecurityAnalyzer } from './securityAnalyzer';
import { CodeOptimizer } from './codeOptimizer';
import { ArchitectureAnalyzer } from './architectureAnalyzer';

// Main Analysis Result Interface
export interface AnalysisResult {
    security: SecurityResult[];
    optimization: OptimizationResult[];
    architecture: ArchitectureResult;
    differences: CodeDifference[];
    repoInfo: RepositoryInfo;
}

// Repository Information
export interface RepositoryInfo {
    currentBranch: string;
    lastCommit: string;
    modifiedFiles: string[];
    branches: string[];
    remoteUrl: string;
}

// Security Analysis Results
export interface SecurityResult {
    file: string;
    issues: SecurityIssue[];
}

export interface SecurityIssue {
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    line?: number;
    column?: number;
    suggestion: string;
}

// Optimization Analysis Results
export interface OptimizationResult {
    file: string;
    suggestions: OptimizationSuggestion[];
}

export interface OptimizationSuggestion {
    type: string;
    message: string;
    line?: number;
    suggestion: string;
    impact: 'low' | 'medium' | 'high';
}

// Architecture Analysis Results
export interface ArchitectureResult {
    patterns: ArchitecturePattern[];
    suggestions: ArchitectureSuggestion[];
    dependencies: DependencyInfo[];
}

export interface ArchitecturePattern {
    type: string;
    description: string;
    files: string[];
    confidence: number;
}

export interface ArchitectureSuggestion {
    type: string;
    message: string;
    impact: 'low' | 'medium' | 'high';
    suggestion: string;
}

export interface DependencyInfo {
    module: string;
    usedBy: string[];
    dependencies: string[];
    circular?: boolean;
}

// Code Difference Analysis
export interface CodeDifference {
    file: string;
    changes: Change[];
}

export interface Change {
    type: 'add' | 'remove' | 'modify';
    lineNumber: number;
    content: string;
    suggestion?: string;
}

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('repo-analyzer.analyzeRepository', async () => {
        try {
            // Get repository URL from user
            const repoUrl = await vscode.window.showInputBox({
                prompt: 'Enter the repository URL (GitHub or GitLab)',
                placeHolder: 'https://github.com/username/repo',
                validateInput: (input) => {
                    if (!input) return 'Repository URL is required';
                    if (!input.startsWith('https://')) return 'URL must start with https://';
                    if (!input.includes('github.com') && !input.includes('gitlab.com')) {
                        return 'Only GitHub and GitLab repositories are supported';
                    }
                    return null;
                }
            });

            if (!repoUrl) {
                return;
            }

            // Show progress
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Analyzing Repository",
                cancellable: true
            }, async (progress) => {
                try {
                    progress.report({ message: 'Cloning/updating repository...' });
                    const result = await analyze(repoUrl);

                    progress.report({ message: 'Generating report...' });
                    showAnalysisResults(result);
                } catch (error: unknown) {
                    if (error instanceof Error && error.message === 'WORKSPACE_SWITCHED') {
                        // Re-run the analysis command after workspace switch
                        await vscode.commands.executeCommand('repo-analyzer.analyzeRepository', repoUrl);
                    } else {
                        vscode.window.showErrorMessage(`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    }
                }
            });
        } catch (error: unknown) {
            vscode.window.showErrorMessage(`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    });

    context.subscriptions.push(disposable);
}

function showAnalysisResults(result: AnalysisResult): void {
    const panel = vscode.window.createWebviewPanel(
        'repoAnalysis',
        'Repository Analysis Results',
        vscode.ViewColumn.One,
        {
            enableScripts: true
        }
    );

    panel.webview.html = generateResultsHtml(result);
}

function generateResultsHtml(result: AnalysisResult): string {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                }
                .section { 
                    margin-bottom: 30px;
                    background-color: var(--vscode-editor-background);
                    padding: 15px;
                    border-radius: 6px;
                }
                .issue { 
                    padding: 15px;
                    margin: 10px 0;
                    border-radius: 4px;
                    background-color: var(--vscode-editor-background);
                }
                .critical { 
                    border-left: 4px solid #ff0000;
                    background-color: var(--vscode-inputValidation-errorBackground);
                }
                .high { 
                    border-left: 4px solid #ff9900;
                    background-color: var(--vscode-inputValidation-warningBackground);
                }
                .medium { 
                    border-left: 4px solid #ffcc00;
                    background-color: var(--vscode-inputValidation-infoBackground);
                }
                .low { 
                    border-left: 4px solid #00cc00;
                }
                .suggestion { 
                    font-style: italic;
                    color: var(--vscode-descriptionForeground);
                }
                h1, h2, h3 { color: var(--vscode-editor-foreground); }
                .file-path { 
                    font-family: monospace;
                    background-color: var(--vscode-textBlockQuote-background);
                    padding: 2px 6px;
                    border-radius: 3px;
                }
            </style>
        </head>
        <body>
            <h1>Repository Analysis Results</h1>
            
            <div class="section">
                <h2>Repository Info</h2>
                <p>Current Branch: ${result.repoInfo.currentBranch}</p>
                <p>Last Commit: ${result.repoInfo.lastCommit}</p>
                <p>Modified Files: ${result.repoInfo.modifiedFiles.length}</p>
                <p>Remote URL: ${result.repoInfo.remoteUrl}</p>
            </div>

            ${generateSecuritySection(result.security)}
            ${generateOptimizationSection(result.optimization)}
            ${generateArchitectureSection(result.architecture)}
            ${generateDifferencesSection(result.differences)}
        </body>
        </html>
    `;
}

function generateSecuritySection(security: SecurityResult[]): string {
    if (!security.length) return '';
    
    return `
        <div class="section">
            <h2>Security Analysis</h2>
            ${security.map(result => `
                <div class="file-group">
                    <p class="file-path">${result.file}</p>
                    ${result.issues.map(issue => `
                        <div class="issue ${issue.severity}">
                            <h3>🚨 ${issue.type}</h3>
                            ${issue.line ? `<p>Line: ${issue.line}</p>` : ''}
                            <p>${issue.message}</p>
                            <p class="suggestion">Suggestion: ${issue.suggestion}</p>
                        </div>
                    `).join('')}
                </div>
            `).join('')}
        </div>
    `;
}

function generateOptimizationSection(optimization: OptimizationResult[]): string {
    if (!optimization.length) return '';

    return `
        <div class="section">
            <h2>Code Optimization</h2>
            ${optimization.map(result => `
                <div class="file-group">
                    <p class="file-path">${result.file}</p>
                    ${result.suggestions.map(suggestion => `
                        <div class="issue ${suggestion.impact}">
                            <h3>🔍 ${suggestion.type}</h3>
                            ${suggestion.line ? `<p>Line: ${suggestion.line}</p>` : ''}
                            <p>${suggestion.message}</p>
                            <p class="suggestion">Suggestion: ${suggestion.suggestion}</p>
                        </div>
                    `).join('')}
                </div>
            `).join('')}
        </div>
    `;
}

function generateArchitectureSection(architecture: ArchitectureResult): string {
    if (!architecture.patterns.length && !architecture.suggestions.length) return '';

    return `
        <div class="section">
            <h2>Architecture Analysis</h2>
            ${architecture.patterns.map(pattern => `
                <div class="issue medium">
                    <h3>🏗️ ${pattern.type}</h3>
                    <p>${pattern.description}</p>
                    <p>Confidence: ${pattern.confidence}%</p>
                    <p>Files: ${pattern.files.length}</p>
                </div>
            `).join('')}
            ${architecture.suggestions.map(suggestion => `
                <div class="issue ${suggestion.impact}">
                    <p>${suggestion.message}</p>
                    <p class="suggestion">Suggestion: ${suggestion.suggestion}</p>
                </div>
            `).join('')}
            ${generateDependencySection(architecture.dependencies)}
        </div>
    `;
}

function generateDependencySection(dependencies: ArchitectureResult['dependencies']): string {
    if (!dependencies.length) return '';

    return `
        <div class="subsection">
            <h3>Dependencies</h3>
            ${dependencies.map(dep => `
                <div class="issue ${dep.circular ? 'high' : 'low'}">
                    <h4>${dep.module}</h4>
                    <p>Used by: ${dep.usedBy.length ? dep.usedBy.join(', ') : 'None'}</p>
                    <p>Dependencies: ${dep.dependencies.length ? dep.dependencies.join(', ') : 'None'}</p>
                    ${dep.circular ? '<p class="suggestion">Warning: Circular dependency detected</p>' : ''}
                </div>
            `).join('')}
        </div>
    `;
}

function generateDifferencesSection(differences: CodeDifference[]): string {
    if (!differences.length) return '';

    return `
        <div class="section">
            <h2>Recent Changes</h2>
            ${differences.map(diff => `
                <div class="issue low">
                    <h3>📝 ${diff.file}</h3>
                    ${diff.changes.map(change => `
                        <div class="change">
                            <p>Line ${change.lineNumber}: ${change.type}</p>
                            <pre>${change.content}</pre>
                            ${change.suggestion ? `<p class="suggestion">Suggestion: ${change.suggestion}</p>` : ''}
                        </div>
                    `).join('')}
                </div>
            `).join('')}
        </div>
    `;
}

export function deactivate() {}

async function analyze(repoUrl: string): Promise<AnalysisResult> {
    // Initialize managers and analyzers
    const repoManager = new RepoManager();
    const securityAnalyzer = new SecurityAnalyzer();
    const codeOptimizer = new CodeOptimizer();
    const architectureAnalyzer = new ArchitectureAnalyzer();

    let repoPath: string;

    // Check if we have an open workspace that matches the repo
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const repoName = repoUrl.split('/').pop()?.replace('.git', '');
    
    if (workspaceFolders) {
        const existingRepo = workspaceFolders.find(folder => folder.name === repoName);
        if (existingRepo) {
            repoPath = existingRepo.uri.fsPath;
            // Pull latest changes
            await repoManager.pullLatestChanges(repoPath);
        } else {
            // Clone to a new folder
            repoPath = await repoManager.getRepository(repoUrl);
        }
    } else {
        // No workspace open, clone to default location
        repoPath = await repoManager.getRepository(repoUrl);
    }

    // Get repository information
    const branches = await repoManager.getBranches(repoPath);
    const currentBranch = branches.find(b => b.includes('* '))?.replace('* ', '') || 'main';
    const lastCommit = await repoManager.getLastCommit(repoPath);
    
    // Initialize result structure
    const result: AnalysisResult = {
        security: [],
        optimization: [],
        architecture: {
            patterns: [],
            suggestions: [],
            dependencies: []
        },
        differences: [],
        repoInfo: {
            currentBranch,
            lastCommit,
            modifiedFiles: [],
            branches,
            remoteUrl: repoUrl
        }
    };

    async function analyzeFile(filePath: string, relativePath: string) {
        try {
            // Check if file exists and is accessible
            await fs.access(filePath);

            // Security analysis
            try {
                const securityIssues = await securityAnalyzer.analyzeFile(filePath);
                if (securityIssues.length > 0) {
                    result.security.push({
                        file: relativePath,
                        issues: securityIssues
                    });
                }
            } catch (error) {
                console.error(`Security analysis failed for ${filePath}:`, error);
            }

            // Optimization analysis
            try {
                const optimizationResult = await codeOptimizer.analyzeCode(filePath);
                if (optimizationResult.suggestions.length > 0) {
                    result.optimization.push({
                        file: relativePath,
                        suggestions: optimizationResult.suggestions
                    });
                }
            } catch (error) {
                console.error(`Optimization analysis failed for ${filePath}:`, error);
            }
        } catch (error) {
            console.error(`File not accessible: ${filePath}`);
        }
    }

    try {
        // Check for recent changes first
        const mainBranch = branches.find(b => ['main', 'master'].includes(b)) || 'main';
        const diff = await repoManager.getDiff(repoPath, `${mainBranch}~1`, mainBranch);
        
        if (diff.trim()) {
            // There are recent changes, analyze only changed files
            result.differences = await parseDiff(diff, repoPath);
            
            // Get the changed files paths
            const changedFiles = result.differences.map(d => path.join(repoPath, d.file));
            
            // Analyze only changed files
            for (const filePath of changedFiles) {
                const relativePath = path.relative(repoPath, filePath);
                await analyzeFile(filePath, relativePath);
            }
        } else {
            // No recent changes, do complete analysis
            const files = await vscode.workspace.findFiles(
                '{**/*.ts,**/*.js,**/*.jsx,**/*.tsx,**/*.py,**/*.java,**/*.cpp,**/*.cs}',
                '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**}'
            );

            for (const file of files) {
                // Ensure file is within repo directory
                if (file.fsPath.startsWith(repoPath)) {
                    const relativePath = path.relative(repoPath, file.fsPath);
                    await analyzeFile(file.fsPath, relativePath);
                }
            }
        }

        // Architecture analysis is always done project-wide
        try {
            result.architecture = await architectureAnalyzer.analyzeStructure(repoPath);
        } catch (error) {
            console.error('Architecture analysis failed:', error);
            result.architecture = {
                patterns: [],
                suggestions: [],
                dependencies: []
            };
        }

        // Update modified files list
        result.repoInfo.modifiedFiles = await repoManager.getStatus(repoPath);

    } catch (error) {
        console.error('Analysis failed:', error);
        throw error; // Re-throw to be handled by the caller
    }

    return result;
}


async function parseDiff(diff: string, repoPath: string): Promise<CodeDifference[]> {
    const differences: CodeDifference[] = [];
    const codeOptimizer = new CodeOptimizer();

    // Split diff into file segments
    const fileSegments = diff.split('diff --git');

    for (const segment of fileSegments) {
        if (!segment.trim()) continue;

        // Parse file path
        const fileMatch = segment.match(/a\/(.+?) b\//);
        if (!fileMatch) continue;

        const filePath = fileMatch[1];
        const changes: Change[] = [];

        // Parse hunks
        const hunks = segment.split('@@').slice(1);
        for (let i = 0; i < hunks.length; i += 2) {
            const hunkHeader = hunks[i];
            const hunkContent = hunks[i + 1];
            if (!hunkHeader || !hunkContent) continue;

            // Parse line numbers
            const lineMatch = hunkHeader.match(/-(\d+),?\d* \+(\d+),?\d*/);
            if (!lineMatch) continue;

            const startLine = parseInt(lineMatch[2]);
            let currentLine = startLine;

            // Parse changes
            const lines = hunkContent.split('\n');
            for (const line of lines) {
                if (!line) continue;

                const type = line[0] === '+' ? 'add' :
                           line[0] === '-' ? 'remove' : 'modify';
                
                if (type !== 'modify') {
                    const content = line.slice(1);
                    const suggestions = await codeOptimizer.analyzePatch(content);
                    
                    changes.push({
                        type,
                        lineNumber: currentLine,
                        content,
                        suggestion: suggestions.join('\n')
                    });
                }

                if (type !== 'remove') {
                    currentLine++;
                }
            }
        }

        if (changes.length > 0) {
            differences.push({
                file: path.relative(repoPath, filePath),
                changes
            });
        }
    }

    return differences;
}