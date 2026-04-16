# L:\game_edit 项目阶段性完整历史总结（2026-04-15 会话整理）

## 1. 文档目的

本文档用于完整记录 2026-04-15 这轮围绕 `L:\game_edit` 的分析、实现、调试、架构决策与当前卡点。

目标是让后续继续开发的人，在**不回看整段对话**的情况下，也能快速理解：

- 今天具体解决了什么问题
- 为什么要这么改
- 技术路线是如何收敛的
- 当前哪些链路已经打通
- 还有哪些问题没有完全收口

---

## 2. 本轮工作的核心目标

本轮工作的核心目标，最开始是排查：

> **为什么前端点击 create game 后，Upstash Box 里的 Codex app-server 看起来启动了，但四个 canonical 游戏文件始终为空，且最终经常 fallback / timeout。**

随着排查推进，目标逐步扩展为：

1. 拆清 `Create Session / OAuth / Init Codex / Send` 的职责
2. 弄清楚 prompt 是否真的进入 Codex
3. 弄清楚 `thread/start` 与 `thread/resume` 的可恢复条件
4. 保留 `raw Codex + OAuth` 路线，不切官方 `box.agent.stream()`
5. 让 create 流程至少先跑通到“可生成、可写文件、可预览、可交互”
6. 在不篡改模型产物的前提下，让 Codex 尽量遵守本项目自己的 package/manifest contract

---

## 3. 关键判断与架构路线收敛

### 3.1 关于 prompt 是否没发进去

最初怀疑：

- app-server 启动了
- 但 prompt 可能根本没传进去

后续通过代码与 `.codex-daemon-request.json` 确认：

- `turn/start`
- `threadId`
- 用户 prompt

都已经真正发进了 Box 内的 Codex daemon。

因此：

> **“prompt 没发进去”不是主问题。**

---

### 3.2 关于 `thread/resume` 的判断

在今天的实测中，`Init Codex` 阶段可以走到：

- `account/login/completed`
- `thread/start`

但后续新的请求如果重新起一个 runner，再做：

- `thread/resume(threadId)`

会收到：

- `no rollout found for thread id ...`

这个结论非常关键，说明：

> **不能只靠 `threadId` 在新进程中恢复旧会话。**

于是本轮正式放弃了：

- `one-shot runner + later thread/resume`

作为 steady-state 主路径。

---

### 3.3 官方 Upstash agent API 是否可走

今天也专门评估过：

- `box.agent.run()`
- `box.agent.stream()`

最终判断是：

- 官方 agent API 更偏向 `apiKey / stored key`
- 不适合无缝复用当前这条 `raw Codex + OAuth` 路线
- 如果强行绕过去，长期可维护性差

因此本轮明确保留：

> **raw Codex + OAuth**

而不是切官方 agent abstraction。

---

### 3.4 本轮正式选定的主架构

本轮中途明确收敛到：

> **长驻 app-server + 同一 thread + OAuth 复用 + Box 内长期工作区**

核心原因：

- 用户明确需要多轮 create / modify / debug 的上下文连续性
- 每次新 thread 不是正式方案
- `threadId` 单独不足以保证 continuity

最终形成的 continuity 约束理解是：

- same `boxId`
- same `codexHome`
- same live daemon
- same `threadId`
- 首轮 turn 已 materialize rollout

---

## 4. 本轮已落地的主要实现

### 4.1 前端流程拆分与 UI 可观测性增强

涉及文件：

- `src/components/CodegenAppShell.tsx`
- `src/components/CodexPanel.tsx`
- `src/lib/ai-sessions/client.ts`

已做的事：

- 把前端会话流拆清为：
  - `Create Session`
  - `OAuth`
  - `Init Codex`
  - `Send`
- 新增单独的 Codex panel
- 把 init transcript / turn transcript 从普通聊天消息里拆开显示
- 前端开始直接显示 transport / thread / transcript 状态

后续又进一步调整为：

- `Init Codex` 保留，但 `Send` 也可以自动补 init

目的不是改变架构，而是避免用户被“必须先点 init”卡住。

---

### 4.2 AI session continuity state 扩展

涉及文件：

- `src/lib/ai-sessions/types.ts`
- `src/lib/db/schema-pg.ts`
- `src/lib/ai-sessions/repository.ts`
- `src/lib/ai-sessions/service.ts`

已新增/扩展字段包括：

- `codexHomeKey`
- `daemonStatus`
- `threadMaterializedAt`
- `continuityState`
- `resumeEligibility`
- `supervisorInstanceId`
- `supervisorLeaseEpoch`
- `lastSupervisorHeartbeatAt`
- `lastFailureCode`

目的：

> 不再只用 `threadId` 粗略代表 continuity，而是显式表达“当前 thread 是否只是 provisional、是否已 materialized、是否可以 resume”。

---

### 4.3 Session supervisor 抽象

涉及文件：

- `src/lib/ai-sessions/supervisor.ts`
- `src/lib/ai-sessions/service.ts`

已做的事：

