import assert from 'node:assert/strict';
import test from 'node:test';
import { extractWikilinks } from '../src/lib/markdown.mjs';
import { resolveTarget } from '../src/lib/doc-index.mjs';
import { normalizeTag } from '../src/lib/tags.mjs';

test('normalizes tags to lower kebab-case', () => {
  assert.equal(normalizeTag('  PostgreSQL_design  '), 'postgresql-design');
  assert.equal(normalizeTag('Static Site'), 'static-site');
});

test('resolves a wikilink in repository-first order', () => {
  const ids = new Set(['_shared/0001-auth', 'api/0001-auth', 'api/0002-client']);
  assert.equal(resolveTarget('0001-auth', 'api', ids), 'api/0001-auth');
  assert.equal(resolveTarget('0001-auth', 'worker', ids), '_shared/0001-auth');
  assert.equal(resolveTarget('api/0002-client', 'worker', ids), 'api/0002-client');
  assert.equal(resolveTarget('missing', 'api', ids), undefined);
});

test('does not extract wikilinks from code or math', () => {
  const links = extractWikilinks([
    '本文 [[0001-real]]',
    '`[[0002-inline-code]]`',
    '```text',
    '[[0003-code-block]]',
    '```',
    '$[[0004-math]]$',
  ].join('\n'));
  assert.deepEqual(links.map(({ target }) => target), ['0001-real']);
});
