import assert from 'node:assert/strict';
import test from 'node:test';
import { jobEntityTag, matchesEntityTag } from '../lib/rail-http-cache.ts';

test('unchanged job survives strong, weak and multiple CDN entity tags', () => {
  const tag = jobEntityTag('job-1', 2, '2026-10-05T15:00:00.000Z', true);
  assert.equal(matchesEntityTag(tag, tag), true);
  assert.equal(matchesEntityTag(tag.slice(2), tag), true);
  assert.equal(matchesEntityTag(`"old", ${tag}, "other"`, tag), true);
  assert.equal(matchesEntityTag(' * ', tag), true);
  assert.equal(matchesEntityTag(null, tag), false);
  assert.equal(matchesEntityTag('W/invalid', tag), false);
  assert.equal(matchesEntityTag(`${tag}suffix`, tag), false);
});

test('job changes and distinct response representations require a new body', () => {
  const tag = jobEntityTag('job-1', 2, '2026-10-05T15:00:00.000Z', true);
  for (const changed of [
    jobEntityTag('job-2', 2, '2026-10-05T15:00:00.000Z', true),
    jobEntityTag('job-1', 3, '2026-10-05T15:00:00.000Z', true),
    jobEntityTag('job-1', 2, '2026-10-05T15:00:01.000Z', true),
    jobEntityTag('job-1', 2, '2026-10-05T15:00:00.000Z', false),
  ]) assert.equal(matchesEntityTag(tag, changed), false);
});
