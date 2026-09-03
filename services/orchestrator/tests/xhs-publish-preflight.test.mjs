import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUBLISH_LIMITS,
  normalizePublishTags,
  appendTagsToBody,
  validatePublishContent,
  assertDecodableImage
} from '../scripts/lib/xhs-publish-preflight.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('limits match authoritative xhs.publish.edit_dry_run inputSchema (drift guard)', () => {
  const capabilities = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'control-plane', 'apps', 'xhs', 'capabilities.json'), 'utf8')
  );
  const cap = (capabilities.capabilities || capabilities).find((c) => c.id === 'xhs.publish.edit_dry_run');
  assert.ok(cap, 'edit_dry_run capability 必须存在');
  const props = cap.inputSchema.properties;
  assert.equal(props.title.maxLength, PUBLISH_LIMITS.titleMax);
  assert.equal(props.body.maxLength, PUBLISH_LIMITS.bodyMax);
  assert.equal(props.tags.maxItems, PUBLISH_LIMITS.tagsMax);
  assert.equal(props.tags.items.maxLength, PUBLISH_LIMITS.tagMax);
  assert.equal(props.imageCount.minimum, PUBLISH_LIMITS.imageMin);
  assert.equal(props.imageCount.maximum, PUBLISH_LIMITS.imageMax);
});

test('normalizePublishTags / appendTagsToBody match adapter semantics', () => {
  assert.deepEqual(normalizePublishTags([' #a ', 'b', '', '##c']), ['a', 'b', 'c']);
  assert.equal(appendTagsToBody('正文', ['a', 'b']), '正文 #a #b');
  assert.equal(appendTagsToBody('正文', []), '正文');
});

test('legal content passes and returns fullBodyText', () => {
  const { fullBodyText } = validatePublishContent({
    title: '二十字以内的合法标题', // 9 字
    body: '正文内容',
    tags: ['a', 'b'],
    imageCount: 2
  });
  assert.equal(fullBodyText, '正文内容 #a #b');
});

test('title 21 chars fails with titleInvalid (no truncation)', () => {
  assert.throws(
    () => validatePublishContent({ title: '一'.repeat(21), body: 'x', tags: [], imageCount: 1 }),
    /titleInvalid/
  );
});

test('body 301 chars fails with bodyInvalid (no truncation)', () => {
  assert.throws(
    () => validatePublishContent({ title: 't', body: '字'.repeat(301), tags: [], imageCount: 1 }),
    /bodyInvalid/
  );
});

test('tags pushing fullBodyText over 300 fails even though raw body is under', () => {
  // raw body 290 + tags 拼 15 字 > 300 → adapter 会 bodyInvalid，预检也必须拦
  assert.throws(
    () => validatePublishContent({ title: 't', body: '字'.repeat(290), tags: ['x'.repeat(14)], imageCount: 1 }),
    /bodyInvalid/
  );
});

test('11 tags fails with tagsInvalid', () => {
  assert.throws(
    () => validatePublishContent({ title: 't', body: 'x', tags: Array.from({ length: 11 }, (_, i) => `tag${i}`), imageCount: 1 }),
    /tagsInvalid/
  );
});

test('31-char tag fails with tagsInvalid', () => {
  assert.throws(
    () => validatePublishContent({ title: 't', body: 'x', tags: ['y'.repeat(31)], imageCount: 1 }),
    /tagsInvalid/
  );
});

test('imageCount 0 and 10 fail with imageCountInvalid', () => {
  assert.throws(
    () => validatePublishContent({ title: 't', body: 'x', tags: [], imageCount: 0 }),
    /imageCountInvalid/
  );
  assert.throws(
    () => validatePublishContent({ title: 't', body: 'x', tags: [], imageCount: 10 }),
    /imageCountInvalid/
  );
});

test('empty title + empty body fails with textInvalid', () => {
  assert.throws(
    () => validatePublishContent({ title: '', body: '', tags: [], imageCount: 1 }),
    /textInvalid/
  );
});

test('empty title but non-empty body passes', () => {
  assert.doesNotThrow(() => validatePublishContent({ title: '', body: '正文', tags: [], imageCount: 1 }));
});

test('assertDecodableImage accepts PNG and JPEG magic bytes, rejects others', () => {
  assert.doesNotThrow(() => assertDecodableImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'a.png'));
  assert.doesNotThrow(() => assertDecodableImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'a.jpg'));
  assert.throws(() => assertDecodableImage(Buffer.from('<html>404</html>'), 'bad.png'), /imageDecodeInvalid/);
  assert.throws(() => assertDecodableImage(Buffer.alloc(0), 'empty.jpg'), /imageDecodeInvalid/);
});