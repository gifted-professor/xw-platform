import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const LARK_CLI_PATH = process.env.LARK_CLI_PATH ||
  'C:/Users/windows 10/AppData/Local/Microsoft/WinGet/Packages/ByteDance.LarkCLI_Microsoft.Winget.Source_8wekyb3d8bbwe/lark-cli.exe';

export const DEFAULT_FEISHU_CONFIG = {
  baseToken: 'JlQfboedWaeBnysOE3ncPtsunCh',
  notesTableId: 'tblKyZr6TEp0S1En',
  commentsTableId: 'tblB5BKhLCA5epYi',
  publishTableId: 'tblA3sCeFgdJHStf',
  identity: 'user'
};

/**
 * Execute a lark-cli command safely returning parsed JSON data.
 */
export function callLarkCli(args, options = {}) {
  const cliPath = options.cliPath || LARK_CLI_PATH;
  const stdout = execFileSync(cliPath, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options
  });
  return JSON.parse(stdout);
}

/**
 * Calculate unique 16-hex fingerprint for a comment row.
 */
export function computeCommentFingerprint(noteFingerprint, user, text) {
  const normUser = String(user || '').trim();
  const normText = String(text || '').trim();
  return crypto.createHash('sha256')
    .update(`${noteFingerprint}|${normUser}|${normText}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Sync a single note record and its comments to Feishu Base.
 * - Creates / updates Note in Notes Table
 * - Batch inserts comments into Comments Table with linked record_id
 * - Stores raw comments JSON snapshot in Note record
 */
export async function syncNoteAndCommentsToFeishu(noteRecord, options = {}) {
  const config = { ...DEFAULT_FEISHU_CONFIG, ...options };
  const { baseToken, notesTableId, commentsTableId, identity } = config;

  const noteFingerprint = noteRecord.noteFingerprint;
  if (!noteFingerprint) {
    throw new Error('noteRecord must have a valid noteFingerprint');
  }

  // 1. Prepare Note row payload
  const comments = Array.isArray(noteRecord.comments) ? noteRecord.comments : [];
  const commentsSnapshot = JSON.stringify(comments, null, 2);

  const noteFields = {
    '笔记标题': noteRecord.title || '（未识别标题）',
    '笔记指纹': noteFingerprint,
    '业务类型': '采集沉淀',
    '作者昵称': noteRecord.author || '',
    '正文描述': noteRecord.body || '',
    '发布时间属地': [noteRecord.postTime?.date || noteRecord.date, noteRecord.postTime?.location].filter(Boolean).join(' ') || '',
    '点赞数': Number(noteRecord.interactions?.likeCount || 0),
    '收藏数': Number(noteRecord.interactions?.collectCount || 0),
    '总评论数': Number(noteRecord.interactions?.commentCount || noteRecord.commentTotal || 0),
    '已采评论数': comments.length,
    '评论截断': Boolean(noteRecord.commentsTruncated),
    '评论完整快照': commentsSnapshot,
    '采集批次': noteRecord.recipeRunId || ''
  };

  // Upsert note record
  const noteUpsertRes = callLarkCli([
    'base', '+record-upsert',
    '--base-token', baseToken,
    '--table-id', notesTableId,
    '--json', JSON.stringify(noteFields),
    '--as', identity,
    '--format', 'json'
  ]);

  const noteRecordId = noteUpsertRes.data?.record?.record_id_list?.[0] || noteUpsertRes.data?.record_id;
  if (!noteRecordId) {
    throw new Error(`Failed to obtain noteRecordId from upsert result: ${JSON.stringify(noteUpsertRes)}`);
  }

  // 2. Prepare Comments batch rows
  if (comments.length === 0) {
    return {
      noteRecordId,
      commentsCount: 0,
      noteFingerprint
    };
  }

  // Deduplicate comments for this note
  const seenFp = new Set();
  const commentRows = [];

  for (const c of comments) {
    const fp = computeCommentFingerprint(noteFingerprint, c.user, c.text);
    if (seenFp.has(fp)) continue;
    seenFp.add(fp);

    commentRows.push({
      '评论指纹': fp,
      '评论用户': c.user || '匿名用户',
      '评论内容': c.text || '',
      '评论获赞': c.likes !== null && c.likes !== undefined ? Number(c.likes) : null,
      '发布时间属地': c.timeText || '',
      '来源Dump': Array.isArray(c.sources) ? c.sources.join(',') : (c.sources || ''),
      '采集批次': noteRecord.recipeRunId || '',
      '所属笔记': [{ id: noteRecordId }]
    });
  }

  // Batch insert into Comments Table in chunks of 100
  const CHUNK_SIZE = 100;
  let insertedComments = 0;

  for (let i = 0; i < commentRows.length; i += CHUNK_SIZE) {
    const chunk = commentRows.slice(i, i + CHUNK_SIZE);
    // Use raw bitable batch-create open-api or +record-batch-create
    const fieldsList = [
      '评论指纹', '评论用户', '评论内容', '评论获赞',
      '发布时间属地', '来源Dump', '采集批次', '所属笔记'
    ];
    const rowsList = chunk.map(item => fieldsList.map(k => item[k]));

    const batchRes = callLarkCli([
      'base', '+record-batch-create',
      '--base-token', baseToken,
      '--table-id', commentsTableId,
      '--json', JSON.stringify({
        fields: fieldsList,
        rows: rowsList
      }),
      '--as', identity,
      '--format', 'json'
    ]);

    const createdIds = batchRes.data?.record_id_list || [];
    insertedComments += createdIds.length;
  }

  return {
    noteRecordId,
    commentsCount: insertedComments,
    noteFingerprint
  };
}
