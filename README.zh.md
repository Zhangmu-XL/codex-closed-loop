# codex-closed-loop

[English](README.md) | 中文

**Codex 当大脑，执行 Agent 干活。中间没有编排器。**

执行 Agent 干完活，写一张结构化结果卡，然后**自己**去调 Codex —— 阻塞等待它回答。
Codex 决定 `pass` / `rework` / `next` / `stop`，执行 Agent 按这个决定继续。

```
你
 └─(1) node bridge.mjs run init        ← 只跑一次。它不是编排器。
        └─ bridge 调用 Codex CLI
             Codex 拆解项目 → state/queue/*.json
                  ↓ bridge 打印启动命令
 └─(2) 你的 Agent 读任务书，干活
        └─ 写 state/cards/<id>.result.json
             └─(3) node bridge.mjs ask --card <路径>    ★ Agent 自己去调 Codex
                    └─ bridge = 传输层。拉起 Codex、阻塞、返回。
                         Codex 回答 pass | rework | next | stop
                    ↑ 进程退出码 0 / 10 / 20 / 30 就是裁决
             ← 你的 Agent 按退出码分流，继续
```

零运行时依赖。Node ≥ 20。**不需要 `npm install`。**

---

## 为什么是这个形状

**1. 没有编排器。** bridge 组装摘要、调 Codex、记账、写状态、返回退出码。它不挑任务、
不验收、不路由。`state/decisions.jsonl` 里每一条决策都来自 Codex。

**2. 只传摘要。** 大脑永远看不到日志、diff、或你的文件系统。结果卡有硬上限（默认单条
摘要 400 字符），而且 bridge 会**在花掉一个 token 之前就拒绝超限的卡**。原始事件流落到
`state/runs/` 供取证，永远不进 prompt。

**3. 默认无人值守。** 轮次之间不需要人。Codex 被明确告知**什么时候可以**停下来找人、
**什么时候不可以**。

---

## 快速开始

```powershell
# 一条命令建出自包含的项目
node bridge.mjs init E:\my-project
```

一次做完四件事：

1. 建 `config/` `seeds/` `work/` `.codex-scratch/`
2. **探测**真实 `codex.exePath` 写进配置（这个路径含每次安装都变的哈希，写死必然错）
3. 放入 `seeds/PROJECT.md` 模板
4. **把 `bridge.mjs` + `lib/` 复制进去**，项目从此自包含

**第 4 步为什么必须**：任务书写的是 `<项目根>/bridge.mjs ask ...`。桥不在那儿，
执行者会报 `MODULE_NOT_FOUND` —— 它**不会**替你编一个通过，只会停下来报告。

然后：

```powershell
notepad E:\my-project\config\run.config.json   # workspace 指向你的真实代码目录
notepad E:\my-project\seeds\PROJECT.md         # 大脑唯一能看到的东西

cd E:\my-project
node bridge.mjs doctor        # 零 token 自检
node bridge.mjs run init      # 让 Codex 拆解（1 次调用）
```

**框架更新后**，项目里的副本要重新同步：

```powershell
node tools\install-bridge.mjs E:\my-project
```

**但配置不会被动。** `install-bridge` 拒绝覆盖已有配置 —— 覆盖你调好的限额比 schema
漂移更糟。这留下一个缺口：**新版本加的字段，老项目永远拿不到**，于是新功能静默不生效。

所以有个迁移命令：

```powershell
cd E:\my-project
node bridge.mjs upgrade-config --dry-run    # 看缺什么
node bridge.mjs upgrade-config              # 补上
```

它结构上就是保守的：**已有的值永远优先**（包括 `null`），**从不删除任何键**，并且会
列出 schema 已不认识的键让你自己判断。`configVersion` 记录漂移，第二次运行是空操作。

---

## 命令

