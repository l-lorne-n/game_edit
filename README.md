# game_edit

一个面向交接与继续开发的**当前状态 README**。

这份文档的目标不是复述最早的产品设想，而是准确说明：

1. 这个项目**现在真实跑的是什么架构**。
2. 数据分别落在哪一层（Neon / Blob / Box / 浏览器缓存）。
3. create / modify / checkpoint / archive 这些动作到底各自意味着什么，以及哪些旧入口只是残留。
4. Upstash Box + Codex runtime 是如何被接起来、认证、通信、回传结果的。
5. 哪些历史说法已经不再适合作为“当前实现”的解释。

如果你是第一次接手这个项目，建议按下面顺序阅读：

1. **当前系统一页概览**
2. **核心对象模型**
3. **Upstash Box + Codex Runtime：启动、认证、通信与回传链路**
4. **存储分层与职责**
5. **版本语义**
6. **端到端工作流**
7. **最容易踩坑的点**

---

## 1. 当前系统一页概览

`game_edit` 现在不是一个单纯“让 AI 生成小游戏代码”的页面，而是一个：

> **带 AI session、版本化 Box 工作区、Codex app-server、可预览、可测试、可 checkpoint/归档的小游戏编辑工作台。**

当前系统可以粗分成 4 层：

1. **前端工作区层**
   - 项目列表
   - 聊天与模式切换（当前主工作流以 create / modify 为主；debug 仍有 UI 残留但不作为当前主口径）
   - Workbench / 执行状态 / 预览

2. **项目与正式版本层**
   - `projects`
   - `project_versions`
   - Vercel Blob 中的 canonical 文件

3. **AI session 与 Box 工作区层**
   - `ai_sessions`
   - `ai_session_turns`
   - `ai_session_events`
   - `ai_session_checkpoints`
   - Upstash Box 中的 `sessions/{sessionId}/vN`

4. **Codex 运行与回传层**
   - host token service
   - Box 中的 Codex runtime
   - Box 中的 local daemon
   - `submit / status / result` async turn 协议

当前系统的主设计原则是：

- **正式项目历史** 与 **AI session 工作头** 是两条不同的状态链。
- **浏览器展示层 transcript** 与 **服务端执行层记录** 也不是同一份数据。
- Upstash Box 承担的是**可变运行时工作区**，不是最终归档层。

---

## 2. 当前真实技术栈

从 `package.json` 和当前代码可确认，当前主栈是：

- **Next.js**
- **React**
- **Neon / PostgreSQL**
- **Drizzle ORM**
- **Vercel Blob**
- **Upstash Box**
- **Vitest / ESLint**

相关入口：

- `src/app/page.tsx`
- `src/components/CodegenAppShell.tsx`
- `src/lib/db/index.ts`
- `src/lib/db/schema-pg.ts`
- `src/lib/storage/*`
- `src/lib/sandbox/providers/upstash-box.ts`
- `src/lib/ai-sessions/*`

---

## 3. 核心对象模型

理解这个项目，必须先把下面几个对象分清楚。

### 3.1 Project

Project 是最上层的“正式项目”对象，对应：

- `projects`
- 前端左侧项目列表中的一项

它有：

- `id`
- `name`
- `currentVersion`
- 多个正式归档版本

Project 的 `id` 也是 Blob 路径里：

```text
projects/{projectId}/vN/index.html
```

中的 `{projectId}`。

### 3.2 Project Version

Project Version 是**正式归档版本**，对应：

- `project_versions.version`
- Blob 中的 `v1 / v2 / v3 ...`

它是连续增长的：

- `currentVersion + 1`

不会跳号。

### 3.3 AI Session

AI Session 是用户和 Codex 工作区之间的持续会话身份，对应：

- `ai_sessions`

它维护：

- `projectId`
- `baseVersion`
- `activeWorkspaceVersion`
- `latestWorkspaceVersion`
- `boxId`
- `codexHomeKey`
- `authState`
- `appServerStatus`
- `daemonStatus`
- continuity / lease / checkpoint 状态

### 3.4 Workspace Version

Workspace Version 是 **Box 工作区版本**，不是正式 project version。

