import * as fs from 'fs/promises';
import * as path from 'path';

export interface OptimizationSuggestion {
    type: string;
    message: string;
    line?: number;
    suggestion: string;
    impact: 'low' | 'medium' | 'high';
}

export class CodeOptimizer {
    async analyzeCode(filePath: string): Promise<{ suggestions: OptimizationSuggestion[] }> {
        const content = await fs.readFile(filePath, 'utf-8');
        const suggestions: OptimizationSuggestion[] = [];

        await Promise.all([
            this.analyzeComplexity(content, suggestions),
            this.checkPerformance(content, suggestions),
            this.checkMemoryUsage(content, suggestions),
            this.checkCodeDuplication(content, suggestions),
            this.checkBestPractices(content, suggestions)
        ]);

        return { suggestions };
    }

    async analyzePatch(content: string): Promise<OptimizationSuggestion[]> {
        const suggestions: OptimizationSuggestion[] = [];
        
        // Analyze the changed code snippet
        await Promise.all([
            this.analyzeComplexity(content, suggestions),
            this.checkPerformance(content, suggestions),
            this.checkBestPractices(content, suggestions)
        ]);

        return suggestions
    }

    private async analyzeComplexity(content: string, suggestions: OptimizationSuggestion[]): Promise<void> {
        const lines = content.split('\n');
        
        // Check function length
        let functionLines = 0;
        let functionStart = -1;
        let nestingLevel = 0;
        let maxNestingLevel = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Function detection
            if (line.match(/^(function|async function|\w+\s*=\s*function|\w+\s*=\s*async function)/)) {
                functionStart = i;
                functionLines = 0;
            }

            // Count nesting level
            if (line.includes('{')) nestingLevel++;
            if (line.includes('}')) {
                nestingLevel--;
                
                if (functionStart !== -1 && nestingLevel === 0) {
                    if (functionLines > 30) {
                        suggestions.push({
                            type: 'complexity',
                            message: `Long function detected (${functionLines} lines)`,
                            line: functionStart,
                            suggestion: 'Consider breaking this function into smaller, more focused functions',
                            impact: 'medium'
                        });
                    }
                    functionStart = -1;
                }
            }

            maxNestingLevel = Math.max(maxNestingLevel, nestingLevel);
            if (functionStart !== -1) functionLines++;
        }

        // Check excessive nesting
        if (maxNestingLevel > 4) {
            suggestions.push({
                type: 'complexity',
                message: `High nesting level detected (${maxNestingLevel} levels)`,
                suggestion: 'Consider refactoring to reduce nesting using early returns or separate functions',
                impact: 'high'
            });
        }
    }

    private async checkPerformance(content: string, suggestions: OptimizationSuggestion[]): Promise<void> {
        const performancePatterns = [
            {
                pattern: /\.[a-zA-Z]+\((.*?)\)\.map\((.*?)\)\.filter\((.*?)\)/,
                message: 'Chained array operations detected',
                suggestion: 'Consider combining map and filter operations to reduce iterations'
            },
            {
                pattern: /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*array\.length\s*;\s*i\+\+\s*\)/,
                message: 'Array.length called in every loop iteration',
                suggestion: 'Cache array.length before the loop for better performance'
            },
            {
                pattern: /console\.(log|debug|info|warn|error)/,
                message: 'Console statement detected',
                suggestion: 'Remove console statements in production code or use a logging library'
            }
        ];

        for (const [index, line] of content.split('\n').entries()) {
            for (const { pattern, message, suggestion } of performancePatterns) {
                if (pattern.test(line)) {
                    suggestions.push({
                        type: 'performance',
                        message,
                        line: index + 1,
                        suggestion,
                        impact: 'medium'
                    });
                }
            }
        }
    }

    private async checkMemoryUsage(content: string, suggestions: OptimizationSuggestion[]): Promise<void> {
        const memoryPatterns = [
            {
                pattern: /new\s+Array\(\d+\)/,
                message: 'Large array pre-allocation',
                suggestion: 'Consider using more memory-efficient data structures or pagination'
            },
            {
                pattern: /\.[a-zA-Z]+\((.*?)\)\.concat\((.*?)\)/,
                message: 'Array concatenation in loop detected',
                suggestion: 'Use array spreading or push() for better memory efficiency'
            }
        ];

        for (const [index, line] of content.split('\n').entries()) {
            for (const { pattern, message, suggestion } of memoryPatterns) {
                if (pattern.test(line)) {
                    suggestions.push({
                        type: 'memory',
                        message,
                        line: index + 1,
                        suggestion,
                        impact: 'medium'
                    });
                }
            }
        }
    }

    private async checkCodeDuplication(content: string, suggestions: OptimizationSuggestion[]): Promise<void> {
        const lines = content.split('\n');
        const duplicateLines = new Map<string, number[]>();

        // Simple duplicate line detection
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.length > 30) { // Only check substantial lines
                if (!duplicateLines.has(line)) {
                    duplicateLines.set(line, [i]);
                } else {
                    duplicateLines.get(line)?.push(i);
                }
            }
        }

        // Report duplicates
        for (const [line, occurrences] of duplicateLines.entries()) {
            if (occurrences.length > 1) {
                suggestions.push({
                    type: 'duplication',
                    message: `Duplicate code found in lines ${occurrences.join(', ')}`,
                    suggestion: 'Consider extracting duplicated code into a reusable function',
                    impact: 'medium'
                });
            }
        }
    }

    private async checkBestPractices(content: string, suggestions: OptimizationSuggestion[]): Promise<void> {
        const bestPracticePatterns = [
            {
                pattern: /var\s+/,
                message: 'Use of var keyword detected',
                suggestion: 'Use const or let instead of var for better scoping'
            },
            {
                pattern: /==(?!=)/,
                message: 'Use of loose equality operator',
                suggestion: 'Use strict equality operator (===) for type-safe comparisons'
            },
            {
                pattern: /!\w+\s*===/,
                message: 'Negative comparison pattern detected',
                suggestion: 'Consider using positive conditions for better readability'
            }
        ];

        for (const [index, line] of content.split('\n').entries()) {
            for (const { pattern, message, suggestion } of bestPracticePatterns) {
                if (pattern.test(line)) {
                    suggestions.push({
                        type: 'best-practice',
                        message,
                        line: index + 1,
                        suggestion,
                        impact: 'low'
                    });
                }
            }
        }
    }
}