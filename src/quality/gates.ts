import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface GateCheckResult {
  name: string;
  pass: boolean;
  output: string;
  command?: string;
}

export interface QualityGateResult {
  passed: boolean;
  checks: GateCheckResult[];
}

function runCommand(command: string, cwd: string, timeoutMs = 120_000): GateCheckResult {
  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { name: command, pass: true, output: output.trim(), command };
  } catch (err: any) {
    const stdout = err?.stdout?.toString?.() ?? '';
    const stderr = err?.stderr?.toString?.() ?? '';
    const output = [stdout, stderr].filter(Boolean).join('\n').trim() || err?.message || 'failed';
    return { name: command, pass: false, output, command };
  }
}

function hasScript(cwd: string, scriptName: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    return typeof pkg?.scripts?.[scriptName] === 'string';
  } catch {
    return false;
  }
}

export function runQualityGate(cwd = process.cwd()): QualityGateResult {
  const checks: GateCheckResult[] = [];

  const gitCheck = runCommand('git rev-parse --is-inside-work-tree', cwd, 5000);
  const inGit = gitCheck.pass;
  if (inGit) {
    const dirty = runCommand('git status --porcelain', cwd, 8000);
    checks.push({
      name: 'git-clean',
      pass: dirty.pass && dirty.output.trim().length === 0,
      output: dirty.output || '(clean)',
      command: 'git status --porcelain',
    });
  }

  if (hasScript(cwd, 'typecheck')) {
    const r = runCommand('npm run -s typecheck', cwd);
    checks.push({ name: 'typecheck', pass: r.pass, output: r.output, command: r.command });
  }

  if (hasScript(cwd, 'lint')) {
    const r = runCommand('npm run -s lint', cwd);
    checks.push({ name: 'lint', pass: r.pass, output: r.output, command: r.command });
  }

  if (hasScript(cwd, 'test')) {
    const r = runCommand('npm run -s test', cwd);
    checks.push({ name: 'test', pass: r.pass, output: r.output, command: r.command });
  }

  if (hasScript(cwd, 'build')) {
    const r = runCommand('npm run -s build', cwd);
    checks.push({ name: 'build', pass: r.pass, output: r.output, command: r.command });
  }

  return { passed: checks.every(c => c.pass), checks };
}
