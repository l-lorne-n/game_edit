# L:\game_edit 项目阶段性完整历史总结（2026-04-16 会话整理）

## 1. 文档目的

本文用于系统整理 `L:\game_edit` 在 2026-04-16 这一天内完成的主要工作，重点覆盖：

1. Box + Codex 多轮修改链路在架构层面的重构方向与最终落地。
2. create / modify 路由、session versioning、rollout/thread continuity 的关键技术决策。
3. 在实际联调中暴露出的新问题，以及今天针对这些问题采取的处理方式。
4. 当前代码已经达到的状态、仍未完全收口的问题、以及下一步建议。

---

## 2. 本轮工作的核心目标

今天的目标，和 26_4_15 的问题直接相关，主要集中在以下几条：

1. 修复 Box + Codex 场景下“游戏文件无法进行多轮修改”的问题。
2. 把 session 工作区从“直接写进 `sessions/{sessionId}`”改成真正的版本化结构：`v1 / v2 / v3 ...`。
3. 去掉此前 `manifest.editable[]` 与 architect / worker 路由分流带来的误判和阻塞。
4. 让浏览器端能够感知到 Box session versions，而不是永远只看到一个 currentPackage。
5. 让 `our aiSession` 成为稳定的用户侧 rollout 身份，减少刷新、OAuth 重认证、dev restart 导致的 continuity 断裂。
6. 修复 `/api/package/generate` 在“代码已经写进 Box”之后仍然 500 的晚期失败问题。

---

## 3. 需求与架构判断的演进过程

### 3.1 多轮修改问题不是单点 bug，而是三个问题叠加

最开始看起来像“modify 不能保存”，但进一步分析后确认，这个问题至少包含三层：

1. 请求有可能根本没有正确走到 modify 执行链。
2. 即使进入执行链，session 工作区如果不版本化，就无法稳定承载多轮修改、回看、回退和继续迭代。
3. 浏览器端把 currentPackage 当成唯一真相，会把 Box 里的多版本事实抹平。

因此，今天采取的是“先修模型，再修 bug”的路线，而不是继续在旧模型上打补丁。

### 3.2 最终确定的 session 工作区模型

今天明确收敛的工作区语义是：

1. `our aiSession` 下面使用 `sessions/{sessionId}/vN` 保存每一个 Box 版本。
2. `create` 初始落到 `v1`。
3. `modify` 永远不是在原版本上原地改，而是“从选中的 base version 复制出新的 `vN+1` 再执行”。
4. `restore` 不直接改文件，不直接落 durable history，只切换“浏览/试玩指针”。

这套语义最后是按你提出的方向实现的。

### 3.3 去掉 editable-scope / architect-worker 分流

今天一个很重要的转向是：

1. 不再依赖 `manifest.editable[]` 决定 modify 是否允许执行。
2. create / modify 不再强依赖 architect / worker 的路由分流。
3. 对于游戏编辑场景，统一改为 full-package path，允许 Codex 直接改整个游戏包。

这是因为我们在真实联调里已经确认：

1. `背景改成白色` 这种明明应该允许的视觉修改，也会被旧的 route heuristic 错杀。
2. 这套 heuristic 带来的价值很低，但会持续阻碍多轮迭代。

### 3.4 rollout / thread / aiSession 三者的关系被重新定义

今天进一步明确了三层身份：

1. `our aiSession`：用户真正关心的、稳定的 rollout 身份。
2. `appServerThreadId`：挂在 aiSession 上的可恢复 transport handle。
3. `.codex/sessions/.../rollout-*.jsonl`：执行日志分片，而不是用户侧 rollout 主身份。

因此，今天的 continuity 修复目标不是“永远同一个 thread”，而是：

1. 默认始终留在同一个 aiSession rollout。
2. 能继续同一个 thread 就继续。
3. thread 真断了，就在同一个 rollout 下重建 thread，而不是自动开新 rollout。

