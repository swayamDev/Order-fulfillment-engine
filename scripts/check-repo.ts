// Repository hygiene checks that run in CI on every push.
// 1. No em dash characters in any tracked file.
// 2. No AI or agent configuration files are tracked.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EM_DASH = String.fromCodePoint(0x2014);
const FORBIDDEN_PATHS = [/(^|\/)CLAUDE\.md$/i, /(^|\/)AGENTS\.md$/i, /(^|\/)\.claude\//];
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip)$/i;

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((path) => path.length > 0);

const problems: string[] = [];

for (const path of tracked) {
  if (FORBIDDEN_PATHS.some((pattern) => pattern.test(path))) {
    problems.push(`${path}: AI or agent configuration files must not be committed`);
    continue;
  }
  if (BINARY_EXTENSIONS.test(path)) continue;

  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (line.includes(EM_DASH)) {
      problems.push(`${path}:${index + 1}: contains an em dash`);
    }
  });
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}

console.log(`Checked ${tracked.length} tracked files: no em dashes, no AI config files.`);
