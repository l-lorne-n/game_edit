# L:\game_edit 项目阶段性完整历史总结（2026-04-14 会话整理）

## 1. 文档目的

本文档用于完整总结本次对话中，围绕 `L:\game_edit` 项目进行的所有分析、设计、实现、调试、问题定位、方案演进与当前状态。

目标是让后续继续开发的人，在**不回看整段对话**的情况下，也能快速理解：

- 这个项目当前想做什么
- 为什么这样做
- 已经做了什么
- 踩过哪些坑
- 每个坑的原因、位置、现状
- 目前还剩什么没完全收口

---

## 2. 本轮工作的核心目标

本轮工作的主目标是把 `L:\game_edit` 从“本地/浏览器主导的小游戏生成编辑器”，逐步推进为：

> **基于 Upstash Box 的远程工作区 + Codex app-server 执行器 + Host Token Service 托管 OAuth 生命周期 + Blob/Neon 持久化版本体系**

更具体地说，本轮的核心探索方向包括：

1. 保留 `create / modify / debug` 作为**产品层模式**
2. 把底层执行引擎逐步从旧的多 agent / 旧模型调用实现，替换为：
   - Upstash Box
   - Codex app-server
   - 外部托管的 ChatGPT OAuth token 生命周期
3. 保留：
   - RouteDecision
   - ExecutionTrace
   - RequestWorkbench
   - workspace / snapshot / version / project persistence
4. 不再直接把 `auth.json` 塞进远端环境
5. 建立浏览器 OAuth UI + host token service + bind token + AI session + checkpoint/promote 的完整链路

---

## 3. 需求与架构判断的演进过程

### 3.1 最初阶段：从 Blob/Neon 文件管理迁移后的下一步

最开始的讨论围绕：

- `L:\intern_26\playmimi_main\playmimi-main` 里已有的 Blob/Neon/文件管理能力
- 已经合并到 `L:\game_edit`
- 下一步应该继续补什么

结论逐渐收敛为：

- `L:\game_edit` 已经有 Blob + Neon + 基本文件版本化能力
- 真正缺的是“远程可写执行环境 + AI 可持续修改/测试能力”

### 3.2 从 Vercel Sandbox 转向 Upstash Box

最初考虑过 Vercel Sandbox，但因为：

- 普通 sandbox 生命周期有限
- persistent sandbox 仍是 beta
- 账号/套餐限制明显

因此转向更偏“持久工作区”的 Upstash Box。

### 3.3 从“直接用内置 Codex agent”转向“自管 auth / 自控执行器”

因为 Upstash 内置 Codex agent 更偏 API key 路径，而用户明确希望走：

- ChatGPT OAuth
- bind token
- host-managed auth lifecycle

因此继续推进：

> **Upstash Box + Codex app-server + host token service**

### 3.4 从“把 Codex 整体塞进去”转向“保留产品层，替换执行引擎”

后续进一步确认：

- `create / modify / debug` 不是模型内部 mode，而是产品层 mode
- Codex 的 `plan / execute` 不是它们的等价替代

因此最终架构判断是：

#### 必须保留的产品层
- `create / modify / debug`
- RouteDecision
- ExecutionTrace
- RequestWorkbench
- snapshot/version/workspace/project persistence

#### 逐步替换的执行层
- 旧模型编排器
- 旧 prompt orchestration
- 旧 generate/modify/debug 内部 AI 调用逻辑

---

## 4. 当前已经落地的主要实现（代码层）

下面是本轮已经真实落进 `L:\game_edit` 的核心实现。

### 4.1 AI Session / Lease / Checkpoint 基础设施

涉及文件：

- `src/lib/db/schema-pg.ts`
- `src/lib/db/index.ts`
- `src/lib/ai-sessions/types.ts`
- `src/lib/ai-sessions/repository.ts`
- `src/lib/ai-sessions/service.ts`
- `src/app/api/ai/sessions/route.ts`
- `src/app/api/ai/sessions/[id]/route.ts`
- `src/app/api/ai/sessions/[id]/bootstrap/route.ts`
- `src/app/api/ai/sessions/[id]/checkpoint/route.ts`
- `src/app/api/ai/sessions/[id]/events/route.ts`
- `src/app/api/ai/sessions/[id]/messages/route.ts`

已实现内容：

- AI session 持久化结构
- lease / revoke / checkpoint 状态
- session 事件流记录
- project 级 session 列表
- AI session bootstrap / checkpoint / messages / events API

