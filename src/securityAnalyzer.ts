import * as fs from 'fs/promises';
import * as path from 'path';

export interface SecurityIssue {
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    line?: number;
    column?: number;
    suggestion: string;
}

export class SecurityAnalyzer {
    async analyzeFile(filePath: string): Promise<SecurityIssue[]> {
        const content = await fs.readFile(filePath, 'utf-8');
        const issues: SecurityIssue[] = [];

        // Run all security checks
        await Promise.all([
            this.checkSecrets(content, issues),
            this.checkVulnerableDependencies(filePath, issues),
            this.checkSecureConfigurations(content, issues),
            this.checkInputValidation(content, issues),
            this.checkAuthorizationIssues(content, issues)
        ]);

        return issues;
    }

    private async checkSecrets(content: string, issues: SecurityIssue[]): Promise<void> {
        const secretPatterns = [
            {
                pattern: /(api[_-]key|apikey|secret|password|credentials).*?[=:]\s*['"][^'"]*['"]/gi,
                message: 'Potential hardcoded secret detected'
            },
            {
                pattern: /(aws|firebase|oauth).*?[=:]\s*['"][^'"]*['"]/gi,
                message: 'Cloud service credentials potentially exposed'
            },
            {
                pattern: /(private[_-]key|ssh[_-]key).*?[=:]\s*['"][^'"]*['"]/gi,
                message: 'Private key potentially exposed'
            }
        ];

        content.split('\n').forEach((line, lineNumber) => {
            secretPatterns.forEach(({ pattern, message }) => {
                if (pattern.test(line)) {
                    issues.push({
                        type: 'secret-exposure',
                        severity: 'critical',
                        message,
                        line: lineNumber + 1,
                        suggestion: 'Move secrets to environment variables or use a secure secret management service'
                    });
                }
            });
        });
    }

    private async checkVulnerableDependencies(filePath: string, issues: SecurityIssue[]): Promise<void> {
        try {
            if (path.basename(filePath) === 'package.json') {
                const content = await fs.readFile(filePath, 'utf-8');
                const packageJson = JSON.parse(content);

                const vulnerablePackages = await this.checkDependencyVulnerabilities({
                    ...packageJson.dependencies,
                    ...packageJson.devDependencies
                });

                Object.entries(vulnerablePackages).forEach(([pkg, version]) => {
                    issues.push({
                        type: 'vulnerable-dependency',
                        severity: 'high',
                        message: `Package ${pkg}@${version} has known vulnerabilities`,
                        suggestion: 'Update to the latest secure version or find an alternative package'
                    });
                });
            }
        } catch (error) {
            console.error('Error checking dependencies:', error);
        }
    }

    private async checkSecureConfigurations(content: string, issues: SecurityIssue[]): Promise<void> {
        const insecureConfigs = [
            {
                pattern: /(ssl[_-]verify|verify[_-]ssl).*?:\s*false/gi,
                message: 'SSL verification disabled'
            },
            {
                pattern: /(debug|development)[_-]mode.*?:\s*true/gi,
                message: 'Debug/Development mode enabled'
            },
            {
                pattern: /allow[_-]all[_-]origins.*?:\s*true/gi,
                message: 'CORS configured to allow all origins'
            }
        ];

        content.split('\n').forEach((line, lineNumber) => {
            insecureConfigs.forEach(({ pattern, message }) => {
                if (pattern.test(line)) {
                    issues.push({
                        type: 'insecure-configuration',
                        severity: 'medium',
                        message,
                        line: lineNumber + 1,
                        suggestion: 'Review and restrict security configurations for production environments'
                    });
                }
            });
        });
    }

    private async checkInputValidation(content: string, issues: SecurityIssue[]): Promise<void> {
        const vulnerablePatterns = [
            {
                pattern: /eval\s*\(/g,
                message: 'Use of eval() detected'
            },
            {
                pattern: /innerHTML\s*=/g,
                message: 'Direct innerHTML manipulation detected'
            },
            {
                pattern: /document\.write\s*\(/g,
                message: 'Use of document.write() detected'
            }
        ];

        content.split('\n').forEach((line, lineNumber) => {
            vulnerablePatterns.forEach(({ pattern, message }) => {
                if (pattern.test(line)) {
                    issues.push({
                        type: 'input-validation',
                        severity: 'high',
                        message,
                        line: lineNumber + 1,
                        suggestion: 'Use safer alternatives and implement proper input validation'
                    });
                }
            });
        });
    }

    private async checkAuthorizationIssues(content: string, issues: SecurityIssue[]): Promise<void> {
        const authIssues = [
            {
                pattern: /role\s*===?\s*['"]admin['"]/g,
                message: 'Hardcoded role check detected'
            },
            {
                pattern: /auth\s*\.\s*skip/g,
                message: 'Authentication bypass detected'
            }
        ];

        content.split('\n').forEach((line, lineNumber) => {
            authIssues.forEach(({ pattern, message }) => {
                if (pattern.test(line)) {
                    issues.push({
                        type: 'authorization',
                        severity: 'high',
                        message,
                        line: lineNumber + 1,
                        suggestion: 'Implement proper role-based access control and authentication checks'
                    });
                }
            });
        });
    }

    private async checkDependencyVulnerabilities(dependencies: { [key: string]: string }): Promise<{ [key: string]: string }> {
        const vulnerablePackages: { [key: string]: string } = {};
        
        // Check for potentially vulnerable version patterns
        Object.entries(dependencies).forEach(([pkg, version]) => {
            if (version.startsWith('^') || version.startsWith('~')) {
                vulnerablePackages[pkg] = version;
            }
            // Check for known vulnerable versions (example)
            if (version === '1.0.0' || version.includes('alpha') || version.includes('beta')) {
                vulnerablePackages[pkg] = version;
            }
        });
        
        return vulnerablePackages;
    }
}