它对应：

- `activeWorkspaceVersion`
- `latestWorkspaceVersion`
- Box 内目录：

```text
sessions/{sessionId}/v1
sessions/{sessionId}/v2
sessions/{sessionId}/v3
```

前端把它显示成：

- `session:v1`
- `session:v2`

### 3.5 Turn

Turn 是一次 AI session 请求的执行记录，对应：

- `ai_session_turns`

当前主线上主要对应 create / modify；debug 相关字段与路径仍有残留，但不应再作为 README 的主工作流来理解。

它保存：

- `requestText`
- `workspaceVersion`
- `status`
- `artifactState`
- `agentText`
- `resultPayload`
- `diagnostics`
- `failureCode` / `failureMessage`

### 3.6 Checkpoint

Checkpoint 是把 **AI session 当前工作头** 正式提交成新的 project version 的动作，对应：

- `ai_session_checkpoints`

它和 Archive 不是一个概念，后文会专门讲。

---

## 4. 存储分层与职责

这是交接时最容易被说错的一部分。

### 4.1 Neon：结构化数据库

Neon 负责存：

- `projects`
- `project_versions`
- `ai_sessions`
- `ai_session_turns`
- `ai_session_events`
- `ai_session_checkpoints`
- `ai_session_transport_logs`
- host auth 相关表

也就是说，Neon 存的是：

- 项目元数据
- 版本元数据
- AI session 生命周期
- turn 记录
- event / checkpoint / transport log
- OAuth / binding / host auth session 元数据

Neon **不是**文件存储。

### 4.2 Vercel Blob：正式项目文件的对象存储

Blob 负责存**正式项目版本**对应的 4 个 canonical 文件：

- `index.html`
- `game.js`
- `style.css`
- `manifest.json`

路径规则固定为：

```text
projects/{projectId}/v{version}/{file}
```

相关代码：

- `src/lib/storage/index.ts`
- `src/lib/projects/service.ts`

Blob **不是数据库**。

### 4.3 Upstash Box：AI session 的可变工作区

Box 负责存：

- `sessions/{sessionId}/vN` 工作区文件
- `.codex-daemon.mjs`
- `.codex-daemon-config.json`
- `.codex-turns/{turnId}.json`
- `.codex-turns/{turnId}.messages.jsonl`
- 安装好的 Codex runtime 二进制

它是：

> **运行时、可变、面向 session 的工作区**

不是正式归档层。

### 4.4 浏览器缓存：UI transcript / 工作区展示态

浏览器本地 IndexedDB / localStorage fallback 目前仍承担：

- `project.messages`
- 选中项目/版本指针
- 某些 UI 工作区状态

这意味着：

- 换端口 / 换 origin 后，项目和文件还在，不代表聊天 transcript 还在。
- 前端中间聊天面板当前不是完全服务端化的。

相关代码：

- `src/lib/workspace/storage.ts`

---

## 5. 当前实现边界：什么是“已实现”，什么只是历史/规划方向

### 当前真实实现

1. **当前 Upstash Box provider 连接的是预配置好的 Box**
   - 使用：
     - `UPSTASH_BOX_API_KEY`
     - `UPSTASH_BOX_ID` 或 `UPSTASH_BOX_NAME`
   - 当前代码不是“运行时动态给每个 session 新建一个 Box”

2. **当前主执行模型是 async turn**
   - `submit / status / result`
   - `executeMessage()` 仅保留兼容语义，不应当再被当作主模型理解

3. **当前真正可用的 runtime 是 Upstash Box + codex-app-server**
   - `vercel-sandbox` 仍保留 provider seam，但不是当前主路径

4. **当前项目文件和 AI session workspace 是分开的**
   - project version → Blob
   - workspace version → Box

5. **当前 README 的主工作流应按 create / modify 理解**
   - debug 相关 UI / route 仍有残留，但不是现在实际采用的主流程

### 不应当被写成“当前实现”的内容

下面这些只适合作为历史背景或规划方向说明：

