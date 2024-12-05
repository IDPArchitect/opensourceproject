import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import simpleGit, { SimpleGit, StatusResult, SimpleGitProgressEvent } from 'simple-git';
import * as os from 'os';

export class RepoManager {
    private workspacePath: string;
    private git: SimpleGit;
    private outputChannel: vscode.OutputChannel;

    constructor() {
        // Initialize with current workspace if available
        this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        this.git = simpleGit();
        this.outputChannel = vscode.window.createOutputChannel('Repository Manager');
    }

    async getRepository(repoUrl: string): Promise<string> {
        const repoName = this.getRepoName(repoUrl);
        let repoPath = path.join(this.workspacePath, repoName);

        // If we're in a workspace, check if it's our target repo
        if (this.workspacePath) {
            const git = simpleGit(this.workspacePath);
            try {
                // Check if it's a git repository
                await git.status();
                
                // Check if it's our target repository
                const remotes = await git.remote(['get-url', 'origin']);
                if (remotes && remotes.trim() === repoUrl) {
                    // Already in the correct repository
                    this.log(`\n=== Analyzing current workspace repository ===`);
                    this.log(`Repository path: ${this.workspacePath}`);
                    
                    await this.updateAndAnalyzeRepository(this.workspacePath);
                    return this.workspacePath;
                }
            } catch (error) {
                // Not a git repo or different repo
            }
        }

        // Ask user where to clone the repository
        const choice = await vscode.window.showQuickPick(
            [
                'Clone in Current Folder',
                'Clone in New Location',
                'Cancel'
            ],
            {
                placeHolder: 'Where would you like to clone the repository?'
            }
        );

        if (choice === 'Cancel') {
            throw new Error('Operation cancelled by user');
        }

        if (choice === 'Clone in New Location') {
            const result = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                defaultUri: vscode.Uri.file(this.workspacePath || os.homedir()),
                openLabel: 'Select Clone Location'
            });

            if (!result || result.length === 0) {
                throw new Error('No directory selected for cloning');
            }

