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

        try {
            // Check if directory exists
            await fs.access(repoPath, fs.constants.R_OK);
            
            // Check if it's a git repository
            const git = simpleGit(repoPath);
            try {
                await git.status(); // Verify it's a git repo
                
                // Existing repository found, fetch latest changes
                this.log(`\n=== Starting update for existing repository: ${repoName} ===`);
                this.log(`Repository path: ${repoPath}`);
                
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Updating Repository",
                    cancellable: false
                }, async (progress) => {
                    // Save current HEAD for later comparison
                    const currentHead = await git.revparse(['HEAD']);
                    this.log(`Current HEAD: ${currentHead}`);

                    // Fetch all branches and tags
                    progress.report({ message: 'Fetching latest changes...' });
                    await git.fetch(['--all', '--prune']);
                    this.log('Fetched all branches and tags');

                    // Pull latest changes
                    progress.report({ message: 'Pulling latest changes...' });
                    await this.pullLatestChanges(repoPath);
                    
                    // Get new HEAD after pull
                    const newHead = await git.revparse(['HEAD']);
                    this.log(`New HEAD: ${newHead}`);

                    // Show diff if changes were pulled
                    if (currentHead !== newHead) {
                        this.log('Changes detected, generating diff...');
                        progress.report({ message: 'Generating diff view...' });
                        await this.showVisualDiff(repoPath, currentHead, newHead);
                    } else {
                        this.log('No new changes to analyze');
                    }

                    progress.report({ message: 'Repository updated successfully!' });
                });
                
            } catch (gitError) {
                // Directory exists but not a git repository - ask user what to do
                const choice = await vscode.window.showQuickPick(
                    ['Clone Here', 'Clone in New Location', 'Cancel'],
                    { placeHolder: 'Directory exists but is not a git repository. What would you like to do?' }
                );

                if (choice === 'Cancel') {
                    throw new Error('Operation cancelled by user');
                }

                if (choice === 'Clone in New Location') {
                    const result = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        title: 'Select Clone Location'
                    });

                    if (!result || result.length === 0) {
                        throw new Error('No directory selected');
                    }

                    repoPath = path.join(result[0].fsPath, repoName);
                }

                // Clear existing directory if cloning here
                if (choice === 'Clone Here') {
                    await fs.rm(repoPath, { recursive: true, force: true });
                }

                await this.cloneRepository(repoUrl, repoPath);
                
                // If we're cloning to a new location, open in new window
                if (choice === 'Clone in New Location') {
                    // Store diff information before switching workspace
                    const git = simpleGit(repoPath);
                    const currentHead = await git.revparse(['HEAD']);
                    // Use the parent commit as the old version
                    const oldHead = await git.revparse(['HEAD^']) || currentHead;
                    
                    // Create diff files before switching workspace
                    await this.showVisualDiff(repoPath, oldHead, currentHead);
                    
                    // Now switch workspace
                    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repoPath));
                    throw new Error('WORKSPACE_SWITCHED');
                }
            }
        } catch (error) {
            if (error instanceof Error && error.message === 'WORKSPACE_SWITCHED') {
                throw error;
            }

            // Directory doesn't exist - clone fresh
            this.log('Directory does not exist. Cloning fresh...');
            await fs.mkdir(path.dirname(repoPath), { recursive: true });
            await this.cloneRepository(repoUrl, repoPath);

            // Store diff information before switching workspace
            const git = simpleGit(repoPath);
            const currentHead = await git.revparse(['HEAD']);
            // Use the parent commit as the old version
            const oldHead = await git.revparse(['HEAD^']) || currentHead;
            
            // Create diff files before switching workspace
            await this.showVisualDiff(repoPath, oldHead, currentHead);

            // Handle workspace switching
            if (!vscode.workspace.workspaceFolders) {
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repoPath));
                throw new Error('WORKSPACE_SWITCHED');
            } else {
                await vscode.workspace.updateWorkspaceFolders(
                    vscode.workspace.workspaceFolders.length,
                    null,
                    { uri: vscode.Uri.file(repoPath) }
                );
            }
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
            // Get the contents
            const oldContent = await git.show([oldCommit]);
            const newContent = await git.show([newCommit]);
            
            // Create in-memory URIs instead of file URIs
            const oldUri = vscode.Uri.parse(
                `git:${path.join(repoPath, 'OLD_VERSION')}?${oldCommit}`
            );
            const newUri = vscode.Uri.parse(
                `git:${path.join(repoPath, 'NEW_VERSION')}?${newCommit}`
            );

            // Register content provider for our scheme
            const contentProvider = new class implements vscode.TextDocumentContentProvider {
                private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
                
                provideTextDocumentContent(uri: vscode.Uri): string {
                    return uri.query === oldCommit ? oldContent : newContent;
                }
                
                get onDidChange(): vscode.Event<vscode.Uri> {
                    return this._onDidChange.event;
                }
            };

            // Register the provider
            const registration = vscode.workspace.registerTextDocumentContentProvider(
                'git',
                contentProvider
            );

            // Show diff
            await vscode.commands.executeCommand('vscode.diff',
                oldUri,
                newUri,
                `Changes: ${oldCommit.substring(0, 7)} ↔ ${newCommit.substring(0, 7)}`,
                {
                    preview: true,
                    viewColumn: vscode.ViewColumn.Two
                }
            );

            // Cleanup registration when diff is closed
            const disposable = vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
                const diffStillOpen = editors.some(editor => 
                    editor.document.uri.scheme === 'git' &&
                    (editor.document.uri.query === oldCommit || 
                     editor.document.uri.query === newCommit)
                );
                
                if (!diffStillOpen) {
                    registration.dispose();
                    disposable.dispose();
                }
            });

        } catch (error) {
            this.log(`Error showing visual diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
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
                    // Try to get git status to verify it's a git repo
                    await git.status();
                    this.log('Repository already exists and is valid');
                    
                    // Update the repo instead of cloning
                    await this.pullLatestChanges(repoPath);
                } catch (gitError) {
                    // Not a git repo - remove directory and clone fresh
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