1. 旧 README 里那套把 v1/v2 作为主要架构叙事的方式
2. 把 architect / worker / fixer 五角色设计写成当前底层执行架构
3. 把 `manifest.editable` 当作当前 modify 主 gating 逻辑
4. 把 `threadId` 单独当成 continuity 真相
5. 把浏览器 cache 当作正式持久化层
6. 把“one box per active session”写成当前已经完全落地的事实

---

## 6. Upstash Box + Codex Runtime：启动、认证、通信与回传链路

这是当前 README 必须单独成章的部分。

### 6.1 当前 Box 连接模型

当前实现需要先具备一个可访问的 Upstash Box 实例，再由 `UpstashBoxProvider` 基于配置去连接这个预配置 Box。

从交接口径上，应该把这件事理解成：

1. `UPSTASH_BOX_API_KEY` / `UPSTASH_BOX_ID` / `UPSTASH_BOX_NAME` 负责的是 **Box 访问与定位**。
2. 它们不应该被描述成“AI/Codex 登录方式”。
3. 当前项目真正用于让 Codex 工作的是 **Codex OAuth + host token service + bindToken** 这一套认证链，而不是 Upstash 内置的 AI 会员登录体系。

也就是说：

> **当前代码连接的是一个预配置好的 Box 实例；真正的 AI 认证语义来自 Codex OAuth，而不是 Upstash 内置 AI 登录。**

相关代码：

- `src/lib/sandbox/providers/upstash-box.ts`
- `src/lib/config/infra.ts`

### 6.2 Box 内如何准备 Codex runtime

`UpstashBoxProvider.ensureCodexRuntime()` 会：

1. 先执行：

```sh
uname -s && uname -m
```

用于识别平台（如 `linux x86_64` / `linux aarch64`）

2. 根据平台选择对应的 Codex GitHub release asset，例如：
   - `codex-x86_64-unknown-linux-musl.tar.gz`
   - `codex-aarch64-unknown-linux-musl.tar.gz`

3. 先检查目标 binary 是否已存在、可执行，并通过 `--version` 校验

4. 若不存在，则执行安装脚本：
   - 创建 install dir
   - `curl -fsSL` 下载 release
   - `tar -xzf` 解压
   - `chmod +x`
   - `binary --version`

默认安装目录：

```text
/workspace/home/.local/codex-runtime
```

相关配置：

- `CODEX_RUNTIME_INSTALL_DIR`
- `CODEX_RUNTIME_RELEASE_TAG`
- `CODEX_RUNTIME_BINARY_NAME`

相关代码：

- `src/lib/sandbox/providers/upstash-box.ts`
- `src/lib/config/infra.ts`

### 6.3 AI session bootstrap：Box workspace 怎么准备

AI session bootstrap 总入口在：

- `src/lib/ai-sessions/service.ts`
  - `bootstrapSession(sessionId, bindToken)`

它会做：

1. 把 session 状态切到：
   - `hydrating`
   - `boxStatus=provisioning`
   - `appServerStatus=starting`
   - `daemonStatus=starting`

2. 通过 host token service 完成 AI session 与 host auth session 的绑定 bootstrap

3. 从 project 的 `baseVersion` 读取 canonical 文件

4. 把这些文件写到 Box 中：

```text
sessions/{sessionId}/v1/index.html
sessions/{sessionId}/v1/game.js
sessions/{sessionId}/v1/style.css
sessions/{sessionId}/v1/manifest.json
```

5. 再写入 workspace contract 文件

6. 最后把 session 标记回：
   - `status=ready`
   - `boxStatus=ready`
   - `appServerStatus=stopped`
   - `daemonStatus=stopped`

也就是说：

> **bootstrapSession() 做的是工作区 hydration，不是直接把 app-server 起起来。**

### 6.4 OAuth / host token handoff：登录信息怎么进 Codex

这一层由 host token service 负责。

核心文件：

- `src/lib/host-tokens/server/service.ts`
- `src/app/api/codex/host/session/*`
- `src/app/api/ai/sessions/[id]/bootstrap/route.ts`
- `src/app/api/ai/sessions/[id]/init/route.ts`

流程分成几步：

#### 第一步：浏览器完成 OAuth

