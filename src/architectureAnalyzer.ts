import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

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

interface DirectoryStructure {
    name: string;
    type: 'file' | 'directory';
    children?: DirectoryStructure[];
    path: string;
}

export class ArchitectureAnalyzer {
    async analyzeStructure(rootPath: string): Promise<ArchitectureResult> {
        const result: ArchitectureResult = {
            patterns: [],
            suggestions: [],
            dependencies: []
        };

        try {
            // Build directory tree
            const structure = await this.buildDirectoryTree(rootPath);
            
            // Perform various analyses
            await Promise.all([
                this.analyzeProjectStructure(structure, result),
                this.analyzeDependencies(rootPath, result),
                this.detectArchitecturalPatterns(structure, result),
                this.analyzeLayering(structure, result)
            ]);

        } catch (error) {
            console.error('Error in architecture analysis:', error);
        }

        return result;
    }

    private async buildDirectoryTree(dirPath: string): Promise<DirectoryStructure> {
        const name = path.basename(dirPath);
        const structure: DirectoryStructure = {
            name,
            type: 'directory',
            children: [],
            path: dirPath
        };

        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (this.shouldSkipEntry(entry.name)) {
                continue;
            }

            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                structure.children?.push(await this.buildDirectoryTree(fullPath));
            } else {
                structure.children?.push({
                    name: entry.name,
                    type: 'file',
                    path: fullPath
                });
            }
        }

        return structure;
    }

    private shouldSkipEntry(name: string): boolean {
        const skipPatterns = [
            'node_modules',
            '.git',
            'dist',
            'build',
            'coverage',
            '.next',
            '.vscode'
        ];
        return skipPatterns.includes(name) || name.startsWith('.');
    }

    private async analyzeProjectStructure(
        structure: DirectoryStructure,
        result: ArchitectureResult
    ): Promise<void> {
        // Check for common architectural folders
        const commonFolders = ['src', 'test', 'docs', 'config'];
        const missingFolders = commonFolders.filter(folder => 
            !structure.children?.some(child => 
                child.type === 'directory' && child.name === folder
            )
        );

        if (missingFolders.length > 0) {
            result.suggestions.push({
                type: 'structure',
                message: `Missing common directories: ${missingFolders.join(', ')}`,
                impact: 'medium',
                suggestion: 'Consider adding standard project directories for better organization'
            });
        }

        // Check source code organization
        const srcDir = structure.children?.find(child => 
            child.type === 'directory' && child.name === 'src'
        );

        if (srcDir) {
            await this.analyzeSrcStructure(srcDir, result);
        }
    }

    private async analyzeSrcStructure(
        srcStructure: DirectoryStructure,
        result: ArchitectureResult
    ): Promise<void> {
        // Check for feature-based vs. layer-based organization
        const children = srcStructure.children || [];
        const layerBased = children.some(child => 
            ['controllers', 'services', 'models', 'views'].includes(child.name)
        );
        const featureBased = children.some(child => 
            ['features', 'modules', 'domains'].includes(child.name)
        );

        if (!layerBased && !featureBased) {
            result.suggestions.push({
                type: 'organization',
                message: 'No clear architectural organization pattern detected',
                impact: 'high',
                suggestion: 'Consider organizing code by features or layers'
            });
        }
    }

    private async analyzeDependencies(
        rootPath: string,
        result: ArchitectureResult
    ): Promise<void> {
        const dependencies: Map<string, Set<string>> = new Map();
        const files = await vscode.workspace.findFiles(
            '{**/*.ts,**/*.js,**/*.jsx,**/*.tsx}',
            '**/node_modules/**'
        );

        // Build dependency graph
        for (const file of files) {
            const content = await fs.readFile(file.fsPath, 'utf-8');
            const imports = this.extractImports(content);
            const relativePath = path.relative(rootPath, file.fsPath);

            dependencies.set(relativePath, new Set(imports));
        }

        // Detect circular dependencies
        const circularDeps = this.findCircularDependencies(dependencies);
        
        // Add dependency information to result
        for (const [module, deps] of dependencies) {
            result.dependencies.push({
                module,
                usedBy: Array.from(this.findUsages(module, dependencies)),
                dependencies: Array.from(deps),
                circular: circularDeps.has(module)
            });
        }
    }

    private extractImports(content: string): string[] {
        const imports: string[] = [];
        const importRegex = /import.*?from\s+['"](.+?)['"]/g;
        let match;

        while ((match = importRegex.exec(content)) !== null) {
            imports.push(match[1]);
        }

        return imports;
    }

    private findCircularDependencies(
        dependencies: Map<string, Set<string>>
    ): Set<string> {
        const circular = new Set<string>();
        
        for (const [module] of dependencies) {
            if (this.isCircular(module, new Set(), dependencies)) {
                circular.add(module);
            }
        }

        return circular;
    }

    private isCircular(
        module: string,
        visited: Set<string>,
        dependencies: Map<string, Set<string>>
    ): boolean {
        if (visited.has(module)) {
            return true;
        }

        visited.add(module);
        const deps = dependencies.get(module) || new Set();

        for (const dep of deps) {
            if (this.isCircular(dep, new Set(visited), dependencies)) {
                return true;
            }
        }

        return false;
    }

    private findUsages(
        module: string,
        dependencies: Map<string, Set<string>>
    ): Set<string> {
        const usages = new Set<string>();

        for (const [m, deps] of dependencies) {
            if (deps.has(module)) {
                usages.add(m);
            }
        }

        return usages;
    }

    private async detectArchitecturalPatterns(
        structure: DirectoryStructure,
        result: ArchitectureResult
    ): Promise<void> {
        // Detect MVC pattern
        if (await this.detectMVCPattern(structure)) {
            result.patterns.push({
                type: 'MVC',
                description: 'Model-View-Controller pattern detected',
                files: await this.findMVCFiles(structure),
                confidence: 0.8
            });
        }

        // Detect Clean Architecture
        if (await this.detectCleanArchitecture(structure)) {
            result.patterns.push({
                type: 'Clean Architecture',
                description: 'Clean Architecture pattern detected',
                files: await this.findCleanArchitectureFiles(structure),
                confidence: 0.7
            });
        }

        // Detect Microservices
        if (await this.detectMicroservices(structure)) {
            result.patterns.push({
                type: 'Microservices',
                description: 'Microservices architecture detected',
                files: await this.findMicroservicesFiles(structure),
                confidence: 0.9
            });
        }
    }

    private async detectMVCPattern(structure: DirectoryStructure): Promise<boolean> {
        const hasMVCFolders = structure.children?.some(child =>
            ['controllers', 'models', 'views'].every(folder =>
                structure.children?.some(c => c.name === folder)
            )
        );

        return !!hasMVCFolders;
    }

    private async findMVCFiles(structure: DirectoryStructure): Promise<string[]> {
        const mvcFiles: string[] = [];
        
        const findInDirectory = (dir: DirectoryStructure) => {
            dir.children?.forEach(child => {
                if (child.type === 'file') {
                    if (/Controller\.ts$/.test(child.name) ||
                        /Model\.ts$/.test(child.name) ||
                        /View\.tsx?$/.test(child.name)) {
                        mvcFiles.push(child.path);
                    }
                } else if (child.type === 'directory') {
                    findInDirectory(child);
                }
            });
        };

        findInDirectory(structure);
        return mvcFiles;
    }

    private async detectCleanArchitecture(structure: DirectoryStructure): Promise<boolean> {
        const cleanArchFolders = [
            'entities',
            'usecases',
            'interfaces',
            'infrastructure'
        ];

        return cleanArchFolders.every(folder =>
            structure.children?.some(child =>
                child.name.toLowerCase().includes(folder)
            )
        );
    }

    private async findCleanArchitectureFiles(structure: DirectoryStructure): Promise<string[]> {
        const files: string[] = [];
        
        const findInDirectory = (dir: DirectoryStructure) => {
            dir.children?.forEach(child => {
                if (child.type === 'file') {
                    if (/Entity\.ts$/.test(child.name) ||
                        /UseCase\.ts$/.test(child.name) ||
                        /Repository\.ts$/.test(child.name) ||
                        /Service\.ts$/.test(child.name)) {
                        files.push(child.path);
                    }
                } else if (child.type === 'directory') {
                    findInDirectory(child);
                }
            });
        };

        findInDirectory(structure);
        return files;
    }

    private async detectMicroservices(structure: DirectoryStructure): Promise<boolean> {
        // Check for multiple service directories
        const serviceCount = structure.children?.filter(child =>
            child.type === 'directory' &&
            (child.name.endsWith('-service') || child.name.endsWith('-api'))
        ).length || 0;

        // Check for docker-compose.yml
        const hasDockerCompose = structure.children?.some(child =>
            child.type === 'file' && child.name === 'docker-compose.yml'
        );

        return Boolean(serviceCount > 1 && hasDockerCompose);
    }

    private async findMicroservicesFiles(structure: DirectoryStructure): Promise<string[]> {
        const files: string[] = [];
        
        const findInDirectory = (dir: DirectoryStructure) => {
            dir.children?.forEach(child => {
                if (child.type === 'file') {
                    if (child.name === 'Dockerfile' ||
                        child.name === 'docker-compose.yml' ||
                        /service\.ts$/.test(child.name)) {
                        files.push(child.path);
                    }
                } else if (child.type === 'directory') {
                    findInDirectory(child);
                }
            });
        };

        findInDirectory(structure);
        return files;
    }

    private async analyzeLayering(
        structure: DirectoryStructure,
        result: ArchitectureResult
    ): Promise<void> {
        // Check for proper layering and dependency rules
        const layers = ['presentation', 'application', 'domain', 'infrastructure'];
        const foundLayers = new Set<string>();

        const findLayers = (dir: DirectoryStructure) => {
            dir.children?.forEach(child => {
                if (child.type === 'directory') {
                    const layerName = layers.find(layer => 
                        child.name.toLowerCase().includes(layer)
                    );
                    if (layerName) {
                        foundLayers.add(layerName);
                    }
                    findLayers(child);
                }
            });
        };

        findLayers(structure);

        if (foundLayers.size > 0 && foundLayers.size < layers.length) {
            const missingLayers = layers.filter(layer => !foundLayers.has(layer));
            result.suggestions.push({
                type: 'layering',
                message: `Incomplete layering: missing ${missingLayers.join(', ')}`,
                impact: 'medium',
                suggestion: 'Consider implementing a complete layered architecture'
            });
        }
    }
}

export interface ArchitectureResult {
    patterns: ArchitecturePattern[];
    suggestions: ArchitectureSuggestion[];
    dependencies: DependencyInfo[];
}