import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  extractOrderedAttachments,
  downloadAttachmentsInOrder
} from '../scripts/lib/feishu-attachment-loader.mjs';

import {
  getXhsAlbumPath,
  computeReversePushOrder,
  stageImagesToDeviceAlbum
} from '../scripts/lib/device-album-staging.mjs';

import { DEFAULT_FEISHU_CONFIG } from '../scripts/lib/xhs-feishu-sync.mjs';

test('1. DEFAULT_FEISHU_CONFIG identity must be user', () => {
  assert.equal(DEFAULT_FEISHU_CONFIG.identity, 'user', '飞书默认交互身份必须是 user');
});

test('2. extractOrderedAttachments reverses Feishu newest-first cell into upload order and caps at maxCount', () => {
  // 飞书附件数组是「后上传在前」：cell[0] 是最后上传的图
  const fakeRecord = {
    '图片素材': [
      { file_token: 'token_03', name: 'uploaded_last.jpg', size: 300 },
      { file_token: 'token_02', name: 'detail.jpg', size: 200 },
      { file_token: 'token_01', name: 'front_cover.jpg', size: 100 }
    ]
  };

  const extracted = extractOrderedAttachments(fakeRecord, '图片素材', 2);
  assert.equal(extracted.length, 2, '超出 maxCount 的部分（最早上传的）被截断');
  // reverse 后 cell 末尾（= 最先上传）变 index 0
  assert.deepEqual(extracted[0], {
    orderIndex: 0,
    fileToken: 'token_01',
    name: 'front_cover.jpg',
    size: 100
  });
  assert.deepEqual(extracted[1], {
    orderIndex: 1,
    fileToken: 'token_02',
    name: 'detail.jpg',
    size: 200
  });
});

test('3. extractOrderedAttachments returns empty on empty or missing fields', () => {
  assert.deepEqual(extractOrderedAttachments({}), []);
  assert.deepEqual(extractOrderedAttachments({ '图片素材': null }), []);
  assert.deepEqual(extractOrderedAttachments({ '图片素材': [] }), []);
});

test('4. downloadAttachmentsInOrder downloads files with 01-, 02- prefix and enforces user identity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-test-dl-'));
  const attachments = [
    { orderIndex: 0, fileToken: 'token_cover', name: 'cover.jpg' },
    { orderIndex: 1, fileToken: 'token_second', name: 'second.png' }
  ];

  const mockCalls = [];
  const mockCaller = (args, options = {}) => {
    mockCalls.push(args);
    // 模拟 lark-cli 下载生成文件（--output 相对路径 + cwd）
    const outIdx = args.indexOf('--output');
    const outName = outIdx >= 0 ? args[outIdx + 1] : null;
    const cwd = options.cwd || process.cwd();
    if (outName) {
      fs.writeFileSync(path.join(cwd, outName), 'fake image bytes ' + outName);
    }
    return { ok: true };
  };

  const results = downloadAttachmentsInOrder({
    recordId: 'rec_fake_123',
    attachments,
    outputDir: tmpDir,
    caller: mockCaller
  });

  try {
    assert.equal(results.length, 2);
    assert.equal(results[0].fileName, '01-cover.jpg');
    assert.equal(results[1].fileName, '02-second.png');
    assert(fs.existsSync(results[0].localPath));
    assert(fs.existsSync(results[1].localPath));

    // 验证每次调用 lark-cli 均带有 --as user
    for (const callArgs of mockCalls) {
      assert(callArgs.includes('--as'), 'CLI 必须包含 --as 参数');
      const asIdx = callArgs.indexOf('--as');
      assert.equal(callArgs[asIdx + 1], 'user', 'CLI 身份必须强制为 user');
      assert(callArgs.includes('--base-token'));
      assert(callArgs.includes('--record-id'));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('5. getXhsAlbumPath resolves normalized album path', () => {
  assert.equal(getXhsAlbumPath('04'), '/sdcard/Pictures/XhsPublish4');
  assert.equal(getXhsAlbumPath('01'), '/sdcard/Pictures/XhsPublish1');
  assert.equal(getXhsAlbumPath('test_device'), '/sdcard/Pictures/XhsPublishtest_device');
});

test('6. computeReversePushOrder accurately inverts order while keeping orderIndex', () => {
  const images = [
    { orderIndex: 0, fileName: '01-cover.jpg', localPath: '/tmp/01.jpg' },
    { orderIndex: 1, fileName: '02-detail.jpg', localPath: '/tmp/02.jpg' },
    { orderIndex: 2, fileName: '03-back.jpg', localPath: '/tmp/03.jpg' }
  ];

  const reversed = computeReversePushOrder(images);
  assert.equal(reversed[0].orderIndex, 2, '第 1 个被推的应该是最后一张图 03');
  assert.equal(reversed[1].orderIndex, 1);
  assert.equal(reversed[2].orderIndex, 0, '最后被推的应该是封面图 01');
});

test('7. stageImagesToDeviceAlbum executes reverse push, touch, and scan in strict sequence', () => {
  const images = [
    { orderIndex: 0, fileName: '01-cover.jpg', localPath: '/local/01-cover.jpg' },
    { orderIndex: 1, fileName: '02-detail.jpg', localPath: '/local/02-detail.jpg' }
  ];

  const executedCommands = [];
  const mockExecutor = (args) => {
    executedCommands.push(args);
    return '';
  };

  let sleepCount = 0;
  const mockSleeper = (ms) => {
    sleepCount += 1;
  };

  const staged = stageImagesToDeviceAlbum({
    serial: 'DEVICE_SERIAL_999',
    alias: '04',
    images,
    options: {
      executor: mockExecutor,
      sleeper: mockSleeper,
      touchGapMs: 10
    }
  });

  // 1. 验证清理和重建相册
  assert.deepEqual(executedCommands[0], [
    '-s', 'DEVICE_SERIAL_999', 'shell', 'rm', '-rf', '/sdcard/Pictures/XhsPublish4'
  ]);
  assert.deepEqual(executedCommands[1], [
    '-s', 'DEVICE_SERIAL_999', 'shell', 'mkdir', '-p', '/sdcard/Pictures/XhsPublish4'
  ]);

  // 2. 验证倒序推送：第一张 push 的是 02-detail.jpg
  assert.deepEqual(executedCommands[2], [
    '-s', 'DEVICE_SERIAL_999', 'push', '/local/02-detail.jpg', '/sdcard/Pictures/XhsPublish4/02-detail.jpg'
  ]);
  // 紧接着 touch 02
  assert.deepEqual(executedCommands[3], [
    '-s', 'DEVICE_SERIAL_999', 'shell', 'touch', '/sdcard/Pictures/XhsPublish4/02-detail.jpg'
  ]);

  // 3. 验证第二张（最后一张）push 的是 01-cover.jpg（封面）
  const pushCoverCmd = executedCommands.find(c => c.includes('/local/01-cover.jpg'));
  assert(pushCoverCmd, '封面必须被推送');
  const coverPushIndex = executedCommands.indexOf(pushCoverCmd);
  const detailPushIndex = 2;
  assert(coverPushIndex > detailPushIndex, '封面必须在后推（最后获得最新 mtime）');

  // 4. 验证返回值保持业务正序
  assert.equal(staged[0].orderIndex, 0);
  assert.equal(staged[0].fileName, '01-cover.jpg');
  assert.equal(staged[1].orderIndex, 1);
  assert.equal(staged[1].fileName, '02-detail.jpg');
  assert.equal(sleepCount, 2, '两张图推完均有 touch 间隔');
});