host token service 会：

1. 生成 OAuth authorize URL
2. 生成 `state / verifier / challenge`
3. 处理 callback
4. 存储 host auth session
5. 生成一个 `bindToken`

#### 第二步：AI session 用 bindToken 绑定 host auth session

前端在调用：

- `/api/ai/sessions/{id}/bootstrap`
- 或 `/api/ai/sessions/{id}/init`

时，会把 `bindToken` 传进去。

`bootstrapSession()` 再调用：

- `HostTokenServiceClient.bootstrap({ sessionId, bindToken })`

拿回：

- `idToken`
- `accessToken`
- `expiresAt`
- `accountId`

#### 第三步：初始化 app-server 时，把 token 作为初始化消息送进去

`initializeTransport()` 里会先 refresh 一次 host token，再构造初始化消息：

- `createInitializeMessages()`
- `createExternalAuthLoginMessage(hostTokens)`
- `createThreadStartMessage(...)`

这意味着：

> **当前实现不是把 refresh token 永久写进 Box，而是把短期 token 作为初始化消息传给 app-server。**

#### 第四步：token 过期后，daemon 代表 app-server 回调 host token service 刷新

daemon 内部有：

- `refreshExternalTokens()`

当 app-server 发出：

- `account/chatgptAuthTokens/refresh`

daemon 会请求：

- `/api/codex/host/session/refresh`

并在请求头里带：

- `Authorization: Bearer ${hostTokenService.apiKey}`

所以刷新语义是：

> **Box 内不会自己做 OAuth；宿主负责刷新，再把新的 accessToken 回送给 app-server。**

### 6.5 daemon/app-server 是怎么启动的

transport 初始化总入口是：

- `initializeTransport(sessionId, bindToken)`

关键步骤：

1. 先确保 session 已 bootstrap
2. 调 `sandboxProvider.ensureCodexRuntime()`
3. 计算默认 app-server config
4. 构造 host token runtime config
5. 调 `ensureCodexAppServerDaemon(...)`
6. 再通过 daemon 发起 init request，直到 `thread/started`

其中 daemon 启动流程在：

- `src/lib/ai-sessions/app-server-daemon.ts`
  - `ensureCodexAppServerDaemon(...)`

它会：

1. 把 `.codex-daemon.mjs` 写进 Box
2. 把 `.codex-daemon-config.json` 写进 Box
3. 用：

```sh
nohup node .codex-daemon.mjs ./.codex-daemon-config.json > ./.codex-daemon.out 2>&1 &
```

起 daemon

4. 轮询本地：

```text
GET /health
```

直到 daemon 报 `ok: true`

daemon 起起来后，daemon 再用 `spawn(config.command, config.args, { cwd, stdio })` 启动真正的 Codex app-server。

### 6.6 当前协议是怎么设计的

这一层现在是两层协议叠加：

#### a) app-server ↔ daemon：JSON-RPC 风格的行消息协议

daemon 用 readline 一行一行读 child stdout，并按这些字段处理：

- `id`
- `method`
- `result`
- `error`

所以它本质上是：

> **JSON-RPC 风格的 line-delimited message protocol**

#### b) service ↔ daemon：Box 内 localhost HTTP API

daemon 暴露：

- `GET /health`
- `POST /shutdown`
- `POST /execute`
- `POST /turns/submit`
- `GET /turns/:id/status`
- `GET /turns/:id/result`
- `GET /turns/:id/messages`

service 不直接碰 app-server stdout，而是：

1. 先把 request 写成 `.codex-daemon-request.json`
2. 再通过 curl 调 localhost daemon API

### 6.7 submit / status / result 是怎么回传到前端的

当前主模型是：

#### 第一步：前端发 create / modify

package route 在 `aiSessionId` 存在时，返回：

- `202`
- `accepted: true`
- `asyncTurn`

#### 第二步：service 提交 daemon turn

`submitMessageTurn()` 最终会走到：

- `submitCodexAppServerDaemonTurn(...)`

daemon 会把 turn 记录持久化为：

- `.codex-turns/{turnId}.json`
- `.codex-turns/{turnId}.messages.jsonl`

