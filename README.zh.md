# codex-closed-loop

[English](README.md) | 中文

**Codex 当大脑，你的 Agent 干活。中间没有编排器。**

执行 Agent 干完活，写一张结构化结果卡，然后**自己**去调 Codex —— 阻塞等待它回答。
Codex 决定 `pass` / `rework` / `next` / `stop`，执行 Agent 按这个决定继续。没有人替
Codex 规划任务，也没有人卡在中间假装在调度。

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

三条性质决定了这里每一个设计选择：

**1. 没有编排器。** bridge 组装摘要、调 Codex、记账、写状态、返回退出码。它不挑任务、
不验收、不路由。把决策和传输分开，才让闭环可审计 —— `state/decisions.jsonl` 里每一条
决策都来自 Codex。

**2. 只传摘要。** 大脑永远看不到日志、diff、或你的文件系统。结果卡有硬上限（默认单条
摘要 400 字符），而且 bridge 会**在花掉一个 token 之前就拒绝超限的卡**。原始事件流落到
`state/runs/` 供取证，永远不进 prompt。

**3. 默认无人值守。** 轮次之间不需要人。Codex 被明确告知**什么时候可以**停下来找人、
**什么时候不可以**。

---

## 安装

```bash
git clone https://github.com/Zhangmu-XL/codex-closed-loop
cd codex-closed-loop
node bridge.mjs selftest     # 160 项离线断言，零网络、零 token
```

要求：

- **Node.js ≥ 20**
- **Codex CLI** 已安装并登录（`codex --version`；认证在 `~/.codex/auth.json`）
- 没别的了

## ⚠️ 在真实项目上跑之前先读这段

这个工具驱动一个**会在你机器上执行命令、改文件**的 Agent，而且会花你的 Codex 额度。
在把它指向你在意的东西之前：

- **读 `bridge.mjs` 和 `lib/`。** 约 1300 行、零依赖 —— 它是拿来审计的，不是拿来信任的。
- **先跑 `examples/hello-loop/`，再找一个废弃仓库试。** 别直接上主分支。
- **把 `project.workspace` 和 `codex.workdir` 指向你舍得丢的目录。** 默认
  `sandbox: "workspace-write"` 是有原因的；在你信任这套东西之前，别碰 `danger-full-access`。
- **无人值守前先看 `budgets.*`。** 它们是本地闸门，不是账务硬控 —— 同时在 OpenAI
  账户侧设个硬上限。
- **跑完看 `state/calls/*.json`。** 里面是每次**实际发出的 prompt 原文**，你可以自己
  验证"只传摘要"这句是不是真的，而不用信我。