### 4.2 Host Token Service 客户端与服务端本体

涉及文件：

- `src/lib/host-tokens/types.ts`
- `src/lib/host-tokens/client.ts`
- `src/lib/host-tokens/server/config.ts`
- `src/lib/host-tokens/server/store.ts`
- `src/lib/host-tokens/server/service.ts`
- `src/lib/host-tokens/server/http.ts`
- `src/lib/host-tokens/server/index.ts`
- `src/lib/host-tokens/server/neon-store.ts`

已实现内容：

- Host token bootstrap / refresh / revoke contract
- 浏览器 OAuth 开始 / callback / attempt 查询
- Host auth session 存储
- bind token 机制
- AI session 与 host auth binding
- privileged routes bearer key 校验
- 默认已切换为 **Neon-backed store**

### 4.3 浏览器 OAuth UI

涉及文件：

- `src/components/CodegenAppShell.tsx`
- `src/lib/ai-sessions/client.ts`
- `src/app/api/codex/host/browser/start/route.ts`
- `src/app/api/codex/host/browser/callback/route.ts`
- `src/app/api/codex/host/browser/attempt/[authRequestId]/route.ts`
- `src/app/api/codex/host/session/latest/route.ts`

已实现内容：

- Host OAuth 面板
- Connect OAuth / Reconnect OAuth 按钮
- 当前 host auth 登录状态展示
- popup 登录回流 + `postMessage` 回主页面

### 4.4 Upstash Box Provider

涉及文件：

- `src/lib/sandbox/types.ts`
- `src/lib/sandbox/index.ts`
- `src/lib/sandbox/providers/upstash-box.ts`
- `src/lib/config/infra.ts`

已实现内容：

- `upstash-box` provider 接入
- 读取 Box 配置
- 文件写入/读取
- shell command 执行
- Codex runtime provisioning
- app-server 默认命令配置

### 4.5 Box 级 Codex runtime provisioning

已实现内容：

- 先探测平台（Linux / 架构）
- 下载对应 release 资产
- 解压到固定目录：`/workspace/home/.local/codex-runtime`
- 执行版本校验

当前平台适配已知逻辑：

- `linux + aarch64` → `codex-aarch64-unknown-linux-musl.tar.gz`
- `linux + x86_64` → `codex-x86_64-unknown-linux-musl.tar.gz`

### 4.6 Unified route engine 骨架

涉及文件：

- `src/lib/ai/codex-package-task.ts`
- `src/lib/ai/package-route-decision.ts`
- `src/lib/ai/executors/types.ts`
- `src/lib/ai/executors/legacy-package-executor.ts`
- `src/lib/ai/executors/app-server-package-executor.ts`
- `src/app/api/package/generate/route.ts`
- `src/app/api/package/modify/route.ts`
- `src/app/api/package/debug/route.ts`

已实现内容：

- 保留 create / modify / debug 产品层语义
- route 内部执行引擎统一收口
- requestedEngine / actualEngine / fallbackReason
- 服务端 route decision 重算

### 4.7 Session workspace 隔离

涉及文件：

- `src/lib/ai-sessions/workspace.ts`
- `src/lib/ai-sessions/service.ts`

已实现内容：

- 每个 AI session 独立 workspace：
  - `sessions/<sessionId>/...`
- bootstrap 时 hydrate 到 session 目录
- checkpoint 时只读 session 目录

---

## 5. 已经踩过的主要问题、原因、位置、解决方案

下面按“问题 → 原因 → 位置 → 已采取方案”总结。

### 问题 A：AI session 创建时报数据库缺表

#### 现象
- 点击 `Create Session` 报 SQL 查询失败

#### 原因
- Neon 真实库里没有 `ai_sessions` / `ai_session_events` / `ai_session_checkpoints` 表
- 测试里因为有 mock，没有暴露

#### 位置
- `src/lib/ai-sessions/repository.ts`

#### 解决方案
- 加了 runtime schema bootstrap，第一次用仓库时自动确保相关 enum/table 存在

---

### 问题 B：OAuth 登录一开始直接 `unknown_error`

#### 原因
- 一开始错误地把 callback 打回 `localhost:3000/api/.../callback`
- 但 `codex_poc` 的真实成功流其实是：
  - **localhost callback server**
  - 默认 `http://localhost:1455/auth/callback`

