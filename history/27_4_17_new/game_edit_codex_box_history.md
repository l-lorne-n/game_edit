# L:\game_edit 项目阶段性完整历史总结（2026-04-17 新增补充整理）

## 1. 文档目的

本文档用于补充整理 2026-04-17 这一天围绕 `L:\game_edit` 继续推进的实现、分析与判断收敛，重点覆盖：

1. async turn 在“复杂 prompt 已可成功生成”之后，为什么前端仍然会出现长时间回传延迟。
2. 今天围绕 daemon / service / frontend 回传链路做了哪些第二阶段硬化。
3. `Neon / Blob / Box / 浏览器缓存` 四层存储语义今天是如何进一步厘清的。
4. `workspace version` 与 `project version` 两套版本语义今天是如何彻底拆清的。
5. 后续又补上的一个前端 UX 修复：允许基于只读 Box version 继续 modify，而不是一律禁止 Send。
6. 当前已经达到什么状态，以及接下来更值得继续做的是什么。

目标仍然是让后续接手的人，在**不回看整段对话**的情况下，也能快速理解：

1. 今天后半段到底解决了什么。
2. 哪些“看起来像 bug”的现象，最终被证明其实是语义口径不一致。
3. 代码层面又新增了哪些真实改动。
4. 当前主链路到底已经稳定到什么程度。

---

## 2. 本轮工作的核心目标

今天这一轮新增工作，起点其实是一个更具体的追问：

1. Box 里的代码已经写完了。
2. 复杂 prompt 也已经不再像早期那样频繁中途死亡。
3. 但前端仍然会在“代码已完成”之后，继续卡很久才拿到最终结果。

随着排查推进，本轮目标逐步收敛成下面几条：

1. 确认“慢回传”到底是不是前端固定 1 秒轮询造成的，还是 finalize 路径本身过重。
2. 把 daemon turn 的 `status / result / raw messages` 真正拆开，不再让浏览器端继续拉巨型 payload。
3. 让浏览器端 async turn polling 从固定 1 秒改成指数退避，减少无意义高频轮询。
4. 把仍然残留的 `executeMessage()` 生产主路径迁走，统一到 `submit / status / result` 模型。
5. 在第一轮 contract slimming 之后，再继续收敛真正的 finalize 热点：transport log 持久化。
6. 顺带把今天联调过程中暴露出来的几个产品语义问题彻底看清：
   - 为什么 Blob 里只看到 `v1 / v2`，但前端像是已经到 `v3`
   - 为什么换浏览器端口后游戏还在，但聊天记录不在
   - 为什么查看旧 Box version 时不该被前端硬性禁止继续 modify

---

## 3. 需求与判断的继续演进

### 3.1 今天正式确认：前端 1 秒轮询不是“慢回传”的唯一主因

今天重新回看了 async turn 路径后，先确认了两件事：

1. `CodegenAppShell.tsx` 里确实存在固定 1 秒 polling。
2. 这种轮询确实会制造压力，也会放大“系统还在忙”的体感。

但同时也进一步确认：

> **如果 Box 里的代码已经写完，而前端还要多等几分钟，这个现象不能只靠 polling 解释。**

因为真正的 terminal result 不是在 daemon 一结束就立刻可见，它还要经过 service finalize 的同步收尾路径。

也就是说：

> **轮询太密是问题，但 finalize 路径过重，才是这轮真正要继续动刀的核心。**

### 3.2 “status/result payload 过大”判断被坐实

今天继续对照代码之后，之前的判断被正式坐实：

1. daemon turn 原先会把大量 message 带进 turn record。
2. service 会继续把这批数据透传/扩散到浏览器可见结构里。
3. 前端 polling 一旦命中 terminal，拿到的不是一个轻量 status，而是带着很多额外内容的重 payload。

因此今天延续 27_4_17 原文档后半段的路线，明确继续推进：

> **compact metadata 与 raw messages 分离。**

### 3.3 第二轮判断进一步收敛：真正拖慢 finalize 的是 inbound transport log 持久化

在第一轮 contract slimming 落地之后，今天又出现了新的现象：

1. daemon/status/result 已经瘦身。
2. 前端 polling 也已经从固定 1 秒改成 backoff。
3. 但当 Box 中代码已经写完时，前端最终结果有时仍然回来得偏慢。

继续下钻后，今天把真正热点进一步压缩到了：

- `appendTurnInboundMessagesOnce()`
- `finalizeSuccessfulTurn()`
- `finalizeFailedTurn()`

也就是说：

> **问题不再是“浏览器什么时候 poll 到”，而是“poll 到 terminal 后，service 还在同步做很多重活”。**

