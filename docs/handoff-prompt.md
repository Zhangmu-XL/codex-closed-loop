# 提示词：把 Codex × DSH 闭环接入一个实际项目

把下面**整段**发给一个新的 DSH 会话（`dsh --profile headless "..."` 或 Web 界面），
把 `{{PROJECT_PATH}}` 和 `{{PROJECT_GOAL}}` 换成你的。

---

## 复制从这里开始

```
请把「Codex × DSH 自动闭环」接入我的项目，并跑通第一轮。

框架位置：E:\AAA\29\codex-closed-loop
目标项目：{{PROJECT_PATH}}
项目目标：{{PROJECT_GOAL}}

严格按以下步骤做，不要跳步，不要自己发挥：

【第 1 步 · 先读框架，别猜】
读这些文件，理解契约后再动手：
- E:\AAA\29\codex-closed-loop\README.md          （用法、预算、故障排查）
- E:\AAA\29\codex-closed-loop\docs\executor-protocol.md  （执行者契约）
- E:\AAA\29\codex-closed-loop\config\run.config.json     （所有开关）
- E:\AAA\29\codex-closed-loop\seeds\task-T-001.txt       （任务书长什么样）

【第 2 步 · 建项目骨架并装入桥】
在 {{PROJECT_PATH}} 下创建 config/ seeds/ work/ 目录，然后：

  cd E:\AAA\29\codex-closed-loop
  node tools\install-bridge.mjs {{PROJECT_PATH}}

这会把 bridge.mjs + lib/ + schema 复制进项目根，项目从此自包含。
验证：{{PROJECT_PATH}}\bridge.mjs 必须存在。

【第 3 步 · 改配置（这一步最容易错）】
编辑 {{PROJECT_PATH}}\config\run.config.json，必须改：
- project.workspace  → 指向 {{PROJECT_PATH}} 内的真实代码目录
                        （绝不能指向项目和框架之外）
- codex.workdir      → {{PROJECT_PATH}}\.codex-scratch
                        （大脑的运行目录，它不会碰你的代码）
- budgets.maxRequestsPerDay / maxTokensPerDay → 按你的承受能力调
- `timeouts.maxRunDurationMs` → 无人值守时的墙钟硬上限
保留 codex.exePath 原值（本机 Codex 不在 PATH，必须按绝对路径调用）。

【第 4 步 · 写 PROJECT.md】
{{PROJECT_PATH}}\seeds\PROJECT.md 是**大脑唯一能看到的东西** —— 它看不到你的代码。
用 E:\AAA\29\codex-closed-loop\seeds\PROJECT.md.template 的结构写：
目标 / 现状 / 约束 / 验收标准 / 不做什么。
验收标准必须是可检查的（命令、退出码、文件内容），不能是"质量良好"。

【第 5 步 · 零成本自检】
  cd {{PROJECT_PATH}}
  node bridge.mjs doctor
这步不花 token。必须看到 Codex 版本号和 auth present: true。
失败就停下报告，不要继续。

【第 6 步 · 让 Codex 拆解】
  node bridge.mjs run init
这花 1 次调用。检查输出里：
- planSource 应为 "codex"（不是种子文件）
- queue 里的任务数量合理（3-8 个最好；如果它拆出 30 个，说明 PROJECT.md 太笼统）
- next.launchCommand 里的路径必须真实存在

【第 7 步 · 执行第一个任务】
  dsh --profile headless "Read {{PROJECT_PATH}}\seeds\task-T-001.txt and execute it. Follow the codex-executor skill exactly."

【第 8 步 · 报告】
汇报：任务数、每个任务标题、第一轮裁决（pass/rework/next/stop）、实际 token 消耗。
如果 Codex 要求 rework，如实说它要求改什么。

【硬规则】
1. 不要修改 E:\AAA\29\codex-closed-loop\ 里的任何文件 —— 那是框架。要改就改项目副本。
2. 不要跳过 doctor 直接 run init —— 那是拿 token 试错。
3. 执行者跑在受限沙箱里时，`ask` 会因 spawn EPERM 失败。如实报告，不要绕。
4. 任何一步失败，停下来报告原因，不要自己发明替代方案。
5. 不要为了让流程"看起来跑通"而编造裁决。
```

## 复制到这里结束

---

## 之后怎么用

第一次跑通后，日常就三条命令：

```powershell
cd {{PROJECT_PATH}}
node bridge.mjs status                                  # 现在什么状态（0 token）
node bridge.mjs run init                                # 开了个新阶段才需要
node bridge.mjs ask --card state/cards/T-001.result.json # 有卡要交时
```

要**无人值守**连跑，用：

```powershell
node bridge.mjs ask --card state/cards/T-001.result.json `
  --unattended `
  --executor 'dsh --profile headless "Read {brief} and execute it. Follow the codex-executor skill exactly."'
```

---

## 常见情况对照

| 现象 | 怎么办 |
|---|---|
| Codex 拆出 30 个任务 | `PROJECT.md` 太笼统。补上"不做什么"和验收标准，重跑 `run init` |
| 任务太大、一轮做不完 | 在 `PROJECT.md` 里把目标切小；或改 `maxReviseAttempts` |
| Codex 一直 `rework` | 它认为证据不足。看 `state/handoff/` 和卡片的 `blockers` |
| Codex `stop` 了 | 它在问人。看 `state/handoff/needs-human-*.md`，回答后 `ask ... --note "答案"` |
| 不知道花了多少 | `node bridge.mjs status` 看 `budget` |
| 成本涨太快 | `node bridge.mjs compact` 滚动线程，把上下文拉回起点 |
| 想从头再来 | `node bridge.mjs reset --yes` |
| 执行者报 `MODULE_NOT_FOUND` | 桥没装进项目根。回到第 2 步 |
| 执行者报 `spawn EPERM` | 执行者的沙箱禁止创建子进程。换非受限 profile，或让人手动跑 `ask` |