#### 位置
- `src/lib/host-tokens/server/config.ts`
- `src/app/api/codex/host/browser/start/route.ts`
- `src/app/api/codex/host/browser/callback/route.ts`

#### 解决方案
- 对齐 `codex_poc` 的 callback 语义
- 引入本地 callback server
- 浏览器登录由 popup + localhost callback 完成

---

### 问题 C：latest active auth session 自动绑定歧义过大

#### 原因
- 一开始 host bootstrap 会自动拿“最新 session”来绑 AI session
- 这样会出现：
  - 绑错账号
  - 多窗口冲突
  - 上一次登录混入当前会话

#### 位置
- `src/lib/host-tokens/server/service.ts`
- `src/app/api/codex/host/session/bootstrap/route.ts`
- `src/lib/ai-sessions/service.ts`

#### 解决方案
- 改成 **bindToken 显式首次绑定**
- browser OAuth 成功后生成 bind token
- bootstrap 必须带 bind token

---

### 问题 D：即使 Box 连接了，仍然一直走 APYI / gpt-5.4

#### 原因
- 一开始根本没请求 app-server 路径
- `CODEX_ROUTE_ENGINE` 默认行为不合理

#### 位置
- `src/lib/ai/codex-package-task.ts`
- `src/lib/config/infra.ts`

#### 解决方案
- 默认 engine 选择逻辑改成：
  - Box + Host auth 已配好时，默认优先请求 `codex-app-server`

---

### 问题 E：Codex binary 下载后 `Exec format error`

#### 原因
- 一开始硬编码下载了 `x86_64-unknown-linux-gnu`
- 但 Upstash Box 实际是：
  - `Linux`
  - `aarch64`
  - `glibc 2.36`

#### 位置
- `src/lib/sandbox/providers/upstash-box.ts`

#### 解决方案
- 先探测平台：`uname -s` + `uname -m`
- 选择正确资产
- Linux 改为优先用 **musl** 版本，避免 glibc 版本过高

---

### 问题 F：`.codex-runner.mjs` 语法错误

#### 原因
- 模板字符串里 `\n` 转义写错，生成后脚本本身非法

#### 位置
- `src/lib/ai-sessions/app-server-stdio.ts`

#### 解决方案
- 修复 runner 模板中的换行字符串转义

---

### 问题 G：Box 内路径理解错误导致 ENOENT

#### 原因
- 一开始相对路径与 `cwd` 理解不准
- 实际工作区根目录应视为 `/workspace/home`
- `sessions/...` 和 `.local/...` 应使用绝对路径

#### 位置
- `src/lib/config/infra.ts`
- `src/lib/ai-sessions/app-server-stdio.ts`
- `src/lib/ai-sessions/service.ts`

#### 解决方案
- runtime 安装目录改为绝对路径：
  - `/workspace/home/.local/codex-runtime`
- session cwd 改为绝对路径：
  - `/workspace/home/sessions/<id>`

---

### 问题 H：把 `experimentalApi` 错当成 CLI flag

#### 现象
- 日志出现：
  - `Unknown feature flag: experimentalApi`

#### 原因
- 把 `--enable experimentalApi` 放进了 `codex app-server` 启动参数
- 但它真正应该放在：
  - `initialize.capabilities.experimentalApi = true`

#### 位置
- `src/lib/config/infra.ts`
- `src/lib/ai-sessions/app-server-stdio.ts`

#### 解决方案
- 去掉 CLI flag
- 在 initialize 请求里加入 capabilities

---

### 问题 I：sandbox 参数枚举写错

#### 现象
- 日志出现：
  - `unknown variant 'workspaceWrite'`

#### 原因
- 协议里应写：
  - `workspace-write`
而不是：
  - `workspaceWrite`

#### 位置
- `src/lib/ai-sessions/app-server-stdio.ts`

#### 解决方案
- 改为正确枚举值

---

### 问题 J：runner 一直挂住，最后 `fetch failed`

#### 原因之一
- 一开始 runner 一次性写入所有 JSONL 消息，然后傻等进程自己退出
- app-server 更像长期服务，不会自动退出

#### 原因之二
- notification race：
  - `thread/started`
  - `turn/completed`
可能在 waiter 注册前就到了，被丢掉

#### 位置
- `src/lib/ai-sessions/app-server-stdio.ts`