其中最明显的一块，就是 inbound messages 的 transport log 持久化。

### 3.4 今天顺带把“项目版本”和“工作区版本”两套语义彻底拆清了

今天另一个非常关键的判断收敛，是把两套版本号正式区分开了：

1. `workspaceVersion`
   - 是 AI session / Box 内部工作区版本
   - 对应 `activeWorkspaceVersion` / `latestWorkspaceVersion`
   - 反映的是“session 工作头已经演进到第几版”
2. `project version`
   - 是正式归档版本
   - 对应 `projects.currentVersion` / `project_versions.version`
   - 对应 Blob 路径里的 `/projects/{projectId}/vN/...`

这一步之后，原来一个看起来像 bug 的现象被解释清楚了：

> **前端感觉已经到 v3，但 Blob 里新出现的是 v2，并不代表 Blob 算错了，而是两边本来就不是同一套编号。**

### 3.5 今天也确认了：项目聊天记录和项目文件并不在同一层持久化

通过换浏览器端口验证后，今天又进一步确认：

1. 换到 `localhost:3001` 后项目、游戏、snapshot 还能看到。
2. 但原本中间聊天面板里的历史对话没有跟着回来。

最后确认的判断是：

1. 项目文件 / 版本 / evaluator 等，已经在服务端持久层里。
2. 但 `project.messages` 这套前端展示层 transcript，主要仍然依赖浏览器本地 workspace cache。
3. Neon 里有足够数据重建“发生过什么”，但不足以无损恢复“前端当时那串聊天气泡长什么样”。

这一步对后续“聊天历史要不要正式落库”是重要前置判断。

### 3.6 对“查看旧 Box version 时是否应该禁止继续 modify”的判断也被明确推翻

今天后续又结合前端 UX 问题确认了一件事：

1. 后端其实已经支持基于 `session:v1` 这种 targetId 继续 modify。
2. 它的真实语义是：
   - 读 `session:v1` 对应的 workspace base
   - 复制到 `latest + 1`
   - 再让 codex 在这个新 head 上继续改
3. 真正阻止这条路径的，是前端把“正在浏览只读 Box version”直接等价成“不能 Send”。

所以今天最终确认：

> **问题不在后端语义，而在前端 UX 先把用户拦死了。**

---

## 4. 今天继续落地的主要实现

### 4.1 daemon turn contract 继续瘦身：metadata 与 raw messages 分离

涉及文件：

- `L:\game_edit\src\lib\ai-sessions\app-server-daemon.ts`
- `L:\game_edit\src\lib\ai-sessions\service.ts`
- `L:\game_edit\src\lib\ai-sessions\types.ts`
- `L:\game_edit\src\lib\ai-sessions\client.ts`
- `L:\game_edit\src\app\api\ai\sessions\[id]\messages\[turnId]\route.ts`
- `L:\game_edit\src\app\api\ai\sessions\[id]\messages\[turnId]\result\route.ts`

继续落地的内容包括：

1. daemon turn record 不再把整份 message history 直接塞进 compact turn metadata。
2. turn metadata 与 raw messages 分成两条读取路径。
3. raw messages 单独落成 `.messages.jsonl`。
4. service finalize 时按需读取 raw messages，而不是默认向浏览器继续扩散。
5. 浏览器可见的 `status / result` contract 明显更轻。

这一轮的核心意义是：

> **浏览器不再默认承担 daemon 内部日志的传输负担。**

### 4.2 async turn polling 已经从固定 1 秒收敛为指数退避

涉及文件：

- `L:\game_edit\src\lib\ai-sessions\async-turn-polling.ts`
- `L:\game_edit\src\components\CodegenAppShell.tsx`

已落地内容：

1. 抽出了可单测的 polling helper。
2. async turn polling 现在按：
   - `1s`
   - `2s`
   - `4s`
   - `8s`
   - `15s`
   - 后续封顶 `15s`
3. turn id 变化时会 reset cadence。
4. terminal finalize 路径与 cleanup 时机做了专门修复，避免 terminal poll 命中后因为 effect cleanup 时序导致补拉断掉。

这部分不只是“少 poll 一些”，还包含了一轮真实的 terminal finalize 时序修正。

### 4.3 `executeMessage()` 的 live production caller 已经迁出主路径

涉及文件：

- `L:\game_edit\src\lib\ai\executors\app-server-package-executor.ts`
- `L:\game_edit\src\lib\ai-sessions\service.ts`

已落地内容：

1. 生产主路径不再继续直接依赖 `executeMessage()`。
2. 改成统一使用：
   - `submitMessageTurn()`
   - `getMessageTurnResult()`
3. `executeMessage()` 仅保留为兼容层，而不是主语义。