| 命令 | 作用 | Codex 调用 |
|---|---|---|
| `node bridge.mjs init [dir]` | 建立项目骨架 + 探测 codex 路径 + 复制桥 | 0 |
| `node bridge.mjs doctor [--live]` | 探测 CLI、认证、路径。`--live` 做一次真实往返 | 0 / 1 |
| `node bridge.mjs run init` | 把 `seeds/PROJECT.md` 拆解成任务队列 | 1（种子队列时 0） |
| `node bridge.mjs ask --card <路径>` | 提交结果卡，阻塞等裁决 | 1 |
| `node bridge.mjs status` | 预算、队列、最近裁决 | 0 |
| `node bridge.mjs compact` | 换新线程，用摘要重新播种 | 1 |
| `node bridge.mjs selftest` | 离线跑完整状态机（stub 大脑） | 0 |
| `node bridge.mjs reset --yes` | 删除全部运行状态 | 0 |

`ask` 的参数：`--note "<文本>"`（≤1000 字符，不是日志）、`--unattended`、
`--executor "<命令>"`、`--mirror-thread <id>`、`--no-mirror`。

### 退出码

| 退出码 | 动作 | 含义 |
|---|---|---|
| `0` | `pass` | 已接受 |
| `10` | `rework` | 未接受；`instruction.what` 说明要改什么 |
| `20` | `next` | 已接受，继续下一个任务 |
| `30` | `stop` | 停止 —— Codex 在找人 |
| `3` | 预算 | 触到配置的限额 |
| `4` | 轮次 | 轮次/调用上限 |
| `5` | 基建 | 传输、配置或锁失败 |
| `6` | 卡片非法 | 卡片被拒；**未花任何 token** |

`instruction` 块是"下一步做什么"的**唯一权威**。`thenRun` 可直接粘贴 —— 重试计数是
bridge 的事，执行者永远不该自己重建那条命令。

---

## 无人值守

```powershell
node bridge.mjs ask --card state/cards/T-001.result.json `
  --unattended `
  --executor 'dsh --profile headless "Read {brief} and execute it."'
```

带 `--executor` 时，bridge 自己启动每个后续任务并把结果汇报回 Codex，直到 Codex 不再
要更多任务。**但每个任务的提示词仍然全部来自 Codex** —— bridge 只是在走这个循环。

占位符：`{taskId}` `{brief}` `{card}` `{root}`。

Codex 只在这些情况找人：缺权限/凭证、动作不可逆或越界、任务真歧义、目标已达成或推不动。
停下时写 `state/handoff/needs-human-<taskId>.md`，里面有原因、它需要什么、怎么恢复。

### 宿主代投（执行者 spawn 不了的时候）

`--executor` 需要能创建带管道 stdio 的子进程。受限沙箱会挡住（`spawn EPERM`），而且
沙箱里的 agent 往往连卡片文件都写不了。

**这不是降级模式 —— 这才是原始设计。** 闭环的契约只有这一条：*某个*东西跑任务、
*某个*东西写卡、拿着卡的 agent 自己调 `ask`。**具体哪个进程启动 worker，不属于这个契约。**

所以由宿主来驱动：

```powershell
# 宿主负责启动 worker（在这里是什么都行），然后投递卡片
node bridge.mjs ask --card state/cards/T-001.result.json --unattended
```

worker 写不了文件时，用 stdin 传卡：

```powershell
node bridge.mjs ask --card - < card.json
```

`ask` 阻塞、返回一份 JSON 裁决、退出码说明下一步。这些都不要求 bridge 掌握进程控制权。
`--executor` 能用就用；**它用不了不等于功能缺失**。

### 回答大脑，并把 run 拿回来

大脑返回 `stop` 是在**提问**。`state/handoff/` 里的文件写明问的是什么，答案用 `--note`
递回去 —— **同一个 run、同一条线程**，不重新规划、不重编任务号：

```powershell
node bridge.mjs ask --card state/cards/T-002.result.json --note "用第二个文件"
```

**没 note 就仍然拒绝** —— 这正是防止无人值守循环自己重启的机制。有 note 就代表人来了，
于是恢复。这次决定会记进台账，`maxHumanResumes`（默认 5）限制一个 run 能被救回几次。

### 寿命门按"干活的时间"算，不按日历

`timeouts.maxRunDurationMs` 以**活跃时间**计。bridge 在每次 Codex 往返和每次执行者运行后
刷新活动锚点，**空档期不计入**。