#### 解决方案
- 重写为顺序式 stdio client
- 增加 stopOnMethods
- 增加 notification 缓冲 `receivedNotifications`
- child error/close 时收口 pending waiters

---

### 问题 K：错误归因不准，把 turn 失败误报成 auth/login 失败

#### 现象
- 日志里明明 `account/login/completed success: true`
- 但 UI 仍显示：
  - `codex_app_server_external_auth_login_failed`

#### 原因
- fallbackReason 归因逻辑过粗
- runner timeout 或后续 turn 失败，被误归到 auth 阶段

#### 位置
- `src/lib/ai-sessions/service.ts`
- `src/lib/ai/executors/app-server-package-executor.ts`

#### 现状
- 部分归因已开始收紧
- 但仍需继续细化 turn 阶段错误分类

---

## 6. 当前我们已经确认的事实（非常重要）

通过你一次次的手测与截图，已经能确认：

### 已经成功的部分
- Host OAuth 登录成功
- bind token 生成成功
- host token service bootstrap / refresh 路径已存在
- Upstash Box 已连接成功
- Box workspace 文件写入成功
- Codex runtime 已下载、安装、可执行
- `codex app-server --help` 已能正常运行
- app-server 的 initialize / login / thread/start 已经至少成功跑通过一轮

### 还没稳定跑通的部分
- `turn/start` → `turn/completed` → 文件真正写出 这一段
- 与之对应的错误归因
- 右侧浏览器 preview/evaluator 仍独立存在，并持续可能出现 `READY_TIMEOUT`

---

## 7. 当前代码与当前运行状态的准确结论

### 不是这些问题
- 不是“前端没把 Codex 参数传过去”
- 不是“根本没进 Codex 路径”
- 不是“OAuth 根本没成功”
- 不是“Upstash 没连上”
- 不是“binary 根本没装上”

### 当前更像这些问题
- thread 已建成功
- 但 turn 阶段未闭环
- runner 仍可能在通知等待/错误归因上有 bug
- fallback 到 legacy 后，APYI 再去请求 `gpt-5.4`
- APYI 路径有时也会超时

所以当前看到的：

```text
provider/model: apiyi / gpt-5.4
```

并不是主路径，而是：

> **Codex path 失败之后的 fallback 结果**

---

## 8. 当前最关键的实现/调试方法总结

本轮采用过的主要方法：

### 架构方法
- 保留产品层 mode：`create / modify / debug`
- 替换内部执行引擎
- 保留 RouteDecision / ExecutionTrace / Workbench / versioning

### 执行器方法
- 统一 route engine：`runCodexPackageTask()`
- `legacyExecutor` / `appServerExecutor` 双执行器
- requestedEngine / actualEngine / fallbackReason 三元输出

### 认证方法
- host-managed OAuth
- 不把 `auth.json` 直接塞进 Box
- bind token 显式首次绑定
- refresh 通过 host token service 完成

### Box 方法
- 单 Box + 多 session workspace
- `sessions/<sessionId>` 隔离工作区
- runtime provisioning 到 `.local/codex-runtime`

### 调试方法
- 通过 Upstash logs 看运行阶段
- 通过 Workspace 看 session 文件是否真正写出
- 通过 Workbench 看 fallbackReason / actualEngine
- 通过终端手动验证 binary 与 app-server 子命令

---

## 9. 当前还没完全收口的核心问题（下一步重点）

### 优先级最高
#### `turn/start` → `turn/completed` 闭环

目前最有可能仍存在的问题是：

- turn 阶段错误被吞
- turn 阶段通知仍未被正确捕获
- turn 失败被误归因成 auth/login 失败

### 次优先级
#### fallbackReason 进一步细化

例如明确区分：

- `codex_app_server_thread_start_failed`
- `codex_app_server_turn_failed`
- `codex_app_server_turn_timeout`
- `codex_app_server_protocol_error`

### 并行问题
#### 浏览器 preview/evaluator 仍然会出现 `READY_TIMEOUT`

这与 Codex app-server 主链是并行问题，后续仍要处理。

---

## 10. 当前最推荐的下一步（如果继续开发）

最有价值的下一刀应该聚焦在：

> **把 `turn/start` 之后的通知流和结果解析彻底收口，并修正错误归因。**

更具体地说：

1. 深查 `turn/start` 的 response / notification 序列
2. 把 `turn/completed` 的等待与判断做得更严格
3. 让失败原因真正对应 turn 阶段，而不是错误地挂到 auth 阶段
4. 再分离浏览器 preview 的 READY 问题