---

## 4. 当前已经落地的主要实现

### 4.1 Box session 版本化工作区已经落地

涉及文件：

- `L:\game_edit\src\lib\ai-sessions\workspace.ts`
- `L:\game_edit\src\lib\ai-sessions\service.ts`
- `L:\game_edit\src\lib\ai-sessions\types.ts`
- `L:\game_edit\src\lib\ai-sessions\repository.ts`
- `L:\game_edit\src\lib\db\schema-pg.ts`

已实现内容：

1. session 工作区从扁平结构改成 `sessions/{sessionId}/vN`。
2. ai session 持久化了 `activeWorkspaceVersion` / `latestWorkspaceVersion`。
3. modify 会生成新版本并 promote 到 active head。
4. Box 里已经能够看到 `v1 / v2` 这类结构。

### 4.2 create / modify 路由已经统一为 full-package path

涉及文件：

- `L:\game_edit\src\lib\workspace\routing.ts`
- `L:\game_edit\src\lib\workspace\types.ts`
- `L:\game_edit\src\lib\package\contracts.ts`
- `L:\game_edit\src\lib\ai\codex-package-task.ts`
- `L:\game_edit\src\app\api\package\generate\route.ts`
- `L:\game_edit\src\app\api\package\modify\route.ts`

已实现内容：

1. 去掉了 editable-scope gating。
2. 去掉了 modify 遇到 `routeMode=design` 就直接 409 拒绝的逻辑。
3. `manifest.editable` 改成 optional / inert，只做兼容字段，不再参与路由判断。
4. create / modify 共用 full-package path，debug 仍单独保留 repair path。

### 4.3 浏览器端已接入 Box version browsing

涉及文件：

- `L:\game_edit\src\app\api\ai\sessions\[id]\versions\route.ts`
- `L:\game_edit\src\app\api\ai\sessions\[id]\versions\[versionId]\route.ts`
- `L:\game_edit\src\lib\ai-sessions\client.ts`
- `L:\game_edit\src\components\CodegenAppShell.tsx`

已实现内容：

1. 浏览器可以查询 ai session 的 Box version index。
2. 浏览器可以按需读取指定 `vN` 的 payload，而不是只保留 currentPackage。
3. 浏览旧版本时使用 read-only preview，不隐式 restore/promote。
4. 浏览旧版本时会阻止继续 Send，避免在只读版本视图上误发修改。

### 4.4 continuity 持久化与同 rollout 恢复已经接上主链

涉及文件：

- `L:\game_edit\src\lib\ai-sessions\transport-runtime.ts`
- `L:\game_edit\src\lib\ai-sessions\supervisor.ts`
- `L:\game_edit\src\lib\ai-sessions\service.ts`
- `L:\game_edit\src\lib\ai-sessions\repository.ts`
- `L:\game_edit\src\lib\db\schema-pg.ts`

已实现内容：

1. transport/runtime 状态不再纯靠内存 Map。
2. session 表中新增持久化 transport 字段与 recoveryOutcome。
3. 新增持久化 `ai_session_transport_logs`。
4. refresh / OAuth interruption / dev restart 时，系统会优先尝试回到同一个 rollout。
5. 如果原 thread 健康，则复用；否则在同一 rollout 下重建 thread。

### 4.5 `/api/package/generate` 晚期失败已做兜底修复

涉及文件：

- `L:\game_edit\src\lib\ai-sessions\service.ts`
- `L:\game_edit\src\lib\ai\executors\app-server-package-executor.ts`
- `L:\game_edit\src\lib\ai\executors\types.ts`
- `L:\game_edit\src\lib\ai\codex-package-task.ts`
- `L:\game_edit\src\app\api\package\generate\route.ts`
- `L:\game_edit\src\app\api\package\modify\route.ts`

已实现内容：

