#!/usr/bin/env node
// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Dependency-free lint: syntax-checks every JavaScript file, parses every JSON file and enforces the
 * repository rules: the license header on every code file, no secrets, no email addresses outside
 * example.com, no tabs or trailing spaces, no console output in src/core, and first-person singular docs.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'data', 'coverage']);
export const LICENSE_LINE = 'DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.';

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

const SECRET_RULES = [
  { test: /pat-(?:na|eu|ap)\d-[0-9a-f-]{20,}/i, message: 'looks like a HubSpot private app token' },
  { test: /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/, message: 'looks like an Airtable personal access token' },
  { test: /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}/, message: 'looks like a Slack webhook URL' },
  { test: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}\b/, message: 'contains an email address outside example.com' },
];
const DOC_RULES = [
  { test: /\b(?:we|our|ours|we're|we've)\b/i, message: 'uses plural first person (write "I" and "my")' },
  { test: /\bus\b/, message: 'uses plural first person (write "me")' },
  { test: new RegExp(['meti', 'culous'].join(''), 'i'), message: 'uses a banned word' },
];

export function lint() {
  const problems = [];
  for (const path of walk(ROOT)) {
    const rel = relative(ROOT, path);
    const content = readFileSync(path, 'utf8');
    if (rel.endsWith('.js')) {
      try { execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' }); } catch (error) { problems.push(`${rel}: syntax error\n${error.stderr}`); }
      if (!content.split('\n').slice(0, 3).some((line) => line === `// ${LICENSE_LINE}`)) problems.push(`${rel}: missing the license header line`);
      if (rel.startsWith('src/core/') && /\bconsole\.(?:log|error|warn|info)\(/.test(content)) problems.push(`${rel}: console output inside src/core`);
    }
    if (rel.endsWith('.json')) {
      try { JSON.parse(content); } catch (error) { problems.push(`${rel}: invalid JSON (${error.message})`); }
    }
    if (rel !== 'workflow.json') {
      content.split('\n').forEach((line, index) => {
        if (/\t/.test(line)) problems.push(`${rel}:${index + 1}: tab character`);
        if (/[ \t]+$/.test(line)) problems.push(`${rel}:${index + 1}: trailing whitespace`);
      });
    }
    if (!content.includes(LICENSE_LINE)) problems.push(`${rel}: does not reference the disclaimer line`);
    for (const rule of SECRET_RULES) if (rule.test.test(content)) problems.push(`${rel}: ${rule.message}`);
    if (rel.endsWith('.md')) {
      const prose = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
      for (const rule of DOC_RULES) if (rule.test.test(prose)) problems.push(`${rel}: ${rule.message}`);
    }
  }
  return problems;
}

if (process.argv[1] && process.argv[1].endsWith('lint.js')) {
  const problems = lint();
  if (problems.length) {
    console.error(`${problems.join('\n')}\n\n${problems.length} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log('lint: no problems');
  }
}