---

## 11. 当前可用的人工验证步骤（经验）

如果后续继续手测，当前最有价值的信息来源按优先级如下：

### 1. Upstash Logs
看是否出现：
- `initialize`
- `account/login/completed`
- `thread/started`
- `turn/completed`
- `item/agentMessage/delta`
- `error`

### 2. Workbench
看：
- `requestedEngine`
- `actualEngine`
- `fallbackReason`
- provider/model

### 3. Box Workspace
看 session 目录里的：
- `.codex-runner.mjs`
- `.codex-runner-config.json`（如果还在）
- canonical package files 是否从 0B 变成真实内容

### 4. Box 终端
手动验证：
- `uname -m`
- `uname -s`
- `ldd --version`
- `codex --version`
- `codex app-server --help`

---

## 12. 当前阶段性结论

这轮开发并不是“没有成果”，恰恰相反，已经跨过了很多关键坎：

- OAuth 通了
- bind token 通了
- host token service server 通了
- Box 连上了
- runtime 安装好了
- app-server 启动了
- thread/start 成功了

当前剩下的主要卡点，已经从“外围集成问题”收敛成：

> **Codex app-server 的 turn 阶段消息执行和通知闭环问题。**

这说明当前工作已经进入**真正的深水区调试阶段**，而不是前面那些接线、配置、安装问题阶段。

---

## 13. 文件索引（本轮重点改过/查过的文件）

### 路由/执行器
- `src/lib/ai/codex-package-task.ts`
- `src/lib/ai/package-route-decision.ts`
- `src/lib/ai/executors/types.ts`
- `src/lib/ai/executors/legacy-package-executor.ts`
- `src/lib/ai/executors/app-server-package-executor.ts`
- `src/app/api/package/generate/route.ts`
- `src/app/api/package/modify/route.ts`
- `src/app/api/package/debug/route.ts`

### AI sessions
- `src/lib/ai-sessions/types.ts`
- `src/lib/ai-sessions/repository.ts`
- `src/lib/ai-sessions/service.ts`
- `src/lib/ai-sessions/workspace.ts`
- `src/lib/ai-sessions/app-server-stdio.ts`
- `src/lib/ai-sessions/client.ts`
- `src/app/api/ai/sessions/**/*`

### Host token service
- `src/lib/host-tokens/types.ts`
- `src/lib/host-tokens/client.ts`
- `src/lib/host-tokens/server/config.ts`
- `src/lib/host-tokens/server/store.ts`
- `src/lib/host-tokens/server/neon-store.ts`
- `src/lib/host-tokens/server/service.ts`
- `src/lib/host-tokens/server/http.ts`
- `src/lib/host-tokens/server/index.ts`
- `src/app/api/codex/host/**/*`

### Box / sandbox
- `src/lib/sandbox/types.ts`
- `src/lib/sandbox/index.ts`
- `src/lib/sandbox/providers/upstash-box.ts`
- `src/lib/sandbox/providers/vercel-sandbox.ts`
- `src/lib/config/infra.ts`

### UI / workspace
- `src/components/CodegenAppShell.tsx`
- `src/components/RequestWorkbench.tsx`
- `src/lib/workspace/routing.ts`
- `src/lib/workspace/state.ts`
- `src/lib/workspace/storage.ts`
- `src/lib/workspace/types.ts`

### DB / project persistence
- `src/lib/db/schema-pg.ts`
- `src/lib/db/index.ts`
- `src/lib/projects/service.ts`
- `src/lib/projects/repository.ts`

### 测试
- `tests/projects/ai-session-service.test.ts`
- `tests/api/ai-sessions-api.test.ts`
- `tests/projects/codex-package-task.test.ts`
- `tests/projects/app-server-package-executor.test.ts`
- `tests/projects/app-server-stdio.test.ts`
- `tests/storage/host-token-service-client.test.ts`
- `tests/storage/host-token-service-server.test.ts`
- `tests/sandbox/upstash-box-provider.test.ts`

---

## 14. 当前阶段建议

如果后续继续做，不建议再重复从头怀疑：

- OAuth 是否通
- Box 是否连上
- binary 是否能跑

这些已经基本确认过了。

最值得继续深入的是：

> **Codex app-server turn 阶段的事件序列、结果获取、以及错误归因。**

这会是下一轮最有效率的工作方向。