#### 第三步：前端轮询 status

`CodegenAppShell` 会：

1. 持有 `turnId`
2. 用 backoff 轮询 `/messages/[turnId]`
3. 命中 terminal 后再拉 `/messages/[turnId]/result`

#### 第四步：service finalize

service 在 finalize 时会：

1. 读 Box workspace package
2. parse / recover / evaluate
3. 写 turn resultPayload
4. promote workspace version
5. 更新 session/event/transport 状态

#### 第五步：前端 merge result

`finalizeAsyncTurn()` 最终把：

- `currentPackage`
- `currentEvaluator`
- `lastExecutionTrace`

合并回当前工作区 UI。

---

## 7. 版本语义：必须分清的两套版本号

### 7.1 Workspace Version

对应：

- `ai_sessions.activeWorkspaceVersion`
- `ai_sessions.latestWorkspaceVersion`
- `session:vN`
- Box 中的 `sessions/{sessionId}/vN`

它表示：

> **AI session 当前工作头已经演进到第几版。**

### 7.2 Project Version

对应：

- `projects.currentVersion`
- `project_versions.version`
- Blob 中的 `/projects/{projectId}/vN/*`

它表示：

> **正式归档项目已经到第几版。**

### 7.3 为什么会出现“前端像 v3，Blob 却只有 v2”

因为：

- 前端可能正在看 workspace v3
- 但正式 project version 之前只归档到了 v1
- 所以下一次 Archive / Checkpoint 只会生成 project v2

这不是 Blob 算错了，而是：

> **workspaceVersion 与 project version 天生不是一个计数器。**

---

## 8. Archive 与 Checkpoint 的区别

### 8.1 Archive Snapshot

Archive 的语义更接近：

> **把当前包手动存成一个新的 project version**

它会写 Blob / project_versions，但不会推进 aiSession 基线语义。

### 8.2 Checkpoint AI Session

Checkpoint 的语义是：

> **把当前 AI session 工作头正式提交成新的 durable project head，并推进 session 基线**

它会：

1. 校验 `project.currentVersion === session.baseVersion`
2. 从 active workspace read back package
3. `saveGeneratedPackage(...)`
4. 生成 checkpoint 记录
5. 更新 `session.baseVersion`
6. 记 `lastCheckpointVersion`

所以：

> **Checkpoint 是 session 级提交；Archive 是 project 级归档。**

---

## 9. 端到端工作流（当前实现）

### 9.1 Create

1. 选择 project
2. 建立/复用 AI session
3. 如果 transport 未 ready，则 bootstrap + initializeTransport
4. create turn 默认使用当前 active workspace 作为基线
5. 结果先进入 Box workspace head
6. 是否进入正式 project version，要看是否 Checkpoint / Archive / 同步持久化路径

### 9.2 Modify

1. 选择 modify base
   - 可以是当前 head
   - 也可以是历史 `session:vN`
   - 也可以是 project snapshot
2. modify 不是原地改旧版本，而是 fork 出新 workspace head
3. Codex 在新 head 上执行

### 9.3 Debug（残留路径）

当前代码中仍然保留了 debug 相关 UI / route / turn 字段，但它不应当再被写成当前主工作流。

对交接方更准确的理解是：

1. 当前实际采用的主流程是 create / modify。
2. debug 仍有残留实现，可作为兼容或后续清理对象看待。
3. README 不应再把它和 create / modify 并列写成当前主产品路径。

### 9.4 Browse 历史 Box Version

当前前端已经允许：

- 浏览历史 `session:vN`
- 再基于它继续 modify

这不是 restore；它的真实语义是：

> **以该历史 Box version 为 base，再 fork 一个新的 head 继续改。**

### 9.5 Checkpoint

1. 从当前 active workspace 读 package
2. 检查 baseVersion 是否 stale
3. 如果一致，生成新的 project version
4. 更新 session.baseVersion

### 9.6 Restore

当前需要分两层理解 Restore：

1. **后端能力层**
   - `ProjectService.restoreVersion()` 确实提供了 durable project-version restore 能力
   - 它会生成一个新的正式 project version