- 引入内存级 supervisor singleton
- 让一个 AI session 对应一个 runtime 语义上的 owner
- 维护：
  - `supervisorInstanceId`
  - `supervisorLeaseEpoch`
  - `daemonStatus`
  - `continuityState`
  - `threadId`

虽然这还不是完整的分布式/跨重启 supervisor，但已经把“每个请求自己猜 session 状态”的模式替换掉了。

---

### 4.4 daemon 化 app-server 通道

涉及文件：

- `src/lib/ai-sessions/app-server-daemon.ts`
- `src/lib/ai-sessions/service.ts`
- `src/lib/sandbox/providers/upstash-box.ts`

已做的事：

- 在 session workspace 下写入：
  - `.codex-daemon.mjs`
  - `.codex-daemon-config.json`
  - `.codex-daemon-request.json`
- 通过本地 daemon 的 `/health` 与 `/execute` 进行请求
- steady-state 发送不再依赖 fresh runner + `thread/resume`
- turn 主路径改成走 **same live daemon**

这一步之后，之前最核心的 `thread/resume` 失败问题被绕开，create 主链开始能实际工作。

---

### 4.5 Box 内写文件失败问题的解决

排查 rollout 后确认：

- Codex 已在同一 thread 内执行
- 但真正写文件时，被它自己的 workspace-write sandbox 卡住
- 关键错误：
  - `bwrap: No permissions to create a new namespace`

因此将 app-server 的 sandbox 参数从：

- `workspace-write`

调整为默认：

- `danger-full-access`

涉及文件：

- `src/lib/ai-sessions/app-server-stdio.ts`

这是今天非常关键的一步。修改后：

> **Codex 终于能够把生成的内容真正写进 session workspace 的四个 canonical 文件。**

---

### 4.6 prompt 强约束与 workspace contract 注入

涉及文件：

- `src/lib/ai/codex-workspace-prompts.ts`
- `src/lib/package/contracts.ts`
- `src/lib/package/workspace-contract.ts`
- `src/lib/ai-sessions/service.ts`

最开始做的是：

- 直接在 prompt 里加入强约束：
  - 必须写 4 个文件
  - manifest 必须合法
  - 不能只回复 prose

但随后发现：

- 把完整 schema 全塞进 prompt 很浪费上下文

于是改成：

- bootstrap workspace 时自动写入：
  - `WORKSPACE_CONTRACT.md`
  - `.game-edit-contract.json`
- prompt 中只保留短引用：
  - 先读取 contract 文件
  - 严格遵守 manifest schema

这一步让模型约束来源与后端校验来源统一了。

---

### 4.7 agent text recovery 兜底

涉及文件：

- `src/lib/ai/codex-agent-text-package.ts`
- `src/lib/ai/executors/app-server-package-executor.ts`
- `src/lib/ai-sessions/service.ts`

增加了一条兜底逻辑：

如果：

- turn 完成
- workspace 文件还是空/非法
- 但 `agentText` 里其实包含了合法 package JSON

则：

- 解析 agentText
- 校验 package
- 回写 4 个 canonical 文件

这一步是为了解决“模型说出来了，但没真正写文件”的情况。

---

### 4.8 preview 可交互性问题的解决

涉及文件：

- `src/components/SandboxPreview.tsx`
- `tests/components/sandbox-preview.test.ts`

本轮后期生成的游戏能显示但不能玩。

最终通过浏览器控制台确认：

- 预览 iframe 是：
  - `srcdoc`
  - `sandbox="allow-scripts"`
- 生成的 `game.js` 顶层直接访问 `localStorage`
- 结果在预览环境中抛出：
  - `SecurityError`

一旦这里抛错，后面的：

- `startButton.addEventListener(...)`
- `window.addEventListener('keydown', ...)`

都不会执行，所以“按钮 hover 正常但点击没反应”。

解决方式不是放宽 iframe 到 `allow-same-origin`，而是：

- 在 preview 文档中注入一个 storage shim
- `localStorage` / `sessionStorage` 不可用时自动退化为内存版 storage

修改后：

> **生成的游戏已经可以在右侧预览区直接游玩。**

---

## 5. 今天踩过并解决掉的关键问题

### 问题 A：Init 成功但 `Send` 仍无法解锁

#### 现象
- Init Codex 完成后，Send 按钮仍不可点

#### 原因
- UI gating 使用了旧快照状态，没正确用到实时 transport 状态

#### 解决
- 调整 gating 与自动 init 逻辑
- 最终改成 `Send` 可以自动补 init

---

### 问题 B：`thread/resume` 失败

#### 现象
- `thread/resume(threadId)` 返回 `no rollout found for thread id ...`

#### 原因
- 新进程 + 老 threadId 无法恢复旧会话
- `threadId` 不是完整 continuity proof

#### 解决
- 放弃 fresh runner + later resume 作为 steady-state 主路径
- 改为 same daemon + same thread

---

### 问题 C：Codex 能运行但 4 个文件始终空

#### 现象
- turn 跑完，workspace 仍是 0B 文件

#### 原因
- Codex 内部 `workspace-write` 依赖 bwrap namespace
- Upstash Box 内部无法创建新 namespace

#### 解决
- 改 sandbox 模式为 `danger-full-access`

---