这一步的意义在于：

> **submit / status / result 终于变成真正的主链路，而不是旁路实验。**

### 4.4 daemon 终态持久化顺序也做了修正

涉及文件：

- `L:\game_edit\src\lib\ai-sessions\app-server-daemon.ts`

今天又修了一个非常细但重要的点：

1. 原先 terminal 终态可能先写 compact `.json`
2. raw `.messages.jsonl` 后写
3. service 在窗口期内可能看到“metadata 已终态，但 raw messages 还没落盘”

已改为：

1. 先写 retained raw messages
2. 再写 compact metadata

这样终态可见性与 raw messages 的可读性才是同一时刻成立。

### 4.5 第二轮 finalize 优化已经落地：不再为 delta/chunk transport logs 买单

涉及文件：

- `L:\game_edit\src\lib\ai-sessions\service.ts`
- `L:\game_edit\src\lib\ai-sessions\repository.ts`
- `L:\game_edit\src\lib\ai-sessions\transport-runtime.ts`
- `L:\game_edit\src\lib\ai-sessions\types.ts`

这一轮真正新增的内容包括：

1. finalize inbound transport logs 不再持久化 `*/delta` / `*/chunk` 类高频刷屏消息。
2. retained inbound logs 改成 batch insert，而不是逐条 DB 写入。
3. session 的 `transportLastActivityAt / transportIdleDeadlineAt` 只在 batch 结束后更新一次。
4. 对并发 finalize 路径，使用确定性 log id + `onConflictDoNothing()` 去重。
5. runtime transcript 也按 `entry.id` 做去重，避免只是 DB 层去重、运行时仍然重复。

这一步的意义非常直接：

> **今天真正把 finalize 路径里最重的同步热区继续压下去了。**

### 4.6 围绕 `Neon / Blob / Box / 浏览器缓存` 的存储语义已经进一步厘清

今天虽然这部分不是直接改代码，但它已经成为非常重要的结构性结论：

1. Neon 是结构化数据库：
   - `projects`
   - `project_versions`
   - `ai_sessions`
   - `ai_session_turns`
   - `ai_session_events`
   - `ai_session_checkpoints`
   - `ai_session_transport_logs`
2. Blob 是对象存储，只存正式 project version 对应的 canonical 文件。
3. Box 是运行时工作区，不等于持久化归档层。
4. 浏览器本地 cache 还承担着 `project.messages` 这类 UI transcript 的暂存角色。

今天这个判断非常关键，因为它解释了：

- 为什么换端口后项目还在，但聊天记录不在
- 为什么 Blob 里只有 `v1 / v2`，但当前工作头像是更靠后

### 4.7 后续又补上的前端 UX 修复：允许基于只读 Box version fork 新 head 继续 modify

后续又结合前端问题，补了一项很重要但改动不大的 UX 修复。

涉及文件（前端侧）：

- `L:\game_edit\src\components\CodegenAppShell.tsx`

确认并修正的方向是：

1. 浏览只读 Box version（如 `session:v1`）时，不再一律禁止 Send。
2. modify 分支在 `viewedAiSessionVersionId + viewedAiSessionVersion` 存在时：
   - 直接用这个 version 作为 base
   - `targetId = viewedAiSessionVersionId`
   - `currentPackage = viewedAiSessionVersion.package`
3. 不再错误地只认本地 snapshot，而忽略 `session:v*`。
4. turn 202 accepted 后，自动清理 viewed version state，回到 Active Head，让用户能看见新版本正在生成。
5. “Cannot send requests while viewing a read-only Box version” 这类硬拦截文案，被改成更符合真实语义的提示。

这一步的本质是：

> **前端 UX 终于和后端“基于任意历史 Box version fork 新 head 继续 modify”这套语义对齐了。**

---

## 5. 今天进一步坐实的关键问题与解释

### 问题 A：为什么 Box 里代码已经写完，前端还慢很久才显示？

#### 现象

1. Box 中的 workspace 文件已经完成。
2. 前端仍然长时间拿不到最终 result。

#### 进一步确认后的原因

1. terminal poll 命中后，service 还要继续跑 finalize。
2. finalize 之前一度还在逐条写 inbound transport logs。
3. 这条路径即使 daemon 已完成，也会继续阻塞最终结果返回。

#### 最终解决方向

1. 先做 compact contract slimming。
2. 再做第二轮 finalize-path 优化：
   - drop delta/chunk
   - batch insert
   - 并发去重

### 问题 B：为什么前端像是到 v3，但 Blob 只出现 v2？

#### 现象

用户会觉得：

1. 当前工作已经改到更后面的版本。
2. 但 Blob 中出现的仍然只是 `v2`。