2. **当前前端主流交互层**
   - `CodegenAppShell` 里的 server-backed Restore 目前更接近“切换预览/修改基线”
   - 它会把 `currentPackage/currentEvaluator` 切到所选 snapshot，并把 modify baseline 指向这个版本
   - 它不会在当前这条 UI 交互里直接完成 durable restore 提交

所以当前更准确的说法是：

> **后端已有 project-version restore 能力，但前端 server-backed Restore 的主流语义目前仍然是预览与基线切换，而不是直接提交 durable restore。**

---

## 10. 启动与开发方式

### 10.1 基本启动

```bash
npm install
npm run dev
```

默认地址：

```text
http://localhost:3000
```

改端口：

```powershell
$env:PORT=3001; npm run dev
```

### 10.2 当前关键环境变量

#### 数据库

- `DATABASE_URL`

#### 对象存储

- `BLOB_READ_WRITE_TOKEN`（启用 Blob）
- `STORAGE_PROVIDER=blob|local`（可显式指定）
- `LOCAL_STORAGE_PATH`（若使用本地文件存储 provider）

#### Upstash Box

- `UPSTASH_BOX_API_KEY`
- `UPSTASH_BOX_ID` 或 `UPSTASH_BOX_NAME`
- `SANDBOX_PROVIDER=upstash-box|vercel-sandbox`

#### Codex runtime / app-server

- `CODEX_APP_SERVER_COMMAND`
- `CODEX_APP_SERVER_ARGS`
- `CODEX_APP_SERVER_PORT`
- `CODEX_RUNTIME_INSTALL_DIR`
- `CODEX_RUNTIME_RELEASE_TAG`
- `CODEX_RUNTIME_BINARY_NAME`
- `CODEX_ROUTE_ENGINE`

#### Host token service

- `HOST_TOKEN_SERVICE_URL`
- `HOST_TOKEN_SERVICE_API_KEY`

#### OpenAI OAuth / host auth

- `OPENAI_OAUTH_ISSUER`
- `OPENAI_OAUTH_CLIENT_ID`
- `OPENAI_OAUTH_CALLBACK_PORT`
- `OPENAI_OAUTH_CALLBACK_PATH`
- `OPENAI_OAUTH_REDIRECT_URI`
- `OPENAI_OAUTH_SCOPES`
- `OPENAI_OAUTH_ORIGINATOR`

### 10.3 运行前的最小理解

如果你想走**当前主链路**（Upstash Box + codex-app-server），至少要满足：

1. `DATABASE_URL`
2. `UPSTASH_BOX_API_KEY + UPSTASH_BOX_ID/NAME`
3. `HOST_TOKEN_SERVICE_URL + HOST_TOKEN_SERVICE_API_KEY`
4. `OPENAI_OAUTH_*`

Blob 不是必须，但如果不启 Blob，project version 会走本地 provider / 本地调试语义，而不是线上对象存储语义。

---

## 11. 验证命令

```bash
npm run lint
npm run test:projects
npm run build
```

如果要重点验证 async-turn / ai-session / Upstash 相关逻辑，优先看：

- `tests/projects/app-server-daemon.test.ts`
- `tests/projects/ai-session-service.test.ts`
- `tests/projects/ai-session-service-transport-hardening.test.ts`
- `tests/api/ai-sessions-api.test.ts`
- `tests/api/package-routes.test.ts`
- `tests/sandbox/upstash-box-provider.test.ts`

---

## 12. 最容易踩坑的地方

### 12.1 `workspaceVersion` 不等于 Blob 里的 `vN`

这是最常见误解。

### 12.2 AI session 成功不等于 project version 已归档成功

工作区成功只是 Box head 成功，不代表 Blob 已经出现新版本。

### 12.3 Archive 不等于 Checkpoint

Archive 是项目级归档；Checkpoint 是 session 级提交。

### 12.4 浏览器聊天 transcript 不是当前最权威的持久化事实

它更多是浏览器缓存优先的 UI 展示层状态。

### 12.5 当前实现不是“每个 session 动态创建一个全新 Box”