没有质保，MIT 协议，而且 [已知边界](#已知边界)那一段是真的。

## 快速开始

```bash
# 1) 建立项目骨架 —— 一步到位。写入探测到的 codex.exePath，
#    放入 PROJECT.md 模板，并把 bridge 复制进去（项目从此自包含）。
node bridge.mjs init ~/my-project

# 2) 改两个文件
#    ~/my-project/config/run.config.json  -> project.workspace 指向你的真实代码目录
#    ~/my-project/seeds/PROJECT.md        -> 大脑只读这个，不读别的

# 3) 自检（零 token）
cd ~/my-project && node bridge.mjs doctor

# 4) 让 Codex 拆解（1 次调用）
node bridge.mjs run init
```

### 为什么必须复制进去

`init` 会故意把 `bridge.mjs` 和 `lib/` 复制进项目。生成的任务书让执行者跑
`<项目根>/bridge.mjs`，所以没有这个文件的项目会让 Agent 撞上 `MODULE_NOT_FOUND`，
然后它只能去猜。如果你更想用一个 checkout 驱动多个项目，更新框架后重跑
`node tools/install-bridge.mjs <dir>`，或者处处显式传 `--project-root` 和 `--config`。

`run init` 会打印一条 `launchCommand`。跑它，或者把你自己的 Agent 指向任务书。
Agent 有卡之后，`node bridge.mjs ask --card <路径>` 收掉这一轮。

### 无人值守

```bash
node bridge.mjs ask --card state/cards/T-001.result.json \
  --unattended \
  --executor 'dsh --profile headless "Read {brief} and execute it."'
```

带 `--executor` 时，bridge 自己启动每个后续任务，并把结果汇报回 Codex，如此重复，
直到 Codex 不再要更多任务。**但每个任务的提示词仍然全部来自 Codex** —— bridge 只是
在走这个循环。这就是它和编排器的区别。

占位符：`{taskId}` `{brief}` `{card}` `{root}`。

### 在 Codex 桌面应用里看着它跑

无头的 `codex exec` 线程是真实会话，但应用不会把它显示成一个你能旁观的对话。用
**两个线程** —— 应用对自己拥有的对话持有 writer lock，所以不能是同一个：

```bash
node bridge.mjs ask --card state/cards/T-001.result.json \
  --mirror-thread "<你在应用里开着的对话名或 UUID>"
```

每条裁决都会用 `codex queue` 推进那个对话，你就能在闭环运行时看见 `PASS` /
`REWORK` / `NEXT` 冒出来。应用会为每条推送的消息跑一个小模型轮次，所以消息里写了
"no reply needed"；不看的时候把镜像关掉。

---

## 命令

| 命令 | 作用 | Codex 调用 |
|---|---|---|
| `node bridge.mjs init [dir]` | 建立项目骨架：配置 + `PROJECT.md` 模板，并探测 `codex.exePath` | 0 |
| `node bridge.mjs doctor [--live]` | 探测 CLI、认证、路径。`--live` 做一次真实往返 | 0 / 1 |
| `node bridge.mjs run init` | 把 `seeds/PROJECT.md` 拆解成任务队列 | 1（有种子队列时 0） |
| `node bridge.mjs ask --card <路径>` | 提交结果卡，阻塞等裁决 | 1 |
| `node bridge.mjs status` | 预算、队列、最近裁决 | 0 |
| `node bridge.mjs compact` | 换一个新线程，用摘要重新播种 | 1 |
| `node bridge.mjs selftest` | 离线跑完整状态机（stub 大脑） | 0 |
| `node bridge.mjs reset --yes` | 删除全部运行状态 | 0 |

`ask` 的参数：`--note "<文本>"`（≤1000 字符，不是日志）、`--unattended`、
`--executor "<命令>"`、`--mirror-thread <id>`、`--no-mirror`。

### `ask` 的退出码

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

机器可读输出是一份 JSON。`instruction` 块是"下一步做什么"的**唯一权威**：

```json
"instruction": {
  "do": "execute",
  "because": "evidence accepted",
  "taskId": "T-002",
  "readFirst": "seeds/task-T-002.txt",
  "authoritative": "state/queue/T-002.json",
  "thenRun": "node bridge.mjs ask --card state/cards/T-002.result.json",
  "launch": "dsh --profile headless \"Read ...task-T-002.txt and execute it.\""
}
```

`do` 是 `execute`、`rework` 或 `stop`。`thenRun` 可以直接粘贴 —— 重试计数是 bridge
的事，所以执行者永远不应该自己重建那条命令。

---

## 配置

所有开关都在 `config/run.config.json`。

### 大脑

```jsonc
"codex": {
  "exePath": null,               // null = 从 PATH / CODEX_CLI_PATH / 已知安装目录解析
  "model": null,                 // null = 用 ~/.codex/config.toml 的默认模型
  "sandbox": "workspace-write",  // 大脑默认不该拿到全权限
  "workdir": ".codex-scratch"    // 大脑的运行目录，让它碰不到你的代码
}
```

### 限额

```jsonc
"budgets": {
  "maxRounds": 40,               // 整个 run 的 Codex 往返总数
  "maxCodexCallsPerTask": 6,
  "maxReviseAttempts": 2,        // 允许被打回几次，超了就必须通过或停止
  "maxRepairAttempts": 1,        // 裁决格式错时的修复轮
  "maxTurnsTotal": 200,
  "maxRequestsPerDay": 60,
  "maxTokensPerDay": 1500000
},
"timeouts": {
  "codexCallMs": 900000,         // 单次调用硬超时
  "maxRunDurationMs": 21600000   // 整个 run 的墙钟上限
},
"maxExecutorRuns": 25,           // 一条 --executor 链最多起几个执行者
"compact": {
  "auto": true,
  "maxThreadTokens": 150000        // 上下文涨到这就滚动线程
}
```

token 用量是**从 Codex 自己的事件流实测**的，不是模型自报。计数器按
`Asia/Shanghai` 自然日滚动。这些是本地记账闸门，不是账务硬控 —— 同时在 OpenAI
账户侧设个硬上限。

### 摘要

```jsonc
"summary": {
  "oneLineMaxChars": 400,   // 单卡上限；超限的卡会被拒，且不花钱
  "rollingMaxChars": 12288, // 滚动摘要的总预算
  "cardsKept": 12
}
```

滚动摘要**只**由结构化字段拼成（`card.summaryOneLine`、`verdict.summaryForRolling`），
实现在 `lib/summary.mjs`。原始日志在结构上就进不去 prompt。压缩是纯字符串裁剪，
所以不花钱、可复现。

如果你调大 `oneLineMaxChars`，要一起调大 `rollingMaxChars`，否则老卡会更早被挤掉。
改完可以用 `node tools/check-limits.mjs` 验证两者。

---

## 人在环里

`--unattended` 告诉大脑让循环自己跑下去，并且**只在下列情况**找人：

- 需要你没有的权限或凭证
- 动作不可逆、有破坏性、或要碰工作区外面的东西
- 任务真的歧义，猜错会浪费真实工作
- 目标达成，或者它推不动了

它找人时返回 `stop`，bridge 会写 `state/handoff/needs-human-<taskId>.md`，里面有原因、
它需要什么、最后被接受的卡、以及怎么恢复：

```bash
node bridge.mjs ask --card <卡> --note "<你的回答>"
```

`stop` 是**粘性**的，这是故意的：运行不会在你背后悄悄自己重启。

---

## 磁盘状态

```
state/
├─ run-plan.json                 Codex 拆解出的计划
├─ queue/<taskId>.json           任务队列；state = pending|in_progress|submitted|accepted
├─ cards/<id>.result.json        执行者自己的卡（bridge 永不覆盖）
├─ cards/<id>.accepted.json      bridge 归一化后的副本（大脑真正看的）
├─ calls/                        每个往返一份存档：发出的确切 prompt 和裁决
├─ decisions.jsonl               只追加的台账：plan、verdict、rework、重试、预算停止
├─ budget.json                   当日计数器
├─ rolling-summary.md            大脑唯一能看到的历史
├─ lock.json                     并发锁（Codex 线程是共享资源）
├─ handoff/                      需要人处理的问题
└─ runs/<时间戳>/                原始 JSONL 事件流 —— 仅取证，永不进 prompt
```

`state/` 可以随时丢。`node bridge.mjs reset --yes` 清空它。

---

## 一分钱不花地试

```bash
node bridge.mjs selftest
```

160 项断言，**零网络调用**，由一个说真实 CLI 协议的 stub 大脑
（`tools/codex-stub.mjs`）驱动。覆盖：

- 拆解与派发；五类卡片拒绝
- `pass` / `rework` / `next` / `stop` 的每一个分支
- 幂等重放，以及**改过的**卡确实会重新问大脑
- 裁决非法 → 有界修复轮；返工上限
- 四道预算闸门（每日请求、每日 token、轮次、总调用）外加墙钟
- 传输崩溃重试；超时杀进程；被拒绝的子进程创建不计费
- 线程连续、自动滚动、拿不到 thread id 时降级为无状态
- 滚动摘要有界且不含原始日志
- 陈旧锁回收；活锁快速失败
- 完整无人值守链路端到端（配假执行者）
- Codex 应用镜像默认关闭，且永不会破坏闭环

还有 `examples/hello-loop/` —— 一个自包含项目，队列是种子化的，所以 `run init`
零调用。完整走查见 [examples/hello-loop/README.md](examples/hello-loop/README.md)。

---

## 已知边界

在有所谓的事情上信任它之前，读这一段。

- **并发是设计了的，但没压测过。** 锁有单元覆盖和一个合成的陈旧锁测试；没人真的
  用两个 Agent 对同一个线程上过负载。
- **只在 Windows + `codex-cli 0.159.2` 上验证过。** 代码里有地方假设 Windows 路径。
  macOS/Linux 是"看起来对"，不是证明。
- **`codex exec --json` 的事件格式是内部细节**，不是公开契约。它是从二进制里逆出来的，
  用测试钉在一个版本上。Codex 升级可能破坏 token 记账、线程 id 捕获或用量解析 ——
  闭环会降级成无状态模式而不是崩掉，但升级后要检查 `state/runs/`。
- **大脑需要一个能创建子进程的运行时。** `codex exec` 是作为子进程用管道 stdio 驱动的。
  在禁止这个的沙箱里（DSH 的 `workspace-write` 就会），`ask` 会报 `spawn EPERM`。
  它被归为基建失败并且**不计入预算**，但闭环走不完。
- **从没跑过真实的返工循环** —— `rework → pass` 这条路径是靠改卡片测的，从没让执行者
  真的重做一遍工作。
- **MCP 通道没实现。** 需求里提到 `codex-controller-mcp` 和 Codex API；两者都是有
  文档化降级路径的桩，不是能用的适配器。
- **`codex exec resume` 接受的 flag 比全新 `exec` 少得多** —— 没有 `-C`、`-s`、`-m`。
  所以工作目录就是子进程的 cwd，而沙箱/模型只在一条线程的第一次调用生效。处理了，但反直觉。

## 它是怎么被造出来的

它挺过来的大部分 bug，只有真的跑起来才能发现：

- `createdAt` 没重置，导致一个长期项目的**每次**重新 `init` 都会撞上墙钟截止时间，
  于是它永远跑不起来
- 除非配置里也写了 `enabled: true`，`--mirror-thread` 会被**静默忽略**
- 幂等键不含卡片的字节，于是改过的卡会拿到陈旧裁决
- `process.exit()` 会截断管道 stdout，于是链式轮次的裁决凭空消失
- 每个嵌套轮次都把自己的输出静音了，于是链读到的永远是空
- 被拒绝的子进程创建被计入了预算，尽管模型从未被触达

它们现在都有回归测试。值得抄的习惯是：**三层测试** —— 离线断言、真实往返、真实执行者，
因为每一层都漏掉了另外两层抓到的东西。

## 许可证

MIT
