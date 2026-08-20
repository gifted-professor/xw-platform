# Skill Router + Experience Ledger（M4-C）

源码 only。叶子 Skill 只报告 `intent:…` 出口，由中央 Router 选下一个 SkillVersion。  
不打开 Graph v2，不碰真机。

## Experience Ledger

```text
01_facts          追加，不可改
02_patterns       缓慢修正，带支持 Episode 数和版本边界
03_snapshots      写完不改
04_open_questions 完成后清掉
```

禁止把一次偶然成功写进永久 Memory。

## Router

输入：任务目标、当前 Graph Node（可空）、Skill 出口、最新 Observation、预算、用户约束。  
输出：`DONE | WAIT_* | RETRY | REROUTE | REPAIR` 以及可选 `nextSkillId`。

`candidateIntents` 必须是 `intent:repair-navigation` 这种命名空间，不能是 `xhs.publish`。