#### 原因

因为两边根本不是同一套编号：

1. `workspaceVersion` 是 AI session / Box 工作区版本。
2. `project version` 是正式归档版本。
3. project version 只会按 `currentVersion + 1` 连续增长，不会跳号。

#### 最终判断

这不是 Blob 命名错误，而是：

> **用户前端看到的是工作区 head 演进，而 Blob 看到的是正式持久化版本。**

### 问题 C：为什么换端口后项目还在，但聊天记录不在？

#### 现象

换到新的 `localhost:3001` 后：

1. 项目、游戏、snapshot 还能看到。
2. 原来中间面板中的聊天记录看不到了。

#### 原因

1. 项目版本、project metadata、AI session 数据已在服务端。
2. 但 `project.messages` 仍主要来自浏览器本地 workspace cache。
3. `localhost:3000` 与 `localhost:3001` 对浏览器来说是不同 origin，本地缓存不共享。

#### 最终判断

这说明：

> **项目文件不是只存在浏览器缓存里，但项目聊天 transcript 目前主要还是浏览器缓存优先。**

### 问题 D：为什么此前查看旧 Box version 时不让继续 modify？

#### 现象

当用户从当前 head 切到 `session:v1` 之类的只读 Box version 视图后，前端会直接提示：

- `Cannot send requests while viewing a read-only Box version...`

#### 原因

前端把“正在浏览只读版本”直接等价成了“不能发起 modify”。

#### 最终判断

后端其实已经支持：

1. 读取这个历史 version 作为 base
2. 复制到 `latest + 1`
3. 在新 head 上继续 modify

所以最终修正方向就是：

> **前端不该禁止，而应该允许用户从历史 Box version fork 新 head 继续改。**

---

## 6. 当前代码状态

截至今天这轮补充整理时，项目已经处于如下状态：

1. async turn 主链路已经不再只是早期实验，而是 submit / status / result 真正承担主职责。
2. daemon metadata / raw messages 已分流，浏览器不会默认再背整份 daemon payload。
3. finalize 路径的第二轮性能优化已经落地，transport log 持久化不再是之前那种“把 delta/chunk 逐条刷进 DB”的模式。
4. 前端 polling 已经改成指数退避，terminal finalize 时机也专门修正过。
5. 版本语义、存储语义、项目 transcript 语义已经基本厘清。
6. 基于历史 Box version fork 新 head 继续 modify 的前端 UX 也已经收口。

换句话说：

> **今天这一轮之后，系统的主要问题已经不再是“链路完全不通”或“重度阻塞 bug”，而更多转向产品语义、一致性与持久化体验的进一步打磨。**

---

## 7. 当前更值得继续推进的方向

如果继续往下做，今天更值得继续推进的方向大致是：

1. **聊天 transcript 正式持久化**
   - 现在 Neon 足以重建“发生过什么”，但不足以无损重建“前端聊天面板长什么样”。
   - 如果希望跨端口、跨浏览器、跨设备都保留同一份项目对话历史，这一层需要显式落库。

2. **project version 与 workspace version 的产品表达进一步统一**
   - 现在底层语义已经厘清，但 UI 上仍然容易让用户把它们混成一件事。
   - 后续可以考虑更明确区分：
     - 工作头版本
     - 正式归档版本

3. **AI session 成功结果与 project 归档之间的关系进一步产品化**
   - 当前仍是：工作区成功 ≠ 正式归档成功。
   - 是否要自动 checkpoint / 自动 archive，需要后续继续收敛。

4. **继续观察 finalize-path 压缩后的真实体感收益**
   - 第二轮性能优化已经落地，但后续仍值得继续观察：
     - 极大 prompt
     - 极长 agentText
     - 多轮连续 modify/debug
   - 看是否还存在新的同步热区。

---

## 8. 总结

今天这轮新增整理，最大的价值不再是“先把某条链路打通”，而是把 27_4_17 原文档里已经启动的 async-turn 改造继续向前推了一步，并进一步把系统的几个关键语义彻底拆清：

1. `status / result` 与 `raw messages` 不再混在一起。
2. finalize 的真正热点从“抽象慢”压缩成了具体的 transport log 持久化问题，并已经做了第二轮优化。
3. `workspace version` 与 `project version` 不再混成一套编号。
4. `Neon / Blob / Box / 浏览器缓存` 的职责边界已经比此前清晰很多。
5. 基于历史 Box version 继续 modify 的前端 UX 也终于和后端语义对齐。

因此，今天这一轮更像是：

> **从“链路能跑”继续迈向“链路更轻、更稳、语义更清楚、体验更一致”。**