这个区分有实际代价：曾有一次执行者崩溃、5.5 小时没人在，下一次 `ask` 被
`alive 398min` 拒绝 —— 干掉了一个已经干了几轮实活的 run。**空档不是预算。** 但真正
卡死的循环照样会撞上线。

### 在 Codex 界面边跑边看

```powershell
node bridge.mjs ask --card state/cards/T-001.result.json `
  --mirror-thread "<你在应用里开着的对话名或 UUID>"
```

每条裁决用 `codex queue` 推进那个对话。**必须用两个线程** —— 应用对自己拥有的对话
持有 writer lock，桥 resume 它会报 `already has an active writer`。

---

## 配置要点

### 限额

```jsonc
"budgets": {
  "maxRounds": 40,               // 真正约束一次 run 的是这三个
  "maxReviseAttempts": 2,
  "maxRequestsPerDay": 10000,    // 远高于任何真实 run，只是防跑飞的断路器
  "maxTokensPerDay": 100000000   // 同上：token 花费不是工作限制
},
"timeouts": {
  "maxRunDurationMs": 21600000   // 墙钟硬上限
},
"maxExecutorRuns": 25,
"compact": {
  "auto": true,
  "maxThreadTokens": 500000       // 上下文质量护栏，不是省钱护栏
}
```

**token 花费默认不限制。** 两个日计数器设在任何真实 run 都够不着的高度，它们只是
**防跑飞的断路器**（崩溃循环、失控 prompt），不是配给机制。`budget.json` 照常记账 ——
`status` 要显示，线程滚动也要读它。

要收紧（共享账号、计量预算）就自己往下调。

### 推理强度

`codex exec` **没有** `--reasoning-effort` flag —— 它是配置键，桥用
`-c model_reasoning_effort="..."` 覆盖。`null` 表示继承 `~/.codex/config.toml`。

**档位是模型相关的，而且没有任何 flag 能列出它们。** 别猜，直接探：

```bash
node bridge.mjs probe-effort
```

它每档跑一道小题，报告"接不接受"和"实际推理了多少"。本机实测（`gpt-5.6-luna`）——
注意 **`xhigh` 是存在的**，光看文档猜不到：

| 档位 | 结果 | 推理 token |
|---|---|---|
| `minimal` | 被拒 —— `unsupported_value` | — |
| `low` | 接受 | 133 |
| `medium` | 接受 | 741 |
| `high` | 接受 | 1466 |
| `xhigh` | 接受 | **1502** |

两点注意：填错会在**第一次真实调用**就报 `unsupported_value` 并指名参数，不会静默降级；
而"接受"不等于"干得更多" —— 上面这张表有意义，是因为探测题**需要真推理**，用送分题
测的话每一档都是 0。

设好后要 `compact` 起新线程：`resume` 不接受 `-c`，一条活着的线程会保持它创建时的
强度，和 `--sandbox`、`-m` 一样。

### 摘要与人读卡片

`summaryOneLine` 是唯一保证会被人读到的字段。**400 字符放得下结论，放不下"做了什么
+ 真实命令和退出码 + 还没解决什么"。** 如果看结果的人只读卡，就调大它 —— 同时调大
`rollingMaxChars`，否则老卡会更早被挤掉：

```jsonc
"summary": {
  "oneLineMaxChars": 4000,     // 完整报告进卡
  "rollingMaxChars": 60000,    // 最坏情况 = cardsKept × (oneLineMaxChars + 2)
  "entryMaxChars": 1200,       // findings/changed/blockers 的单条上限
  "maxFindingsEntries": 8,     // 大脑会考虑几条 findings
  "maxChangedEntries": 12,
  "maxBlockersEntries": 5,
  "nextHintMaxChars": 900,
  "cardsKept": 12
}
```

单条过长会被**截断，不会拒绝** —— 为一个格式问题废掉整张卡等于白烧一轮。而**条数**
超限是硬失败，因为它改变了"大脑被要求判断什么"。

滚动摘要**只**由结构化字段拼成（`lib/summary.mjs`）。原始日志在结构上就进不去 prompt。
改完用 `node tools/check-limits.mjs` 验证那两个滚动数字是否自洽。

---

## 磁盘状态

```
state/
├─ run-plan.json                 Codex 拆解出的计划
├─ queue/<taskId>.json           任务队列
├─ cards/<id>.result.json        执行者自己的卡（bridge 永不覆盖）
├─ cards/<id>.accepted.json      bridge 归一化后的副本
├─ calls/                        每个往返一份存档：发出的确切 prompt 和裁决
├─ decisions.jsonl               只追加的台账
├─ budget.json                   当日计数器
├─ rolling-summary.md            大脑唯一能看到的历史
├─ lock.json                     并发锁
├─ handoff/                      需要人处理的问题
└─ runs/<时间戳>/                原始事件流 —— 仅取证，永不进 prompt
```

`state/` 可以随时丢。`node bridge.mjs reset --yes` 清空它。

### 开第二轮运行

任务编号**每轮从 `T-001` 重新开始**，所以上一轮的 `cards/T-001.accepted.json`
**正好落在下一轮将要写入的位置** —— 新一轮的滚动摘要可能把旧裁决当成自己的历史。
`run init` 发现不属于当前 run 的产物时会往 stderr 打警告。

处理方式是**移走**旧状态而不是删除（删掉就丢掉了"大脑当时到底判了什么"的唯一凭据）：

```bash
node bridge.mjs archive-state --label "before-v2" [--dry-run]
```

它把 `state/` 移到 `work/run-archives/<时间戳>-<runId>/`，并写一份 README 记录
runId、时间跨度、状态与停止原因、产生了多少裁决及各类分布、以及**为什么**归档。
不删任何东西，所以 `calls/` 和 `runs/` 都还在，想复查任何一次裁决的依据都行。

它拒绝归档"没有 run、卡片、调用或轮次"的状态 —— 否则归档后再跑一次会以
"归档成功"收场，而里面什么都没有。

### 报告与防误判约定

如果看结果的人**只能看到结果卡和滚动摘要**，把约定写进 `seeds/PROJECT.md`：

```markdown
- `summaryOneLine` 写完整报告：做了什么、证据（真实命令 + 退出码）、
  与基线的对照、未改动声明、仍未解决项
