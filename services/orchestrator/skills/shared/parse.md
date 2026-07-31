# 解析库（Parse）

> UI dump XML → 结构化数据。纯函数，无设备 I/O。

## 核心文件

`ops/_xhs-parse.mjs` — 小红书 UI dump 解析库

## 函数清单

### Feed 卡片

| 函数 | 输入 | 输出 | 用途 |
|------|------|------|------|
| `parseFeedCards(xml)` | dump XML | `[{title, author, likes, bounds}]` | 解析信息流卡片 |
| `isHomeFocus(focus)` | focus 字符串 | `boolean` | 是否在主页 |

### 笔记详情

| 函数 | 输入 | 输出 | 用途 |
|------|------|------|------|
| `findLikeBtn(xml)` | dump XML | `{x, y, text}` | 定位点赞按钮 |
| `findCollectBtn(xml)` | dump XML | `{x, y, text}` | 定位收藏按钮 |
| `findFollowBtn(xml)` | dump XML | `{x, y, text, state}` | 定位关注按钮（四态） |
| `findCommentBox(xml)` | dump XML | `{x, y}` | 定位评论输入框 |
| `parseComments(xml)` | dump XML | `{count, items}` | 解析评论列表 |

### 作者信息

| 函数 | 输入 | 输出 | 用途 |
|------|------|------|------|
| `findProfileAuthor(xml)` | dump XML | `string` | 从主页浮层提取作者名 |
| `followState(text)` | 按钮文本 | `'followed'\|'unfollowed'` | 判断关注状态 |

### 搜索

| 函数 | 输入 | 输出 | 用途 |
|------|------|------|------|
| `parseSearchResults(xml)` | dump XML | `[{title, author, bounds}]` | 解析搜索结果卡片 |

### 发布

| 函数 | 输入 | 输出 | 用途 |
|------|------|------|------|
| `findEditText(xml)` | dump XML | `{x, y}` | 定位文本输入框 |
| `decodeEntities(text)` | HTML 实体 | 解码文本 | 处理 XML 转义 |

## 关注按钮四态

| 文本 | 状态 | 含义 |
|------|------|------|
| `关注` | unfollowed | 未关注 |
| `已关注` | followed | 已关注 |
| `回关` | unfollowed | 对方关注你，你未关注 |
| `相互关注` | followed | 互相关注 |

## 注意事项

- `findFollowBtn` 用 **exact-set 等值** 匹配，避免 `关注的话题` 假阳
- `followState` 先判 `已关注`/`相互关注` 再判 `关注`，避免子串误中
- 所有函数空输入安全（返回 null 或空数组）