1. 解决了“Box 已写入文件，但 route 仍 500，前端显示 `Request failed: fetch failed`”的问题。
2. 给 late transport/readback error 增加了 cleanup，避免 session 卡在 `busy / turn_running`。
3. 增加了一次 bounded retry 来处理瞬时 `fetch failed` 的 readback。
4. 对 create-only 的晚期失败增加了 workspace recovery 兜底：如果结果已在 Box 中形成有效包，可以直接从 workspace 恢复成功结果。
5. recovery 只有在“前置基线包可读且新旧包内容确实变化”时才成立，避免把旧包误判成这次成功结果。
6. route 成功回包现在可以结构化返回 `requiresReinit`，而不是只靠文案提醒。

---

## 5. 已踩过的主要问题、原因、位置、解决方案

### 问题 A：modify 明明很简单，却会被直接挡在 Codex 执行之前

#### 现象

像“把背景换成白色”这种简单修改，会立即报：

- `Modify request exceeded editable scope and was not dispatched to Codex.`

#### 原因

旧的 `routing.ts` 会依赖 `manifest.editable[]` 做 token overlap 匹配，不命中就把 modify 判成 design，然后在 `/api/package/modify` 里提前 409。

#### 位置

- `L:\game_edit\src\lib\workspace\routing.ts`
- `L:\game_edit\src\app\api\package\modify\route.ts`

#### 解决方案

去掉 editable-scope gating，并把 create / modify 统一成 full-package path。

### 问题 B：修改成功后 Box 里只有 `v1` 没有 `v2`

#### 现象

用户看到游戏已经变了，但 Box 里 session 目录没有新版本。

#### 原因

当时实际请求是从 create path 发的，不是 modify path。只有非 create 模式才会触发 `latestWorkspaceVersion + 1` 的 staging。

#### 位置

- `L:\game_edit\src\components\CodegenAppShell.tsx`
- `L:\game_edit\src\lib\ai-sessions\service.ts`

#### 解决方案

确认 create / modify 的后端语义仍然区分，并在真正 modify 路径上生成 `vN+1`。

### 问题 C：Box 里已经有 `v1 / v2`，浏览器却只看到一个版本

#### 现象

Box 里确实已经存在多个 workspace version，但浏览器端仍然只有一个 currentPackage。

#### 原因

浏览器历史来源仍然是 `project.snapshots`，不是 ai-session Box versions；而 create/modify 成功后前端会直接覆盖 `currentPackage`。

#### 位置

- `L:\game_edit\src\components\CodegenAppShell.tsx`
- `L:\game_edit\src\lib\workspace\storage.ts`

#### 解决方案

新增 ai-session versions API，并让浏览器按需从 Box 读取指定 `vN` 的 payload 进行预览。

### 问题 D：刷新、OAuth 重认证、dev restart 之后 continuity 会断

#### 现象

同一个业务 aiSession，有时会突然丢 continuity，需要重新 init 或看起来像开了新 rollout。

#### 原因

之前 transport runtime 和 transcript 很大一部分只保存在内存 Map 里，dev restart 直接丢，idle expiry 也会清 thread。

#### 位置

- `L:\game_edit\src\lib\ai-sessions\transport-runtime.ts`
- `L:\game_edit\src\lib\ai-sessions\service.ts`

#### 解决方案

1. transport state 与 logs 持久化进数据库。
2. session 重建时先尝试 same-thread resume。
3. 失败时在 same rollout 下重建 thread，而不是新建 rollout。

### 问题 E：`/api/package/generate` 很晚才 500，但 Box 里代码其实已经写好了

#### 现象

前端报：

- `Request failed: fetch failed`

同时 Box 内已经能看到生成代码写进去了。

#### 原因

不是单纯固定 timeout，更像是：

1. Codex turn 已经把文件写进 Box。
2. 但后续 transport/readback 阶段某个 `fetch` 失败。
3. 原来的 `executeMessage()` 对这种晚期异常没有兜底，导致 session 卡死，route 500。