### 问题 D：manifest schema 持续不匹配

#### 现象
- `editable` 写成 boolean
- `capabilities` 写成自定义字符串

#### 原因
- 模型按自己的语义发明 manifest，不知道项目自己的 contract

#### 解决
- 注入 `WORKSPACE_CONTRACT.md` 和 `.game-edit-contract.json`
- prompt 中要求严格读取 contract 文件

---

### 问题 E：生成出的游戏能显示但不能操作

#### 现象
- UI 画出来了
- hover 正常
- 点击无反应
- 键盘无反应

#### 原因
- `localStorage` 在 sandboxed iframe 中抛 `SecurityError`
- 脚本初始化中断，后续事件监听根本没绑定

#### 解决
- `SandboxPreview` 注入 storage shim

---

## 6. 今天已经打通的主链路

截至今天，以下主链路已经基本打通：

1. Create Session
2. Host OAuth 绑定
3. Init Codex / daemon 健康检查
4. 同一 thread 中 `turn/start`
5. Box 内成功写入 `index.html / game.js / style.css / manifest.json`
6. Preview 能正确内联并运行生成的代码
7. 生成出的小游戏可以在右侧 sandbox 预览中直接游玩

这标志着：

> **从“能起 app-server 但不落文件”到“同线程生成 + 可写文件 + 可预览 + 可交互”的主线已经跑通。**

---

## 7. 当前仍未完全收口的问题

### 7.1 modify 路径的 persistence failure

这是当前最明显的遗留问题。

#### 现象
- 在“改游戏”里发送修改请求后，很快出现：
  - `Server persistence failed; the generated package was not adopted as the canonical head.`
- 视觉上像“没改成功”

#### 当前判断
更像是：

1. `/api/package/modify` 已经执行并拿到了 `response.package`
2. `projectService.saveGeneratedPackage(...)` 失败
3. 前端在 `persistenceWarning` 分支里没有保留 `locallyUpdated`
4. 导致本地 modify 结果在 UI 上被丢掉，只留下 warning 消息

关键位置：

- `src/app/api/package/modify/route.ts`
- `src/lib/projects/service.ts`
- `src/components/CodegenAppShell.tsx`（大约 1119-1171 行附近）

#### 当前状态
- **尚未修复**
- 这是今天结束时最主要的残留问题之一

---

### 7.2 `saveGeneratedPackage()` 失败原因未完全暴露

目前能确认：

- 持久化失败确实发生了

但还没有完全把底层错误透明显示到 UI 或日志里，所以还不清楚具体是哪一步失败：

- storage 写失败
- insertVersion 失败
- updateCurrentVersion 失败
- 其他 durability 问题

#### 当前状态
- **尚未收口**

---

### 7.3 tester / checker 仍然较弱

今天后面已经看到：

- `No runTests hook defined`

也就是说：

- preview READY 已经可以过
- 但 tester/checker 目前更多是基础可运行性信号
- 还没有形成严格的游戏功能自动验收

这不是当前主阻塞项，但属于后续可加强项。

---

## 8. 今天的重要技术路线选择总结

### 最终保留的路线
- `raw Codex + OAuth`
- `长驻 app-server + same thread`
- contract 文件注入 workspace
- preview 内 storage shim

### 明确放弃/不作为正式方案的路线
- 官方 Upstash `box.agent.stream()` 作为主方案
- 每次请求新 thread
- 依赖 `threadId` 单独做恢复
- 在返回链路里偷偷修 manifest 作为正式做法

### 采取的关键实现策略
- daemon 代替 one-shot runner steady-state
- `danger-full-access` 代替 `workspace-write`
- contract 文件代替长 prompt 内嵌 schema
- storage shim 代替放宽 iframe 到 `allow-same-origin`

---

## 9. 当前项目状态结论

可以说今天已经把这个项目从一个“看起来能跑、但实际上到处卡住”的状态，推进到了：

> **Codex 已经能在 Upstash Box 中通过长驻 daemon + 同一 thread，真正生成小游戏文件，并让用户在右侧预览里直接玩起来。**

这是本轮最大的成果。

当前主要剩余问题已经收敛得比较清楚：

1. modify 路径的 persistence fail
2. persistence fail 时前端本地结果丢失
3. 更完整的 runTests / checker 验收能力还没补上

---

## 10. 后续建议优先级

建议下一轮优先处理：

### 优先级 1
修 modify 路径在 `persistenceWarning` 分支的 UI 行为：

- 就算服务端保存失败，也先保留本地生成出来的 modify 结果

### 优先级 2
把 `saveGeneratedPackage()` 的底层错误原因完整暴露出来，确认 persistence fail 的真实根因。

### 优先级 3
再考虑补更强的：

- `runTests` hook
- 更像产品质量门的 tester/checker

---

## 11. 本轮一句话总结

> **今天最大的成果，是把 `L:\game_edit` 的 Codex 远程执行链，从“只能启动但不能可靠生成/运行”，推进到了“同线程生成、真实写文件、预览可运行、游戏可直接玩”的阶段；当前主卡点已经缩小到 modify 持久化失败与前端失败分支状态丢失。**