当前代码是连接预配置 Box，再按 session 分工作区根目录。

### 12.6 不要再把 `executeMessage()` 当主路径来理解系统

现在主模型是 `submit / status / result` async turn。

### 12.7 浏览历史 Box version 不等于“只能看，不能继续改”

当前正确语义是：

> 可以从历史 Box version fork 新 head 继续 modify。

---

## 13. 开发工作流建议（给接手人）

建议把问题拆成三层看：

1. **Project 层**
   - `currentVersion` 是否正确
   - Blob 中是否已有 `projects/{projectId}/vN/*`

2. **AI Session 层**
   - `activeWorkspaceVersion / latestWorkspaceVersion`
   - `appServerStatus / daemonStatus / authState`
   - 是否已经 checkpoint

3. **Turn 层**
   - `requestText`
   - `status / artifactState / finalOutcome`
   - `agentText`
   - `resultPayload / diagnostics`

排查顺序建议：

1. 先看 project / version
2. 再看 ai session
3. 最后看具体 turn 与 daemon 状态

不要一上来只盯前端界面现象。

---

## 14. 历史背景：哪些内容应该作为背景而不是当前实现

下面这些内容仍然有历史价值，但不应该再被当成“当前系统就是这样”的描述：

1. 旧 README 中以 v1 / v2 产品叙事为主的解释方式
2. 以 architect / worker / fixer 等角色分工作为底层执行真相
3. 把 `manifest.editable` 视为当前 modify 路由的主要 gating 逻辑
4. 把浏览器本地 archive/snapshot 当作主持久化模型
5. 把 threadId 单独当作 continuity 真相
6. 把 `vercel-sandbox` 写成当前主 runtime

历史脉络请看：

- `history/26_4_14/`
- `history/26_4_15/`
- `history/26_4_16/`
- `history/27_4_17/`
- `history/27_4_17_new/`

这些文档应该被用于：

- 理解为什么架构会演进成今天这样
- 理解哪些怀疑后来被推翻
- 理解踩坑与收敛过程

而不是直接替代当前代码的真实解释。

---

## 15. 关键代码地图

### 前端工作区与 Workbench

- `src/components/CodegenAppShell.tsx`
- `src/components/RequestWorkbench.tsx`
- `src/components/SandboxPreview.tsx`

### Project / Blob / 正式版本

- `src/lib/projects/service.ts`
- `src/lib/projects/repository.ts`
- `src/lib/storage/index.ts`
- `src/lib/storage/providers/vercel-blob.ts`

### AI session / turn / checkpoint / finalize

- `src/lib/ai-sessions/service.ts`
- `src/lib/ai-sessions/repository.ts`
- `src/lib/ai-sessions/types.ts`
- `src/lib/ai-sessions/workspace.ts`
- `src/lib/ai-sessions/transport-runtime.ts`
- `src/lib/ai-sessions/supervisor.ts`

### Upstash Box / Codex runtime / daemon

- `src/lib/sandbox/providers/upstash-box.ts`
- `src/lib/sandbox/index.ts`
- `src/lib/ai-sessions/app-server-daemon.ts`
- `src/lib/ai-sessions/app-server-stdio.ts`
- `src/lib/config/infra.ts`

### Host token service / OAuth

- `src/lib/host-tokens/server/service.ts`
- `src/lib/host-tokens/server/config.ts`
- `src/lib/host-tokens/server/neon-store.ts`
- `src/app/api/codex/host/session/*`
- `src/app/api/ai/sessions/[id]/bootstrap/route.ts`
- `src/app/api/ai/sessions/[id]/init/route.ts`

### 数据库 schema

- `src/lib/db/schema-pg.ts`
- `src/lib/db/index.ts`

---

## 16. 一句话总结当前系统

如果只用一句话描述当前 `game_edit`：

> 这是一个把正式项目版本、AI session 工作区、Upstash Box 中的 Codex runtime、host OAuth/token bridge、以及前端工作台拼接在一起的 AI 原生小游戏编辑系统；它的重点不是“单次生成”，而是**多轮修改、可追踪执行、可 checkpoint、可版本化归档**。