#### 位置

- `L:\game_edit\src\lib\ai-sessions\service.ts`
- `L:\game_edit\src\lib\ai\executors\app-server-package-executor.ts`

#### 解决方案

1. 给 executeMessage 后半段增加 cleanup catch。
2. 对 readback 加一次短重试。
3. 对 create-only late failure 增加 workspace recovery。
4. recovery 成功时结构化标记 `fallbackUsed: true`、`requiresReinit: true`。

---

## 6. 当前我们已经确认的事实

### 已确认成功的部分

1. Box session versioning 已真实工作，`v1 / v2` 可以出现。
2. modify 已能正常执行，不再被 editable-scope 误杀。
3. 浏览器已能从后端按需读取 Box 旧版本。
4. continuity 已不再纯内存化，具备 same-rollout recovery 的基础。
5. `/api/package/generate` 晚期 `fetch failed` 已有后端兜底与恢复路径。

### 已确认仍然存在的问题

1. create 请求整体仍是同步长请求模型，容易让用户感知到很长的等待时间。
2. `雷霆战机` 这类更复杂 prompt 比 `贪吃蛇` 更容易触发 generate 失败。
3. tester / checker 在 UI 上会放大“好像还在额外做很多事”的感知，但它们不是主耗时根因。

---

## 7. 当前代码与当前运行状态的准确结论

### 不是这些问题

1. 不是 Box 版本链没做出来。
2. 不是旧版本浏览完全没接。
3. 不是单纯“前端超时”导致的 `fetch failed`。
4. 不是 tester / checker 本身在后台额外卡住 7 分钟。

### 当前更像这些问题

1. create 仍然把 init + 长 Codex turn + 后处理串在一个同步 HTTP 请求里。
2. 复杂游戏 prompt（如雷霆战机）更容易把这条同步链路推到不稳定区间。
3. Box 写入常常早于 turn 真正完成，因此“文件已出现”并不代表请求已经可以立即成功返回。

---

## 8. 当前最关键的实现/调试方法总结

### 架构方法

1. 把 session workspace 看作真实的可演化版本树，而不是一次性临时目录。
2. 把 `our aiSession` 固定成用户关心的 rollout 身份。

### 路由方法

1. 去掉 editable-scope gating。
2. 把 create / modify 统一成 full-package path。

### Box 方法

1. Box 作为 session versions 的真实来源。
2. 浏览器只做索引与预览，不做完整历史真相存储。

### continuity 方法

1. thread 可以断，但 rollout 默认不分叉。
2. 先尝试 same-thread resume；失败则 same-rollout thread rebuild。

### 晚期失败处理方法

1. 任何 busy-turn 晚期异常都必须 cleanup。
2. readback 使用 bounded retry。
3. create 允许在 transport 晚期失败时，从已写好的 workspace 恢复成功结果，但必须防 stale recovery。

---

## 9. 当前还没完全收口的核心问题（下一步重点）

1. `create` 的同步长请求模型仍然过重，导致“Box 很早写好，但浏览器很久才看到”。
2. 更复杂游戏（如雷霆战机）的 create 仍不稳定，需要继续精确定位失败发生在 turn 内，还是发生在 turn 后的后处理链。
3. tester / checker 当前虽然不是主 gate，但在产品感知上仍然制造了混淆。

---

## 10. 当前最推荐的下一步（如果继续开发）

1. 调整 create 的成功返回时机，不再死等整个 turn 完整结束才回包，而是只要 workspace 已形成有效包，就尽早把结果交给前端。
2. 继续专项排查 `雷霆战机` 类复杂 prompt 的稳定失败原因。
3. 将 `requiresReinit` 接到前端交互层，避免 recovered success 之后用户继续盲发下一轮指令。

---

## 11. 当前可用的人工验证步骤（经验）