- `verify` 写真实执行的验收命令与退出码
- `nextHint` 写详细证据文件路径，供按需核读
- 仍须保证"只读卡就能判定"，不得把关键结论只留在文件里
- 禁止把 mock / 合成结果当真实结论
- 禁止以"源码里出现某字符串"代替行为证据
```

最后两条最贵。真实项目里出现过：预检脚本以**源码字符串**判断功能是否接线，而那个
字符串在注释里也有 —— 于是未接线的模块通过了预检。

模板里有一份可直接抄的版本：`seeds/PROJECT.md.template`。

---

## 自测

```powershell
node bridge.mjs selftest     # 166 项断言，零网络调用
```

覆盖：拆解与派发、五类卡片拒绝、`pass`/`rework`/`next`/`stop` 全分支、幂等重放与
**改过的卡会重新问大脑**、修复轮、返工上限、四道预算闸门 + 墙钟、传输崩溃重试、
超时杀进程、被拒绝的子进程创建不计费、线程连续与自动滚动、无状态降级、
滚动摘要有界且无日志、陈旧锁回收、活锁快速失败、完整无人值守链路、
镜像默认关闭且不会破坏闭环、推理强度只在全新 exec 生效。

`examples/hello-loop/` 是自包含示例，队列种子化，`run init` 零调用。

---

## 已知边界

- **并发是设计了的，但没压测过。**
- **只在 Windows + `codex-cli 0.159.2` 上验证过。**
- **`codex exec --json` 的事件格式是内部细节**，从二进制逆出来的，用测试钉在一个版本上。
  Codex 升级可能破坏 token 记账或线程捕获 —— 会降级成无状态模式而不是崩，但升级后要
  检查 `state/runs/`。
- **大脑需要能创建子进程的运行时。** 沙箱禁止管道 stdio 时 `ask` 报 `spawn EPERM`
  （归类为基建失败，不计费，但闭环走不完）。
- **从没跑过真实的返工循环** —— `rework → pass` 是改卡片测的。
- **MCP 通道没实现** —— 有文档化降级路径的桩。

## 许可证

MIT
