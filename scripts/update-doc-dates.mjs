#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const getToday = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.DOC_DATE_TIMEZONE ?? 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const repositoryRoot = () => {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : process.cwd();
};

const hasHistory = (filePath, root) => {
  const relative = path.relative(root, filePath);
  const result = spawnSync('git', ['log', '--all', '--format=%H', '--', relative], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.trim().length > 0;
};

const updateFrontmatter = (raw, today, isNew) => {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)([\s\S]*)$/);
  if (!match) return `---\ncreated: ${today}\nupdated: ${today}\n---\n\n${raw}`;

  const [, frontmatter, body] = match;
  const lines = frontmatter.split(/\r?\n/).filter((line) => !/^\s*updated\s*:/.test(line));
  if (isNew && !lines.some((line) => /^\s*created\s*:/.test(line))) lines.unshift(`created: ${today}`);
  lines.push(`updated: ${today}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
};

const root = repositoryRoot();
const today = getToday();
for (const input of process.argv.slice(2)) {
  const filePath = path.resolve(root, input);
  if (!filePath.endsWith('.md') || !fs.existsSync(filePath)) continue;
  const raw = fs.readFileSync(filePath, 'utf8');
  const next = updateFrontmatter(raw, today, !hasHistory(filePath, root));
  if (next !== raw) fs.writeFileSync(filePath, next);
}