1. 在 Box 中核对 `sessions/{sessionId}/vN` 是否按预期生成。
2. 在 AI Session 面板中核对：
   - `activeWorkspaceVersion`
   - `latestWorkspaceVersion`
   - `transportPhase`
   - `recoveryOutcome`
3. 在 `.codex/sessions/.../rollout-*.jsonl` 里核对 create / modify 是否挂在同一条 aiSession continuity 下。
4. 对于 generate 失败，优先看：
   - 是否 Box 已写入文件
   - session 是否 stuck 在 `busy / turn_running`
   - route 是否晚期返回 `fetch failed`

---

## 12. 当前阶段性结论

今天最大的成果不是单个 bug 被修掉，而是 `L:\game_edit` 的 Box + Codex 路径终于从“临时实验链路”变成了“有稳定 session 版本语义、可恢复 continuity、可浏览旧版本、并且能处理晚期 transport failure 的系统”。

但与此同时，也确认了另一个更深层的问题：当前 `create` 仍然是同步重请求模型，对复杂游戏提示词很不友好。因此，后续真正要继续推进，不是再去补 `tester/checker` 文案，而是要继续压缩 create 的返回路径，把“Box 中已经形成有效包”尽早暴露给前端。

---

## 13. 文件索引（本轮重点改过/查过的文件）

### 路由 / 执行链

- `L:\game_edit\src\app\api\package\generate\route.ts`
- `L:\game_edit\src\app\api\package\modify\route.ts`
- `L:\game_edit\src\lib\ai\codex-package-task.ts`
- `L:\game_edit\src\lib\ai\executors\app-server-package-executor.ts`
- `L:\game_edit\src\lib\ai\executors\types.ts`

### ai-session / continuity

- `L:\game_edit\src\lib\ai-sessions\service.ts`
- `L:\game_edit\src\lib\ai-sessions\supervisor.ts`
- `L:\game_edit\src\lib\ai-sessions\transport-runtime.ts`
- `L:\game_edit\src\lib\ai-sessions\repository.ts`
- `L:\game_edit\src\lib\ai-sessions\types.ts`
- `L:\game_edit\src\lib\ai-sessions\workspace.ts`

### Box version browsing

- `L:\game_edit\src\app\api\ai\sessions\[id]\versions\route.ts`
- `L:\game_edit\src\app\api\ai\sessions\[id]\versions\[versionId]\route.ts`
- `L:\game_edit\src\lib\ai-sessions\client.ts`
- `L:\game_edit\src\components\CodegenAppShell.tsx`

### DB / 持久化

- `L:\game_edit\src\lib\db\schema-pg.ts`
- `L:\game_edit\src\lib\db\index.ts`

### routing / contract / prompt

- `L:\game_edit\src\lib\workspace\routing.ts`
- `L:\game_edit\src\lib\workspace\types.ts`
- `L:\game_edit\src\lib\package\contracts.ts`
- `L:\game_edit\src\lib\package\workspace-contract.ts`
- `L:\game_edit\src\lib\ai\package-prompts.ts`
- `L:\game_edit\src\lib\ai\codex-workspace-prompts.ts`

### 测试

- `L:\game_edit\tests\api\ai-sessions-api.test.ts`
- `L:\game_edit\tests\api\package-routes.test.ts`
- `L:\game_edit\tests\projects\ai-session-service.test.ts`
- `L:\game_edit\tests\projects\ai-session-supervisor.test.ts`
- `L:\game_edit\tests\projects\transport-runtime.test.ts`
- `L:\game_edit\tests\projects\app-server-package-executor.test.ts`
- `L:\game_edit\tests\projects\codex-package-task.test.ts`
- `L:\game_edit\tests\projects\workspace-state.test.ts`
- `L:\game_edit\tests\critical\versioning.test.ts`
- `L:\game_edit\tests\components\sandbox-preview.test.ts`
- `L:\game_edit\tests\workspace\server-backed-workspace.test.ts`