            repoPath = path.join(result[0].fsPath, repoName);
        }

        // Clone or update the repository
        await this.cloneRepository(repoUrl, repoPath);

        // Ask user how to handle workspace
        const workspaceChoice = await vscode.window.showQuickPick(
            ['Open in New Window', 'Add to Current Workspace', 'Keep Current Window'],
            {
                placeHolder: 'How would you like to work with this repository?'
            }
        );

        if (workspaceChoice === 'Open in New Window') {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repoPath));
            throw new Error('WORKSPACE_SWITCHED');
        } else if (workspaceChoice === 'Add to Current Workspace') {
            await vscode.workspace.updateWorkspaceFolders(
                vscode.workspace.workspaceFolders?.length || 0,
                null,
                { uri: vscode.Uri.file(repoPath) }
            );
        }

        return repoPath;
    }

    private async updateAndAnalyzeRepository(repoPath: string): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Updating Repository",
            cancellable: false
        }, async (progress) => {
            const git = simpleGit(repoPath);
            const currentHead = await git.revparse(['HEAD']);
            
            progress.report({ message: 'Fetching latest changes...' });
            await git.fetch(['--all', '--prune']);
            
            progress.report({ message: 'Pulling latest changes...' });
            await this.pullLatestChanges(repoPath);
            
            const newHead = await git.revparse(['HEAD']);
            
            if (currentHead !== newHead) {
                progress.report({ message: 'Generating diff view...' });
                await this.showVisualDiff(repoPath, currentHead, newHead);
            } else {
                this.log('Repository already up to date');
            }
        });
    }

    private async showVisualDiff(repoPath: string, oldCommit: string, newCommit: string): Promise<void> {
        const git = simpleGit(repoPath);
        
        try {
            // Create diff_reports directory
            const reportsDir = path.join(repoPath, 'diff_reports');
            await fs.mkdir(reportsDir, { recursive: true });

            // Generate single timestamp for this diff
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const reportName = `diff_${oldCommit.substring(0, 7)}_${newCommit.substring(0, 7)}_${timestamp}.md`;
            const reportPath = path.join(reportsDir, reportName);

            // Check if report already exists for these commits
            const existingReports = await fs.readdir(reportsDir);
            const sameCommitReport = existingReports.find(file => 
                file.startsWith(`diff_${oldCommit.substring(0, 7)}_${newCommit.substring(0, 7)}_`)
            );

            if (sameCommitReport) {
                this.log('Report already exists for these commits, using existing report');
                const existingReportPath = path.join(reportsDir, sameCommitReport);
                
                // Show existing report
                const document = await vscode.workspace.openTextDocument(existingReportPath);
                await vscode.window.showTextDocument(document, {
                    preview: true,
                    viewColumn: vscode.ViewColumn.Two
                });
                return;
            }

            // Get commit information
            const [oldCommitInfo, newCommitInfo] = await Promise.all([
                git.show([oldCommit, '--format=%h %an <%ae> %ai %s']),
                git.show([newCommit, '--format=%h %an <%ae> %ai %s'])
            ]);

            // Get the actual diff with stats and file changes
            const [diffStats, diffPatches] = await Promise.all([
                git.diff([oldCommit, newCommit, '--stat']),
                git.diff([oldCommit, newCommit, '--patch', '--unified=3'])
            ]);

            // Create the report content
            const reportContent = [
                `# Change Report: ${new Date().toLocaleString()}`,
                '',
                '## Commit Information',
                '### Previous Commit',
                '```',
                oldCommitInfo.split('\n')[0],
                '```',
                '',
                '### New Commit',
                '```',
                newCommitInfo.split('\n')[0],
                '```',
                '',
                '## Changes Summary',
                '```',
                diffStats,
                '```',
                '',
                '## Detailed Changes',
                '```diff',
                diffPatches,
                '```'
            ].join('\n');

            // Write the unified report
            await fs.writeFile(reportPath, reportContent);

            // Show the report in VSCode
            const document = await vscode.workspace.openTextDocument(reportPath);
            await vscode.window.showTextDocument(document, {
                preview: true,
                viewColumn: vscode.ViewColumn.Two
            });

            // Also show in diff view
            await vscode.commands.executeCommand('vscode.diff',
                await this.createTempFileForDiff(oldCommit, await git.show([oldCommit])),
                await this.createTempFileForDiff(newCommit, await git.show([newCommit])),
                `Changes: ${oldCommit.substring(0, 7)} ↔ ${newCommit.substring(0, 7)}`,
                { preview: true, viewColumn: vscode.ViewColumn.Two }
            );

            // Show notification
            vscode.window.showInformationMessage(
                `Diff report saved: ${path.basename(reportPath)}`,
                'Open Report',
                'Open Directory'
            ).then(selection => {
                if (selection === 'Open Report') {
                    vscode.workspace.openTextDocument(reportPath)
                        .then(doc => vscode.window.showTextDocument(doc));
                } else if (selection === 'Open Directory') {
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(reportsDir));
                }
            });

        } catch (error) {
            this.log(`Error showing and saving diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
            this.log('Continuing without diff view');
        }
    }

    private async createTempFileForDiff(commit: string, content: string): Promise<vscode.Uri> {
        const tempFile = path.join(os.tmpdir(), `vscode-diff-${commit}`);
        await fs.writeFile(tempFile, content);
        return vscode.Uri.file(tempFile);
    }

    private async ensureGitIgnore(repoPath: string): Promise<void> {
        const gitignorePath = path.join(repoPath, '.gitignore');
        try {
            let gitignoreContent = '';
            try {
                gitignoreContent = await fs.readFile(gitignorePath, 'utf8');
            } catch (error) {
                // File doesn't exist yet
            }

            if (!gitignoreContent.includes('diff_reports/')) {
                const newLine = gitignoreContent.endsWith('\n') ? '' : '\n';
                await fs.writeFile(gitignorePath, `${gitignoreContent}${newLine}diff_reports/\n`);
            }
        } catch (error) {
            this.log('Unable to update .gitignore');
        }
    }

    private async cloneNewRepository(repoUrl: string, repoPath: string): Promise<void> {
        this.log(`\n=== Starting clone for new repository at: ${repoPath} ===`);
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Cloning Repository",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: `Cloning repository...` });
            await fs.mkdir(path.dirname(repoPath), { recursive: true });
            await this.cloneRepository(repoUrl, repoPath);
            progress.report({ message: 'Repository cloned successfully!' });
        });

        // Handle workspace switching
        if (!vscode.workspace.workspaceFolders) {
            this.log('Opening repository in new workspace...');
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repoPath));
            this.log('=== Clone completed, switching workspace ===\n');
            throw new Error('WORKSPACE_SWITCHED');
        } else {
            this.log('Adding repository to existing workspace...');
            await vscode.workspace.updateWorkspaceFolders(
                vscode.workspace.workspaceFolders.length,
                null,
                { uri: vscode.Uri.file(repoPath) }
            );
            this.log('=== Clone completed, repository added to workspace ===\n');
        }
    }

    async getBranches(repoPath: string): Promise<string[]> {
        this.log(`\nFetching branches for repository at ${repoPath}`);
        const git = simpleGit(repoPath);
        const branches = await git.branch();
        this.log(`Found ${branches.all.length} branches:`);
        branches.all.forEach(branch => this.log(`- ${branch}`));
        return branches.all;
    }

    async switchBranch(repoPath: string, branchName: string): Promise<void> {
        this.log(`\nSwitching to branch: ${branchName}`);
        const git = simpleGit(repoPath);
        await git.checkout(branchName);
        this.log(`Successfully switched to branch: ${branchName}`);
    }

    async getLastCommit(repoPath: string): Promise<string> {
        this.log(`\nFetching last commit for repository at ${repoPath}`);
        const git = simpleGit(repoPath);
        const log = await git.log();
        const latestHash = log.latest?.hash || '';
        this.log(`Latest commit hash: ${latestHash}`);
        return latestHash;
    }

    async getDiff(repoPath: string, fromCommit: string, toCommit: string): Promise<string> {
        this.log(`\nGenerating diff between commits:`);
        this.log(`From: ${fromCommit}`);
        this.log(`To: ${toCommit}`);
        
        const git = simpleGit(repoPath);
        
        try {
            // First get the raw diff text that we'll return
            const diffText = await git.diff([fromCommit, toCommit]);
            
            // Now show the visual diff
            const oldContent = await git.show([fromCommit]);
            const newContent = await git.show([toCommit]);
            
            const oldUri = vscode.Uri.file(path.join(repoPath, '.git', 'OLD_VERSION'));
            const newUri = vscode.Uri.file(path.join(repoPath, '.git', 'NEW_VERSION'));
            
            const workspaceEdit = new vscode.WorkspaceEdit();
            workspaceEdit.createFile(oldUri, { overwrite: true, contents: Buffer.from(oldContent) });
            workspaceEdit.createFile(newUri, { overwrite: true, contents: Buffer.from(newContent) });
            
            await vscode.workspace.applyEdit(workspaceEdit);

            await vscode.commands.executeCommand('vscode.diff',
                oldUri,
                newUri,
                `Changes: ${fromCommit.substring(0, 7)} ↔ ${toCommit.substring(0, 7)}`,
                {
                    preview: true,
                    viewColumn: vscode.ViewColumn.Two
                }
            );

            // Clean up temporary files
            setTimeout(async () => {
                try {
                    await vscode.workspace.fs.delete(oldUri);
                    await vscode.workspace.fs.delete(newUri);
                } catch (error) {
                    // Ignore cleanup errors
                }
            }, 1000);
            
            // Return the diff text
            return diffText;
            
        } catch (error) {
            this.log('Error showing visual diff - falling back to text diff');
            const diff = await git.diff([fromCommit, toCommit]);
            if (diff) {
                const document = await vscode.workspace.openTextDocument({
                    content: diff,
                    language: 'diff'
                });
                await vscode.window.showTextDocument(document, {
                    preview: true,
                    viewColumn: vscode.ViewColumn.Two
                });
            }
            return diff || '';
        }
    }

    async getStatus(repoPath: string): Promise<string[]> {
        this.log(`\nChecking repository status at ${repoPath}`);
        const git = simpleGit(repoPath);
        const status = await git.status();
        
        const files = [
            ...status.modified,
            ...status.created,
            ...status.deleted,
            ...status.renamed.map(rename => rename.to),
            ...status.not_added
        ];
        
        this.log(`Found ${files.length} changed files:`);
        files.forEach(file => this.log(`- ${file}`));
        return files;
    }

    async pullLatestChanges(repoPath: string): Promise<void> {
        const git = simpleGit(repoPath);
        
        try {
            // Get initial status
            this.log('\nChecking initial repository status...');
            const initialStatus = await git.status();
            this.logStatus('Initial repository status:', initialStatus);

            // Save current HEAD for diff comparison
            const currentHead = await git.revparse(['HEAD']);
            this.log(`Current HEAD: ${currentHead}`);
            
            // Check current branch and remote branches
            const branchInfo = await git.branch();
            const currentBranch = branchInfo.current;
            this.log(`Current branch: ${currentBranch}`);

            // Get remote info
            let remoteName = 'origin';
            this.log(`Using remote: ${remoteName}`);

            // Fetch from remote to get latest branch info
            await git.fetch(remoteName);
            
            // Handle uncommitted changes
            if (initialStatus.modified.length > 0 || initialStatus.not_added.length > 0) {
                this.log('Stashing uncommitted changes...');
                await git.stash();
                this.log('Changes stashed successfully');
            }

            try {
                // First try a simple merge
                this.log(`Attempting merge pull from ${currentBranch}...`);
                await git.raw(['config', 'pull.rebase', 'false']);
                const pullResult = await git.pull(remoteName, currentBranch, ['--no-rebase']);
                this.logPullResult(currentBranch, pullResult);
            } catch (error) {
                // If merge fails, try to handle divergent branches
                this.log('Simple merge failed, attempting to resolve divergent branches...');
                
                try {
                    // Get the remote branch's latest commit
                    const remoteBranch = `${remoteName}/${currentBranch}`;
                    await git.fetch(remoteName, currentBranch);
                    
                    // Create a temporary branch from the current state
                    const tempBranch = `temp-${Date.now()}`;
                    await git.checkout(['-b', tempBranch]);
                    
                    // Reset to remote branch
                    await git.reset(['--hard', remoteBranch]);
                    
                    // Return to original branch and merge
                    await git.checkout(currentBranch);
                    await git.merge([tempBranch]);
                    
                    // Clean up temp branch
                    await git.branch(['-D', tempBranch]);
                    
                    this.log('Successfully resolved divergent branches');
                } catch (mergeError) {
                    // If all attempts fail, abort any pending merge and reset
                    try {
                        await git.merge(['--abort']);
                    } catch (abortError) {
                        // Ignore abort errors
                    }
                    
                    throw new Error('Could not safely merge changes. Please resolve conflicts manually.');
                }
            }

            // Restore stashed changes if any
            if (initialStatus.modified.length > 0 || initialStatus.not_added.length > 0) {
                try {
                    this.log('Attempting to restore stashed changes...');
                    await git.stash(['pop']);
                    this.log('Stashed changes restored successfully');
                } catch (stashError) {
                    this.log('Warning: Failed to restore stashed changes. They remain in the stash.');
                    this.log(`Stash error: ${stashError instanceof Error ? stashError.message : 'Unknown error'}`);
                }
            }

            // Get final status and show changes
            const finalStatus = await git.status();
            this.logStatus('Final repository status:', finalStatus);

            // Show summary of changes
            const newHead = await git.revparse(['HEAD']);
            if (currentHead !== newHead) {
                const commitLog = await git.log({ from: currentHead, to: newHead });
                this.log(`\nUpdate Summary:`);
                this.log(`- ${commitLog.total} new commits pulled`);
                this.log(`- New HEAD: ${newHead}`);
                
                if (commitLog.total > 0) {
                    this.log('\nNew commits:');
                    commitLog.all.forEach(commit => {
                        this.log(`- ${commit.date.substring(0, 10)} | ${commit.hash.substring(0, 7)} | ${commit.message}`);
                    });
                }
            } else {
                this.log('\nRepository already up to date');
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.log(`Error during pull operation: ${errorMessage}`);
            throw new Error(`Failed to pull latest changes: ${errorMessage}`);
        }
    }

    async cloneRepository(repoUrl: string, repoPath: string): Promise<void> {
        try {
            this.log(`Cloning from: ${repoUrl}`);
            this.log(`Destination: ${repoPath}`);

            // Check if directory exists
            try {
                await fs.access(repoPath);
                
                // Directory exists, check if it's a git repo
                const git = simpleGit(repoPath);
                try {
                    await git.status();
                    this.log('Repository already exists and is valid');
                    await this.pullLatestChanges(repoPath);
                } catch (gitError) {
                    this.log('Directory exists but is not a git repository');
                    this.log('Removing directory contents...');
                    await fs.rm(repoPath, { recursive: true, force: true });
                    
                    // Now clone
                    this.log('Cloning repository...');
                    await this.git.clone(repoUrl, repoPath);
                }
            } catch (accessError) {
                // Directory doesn't exist - just clone
                this.log('Directory does not exist, cloning fresh...');
                await this.git.clone(repoUrl, repoPath);
            }
            
            // After clone, show the most recent commit changes
            const git = simpleGit(repoPath);
            try {
                const log = await git.log({ maxCount: 2 }); // Get last 2 commits
                if (log.all.length >= 2) {
                    // Show diff between last two commits
                    await this.showVisualDiff(repoPath, log.all[1].hash, log.all[0].hash);
                } else if (log.all.length === 1) {
                    // For first commit, show the complete changes
                    const firstCommit = log.all[0].hash;
                    await this.showVisualDiff(repoPath, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', firstCommit);
                }
            } catch (error) {
                this.log('Unable to show initial diff, continuing without diff view');
            }
            
            this.log('Clone/update operation completed successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.log(`Clone operation failed: ${errorMessage}`);
            throw new Error(`Failed to clone repository: ${errorMessage}`);
        }
    }

    private getRepoName(repoUrl: string): string {
        const match = repoUrl.match(/\/([^\/]+?)(\.git)?$/);
        if (!match) {
            this.log('Error: Invalid repository URL format');
            throw new Error('Invalid repository URL');
        }
        return match[1];
    }

    private logStatus(message: string, status: StatusResult): void {
        this.log(`\n${message}`);
        this.log('Modified files:', status.modified);
        this.log('Added files:', status.created);
        this.log('Deleted files:', status.deleted);
        this.log('Untracked files:', status.not_added);
        this.log('Staged files:', status.staged);
        if (status.conflicted.length > 0) {
            this.log('WARNING - Conflicted files:', status.conflicted);
        }
    }

    private logPullResult(branch: string, result: any): void {
        this.log(`Pull from ${branch} completed`);
        if (result.includes('Already up to date')) {
            this.log('Repository already up to date');
        } else {
            this.log('Pull changes:');
            this.log(`Pull result: ${result}`);
            // Get updated status to show changes
            simpleGit(this.workspacePath).status()
                .then(status => {
                    if (status.modified.length > 0) {
                        this.log('\nModified files:');
                        status.modified.forEach(file => {
                            this.log(`- ${file}`);
                        });
                    }
                })
                .catch(error => {
                    this.log('Error getting status after pull');
                });
        }
    }

    private log(message: string, items: string[] = []): void {
        if (items && items.length > 0) {
            this.outputChannel.appendLine(`${message} ${items.join(', ')}`);
        } else {
            this.outputChannel.appendLine(message);
        }
        this.outputChannel.show(true);
    }
}