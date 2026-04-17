# L:\game_edit 项目阶段性完整历史总结（2026-04-17 会话整理）

## 1. 文档目的

本文档用于完整整理 2026-04-17 这一天围绕 `L:\game_edit` 所做的分析、实现、调试、架构判断变化、当前结果与剩余问题。

目标仍然是让后续接手的人，在**不回看整段对话**的情况下，也能快速理解：

1. 今天到底解决了什么问题。
2. 哪些判断后来被推翻了，哪些结论被坐实了。
3. 代码层面真实做了哪些改动。
4. 当前已经跑通到什么程度。
5. 目前真正剩下的主问题是什么。
6. 下一步最值得继续推进的技术方向是什么。

---

## 2. 本轮工作的核心目标

今天的工作，最开始其实围绕两个现象展开：

1. `雷霆战机` 这种复杂 prompt 在 Box 里代码还没写完时就报错，前端只能看到 `fetch failed` / `transport lost` 一类错误。
2. `贪吃蛇` 等较简单 prompt 有时能成功生成，但从 Box 中代码已经出现，到前端最终显示之间，仍然存在非常长的延迟。

随着排查推进，今天的目标逐步收敛成下面几条：

1. 先把“复杂 prompt 中途失败”的根因进一步压缩到更具体的层级，而不是停留在抽象 `transport` 错误。
2. 把“阶段级耗时 + 原始失败原因 + recovery 来源”真正暴露到 Workbench，避免继续靠猜。
3. 把 Host OAuth / binding 的“10 分钟体感掉登录”问题处理掉，让行为对齐 1 小时 auth session。
4. 对 daemon / service / Upstash Box 这条链做第一轮稳固改造。
5. 在此基础上，推动一次更大的架构调整：把原来同步长阻塞的 `/execute` 路径改造成 **daemon 内部异步 turn + submit/status/result** 的模型。
6. 在复杂 prompt 已经能成功生成之后，再重新判断“慢回传”到底是不是新的主问题，并继续收敛它的根因。

---

## 3. 需求与架构判断的演进过程

### 3.1 今天最早的判断：不要盲信 26_4_16 的“当前问题结论”

今天一开始，先重新看了：

- `L:\game_edit`
- `L:\game_edit\history\26_4_14`
- `L:\game_edit\history\26_4_15`
- `L:\game_edit\history\26_4_16`

结论是：

1. 之前几天的历史记录对项目整体理解仍然有价值。
2. 但 26_4_16 中对“当前问题根因”的部分判断，不能直接照单全收。
3. 必须结合今天新的真实现象、当前代码和实际联调结果重新收敛。

这一步很重要，因为今天后续的很多判断，最终都证明了：

> **之前一些“像是 tester/checker 卡住”“像是版本读回慢”“像是前端轮询导致”的直觉，都不是今天这个主问题的根因。**

### 3.2 今天把“复杂 prompt 失败”和“成功后回传慢”正式拆成了两个问题

今天一个很关键的收敛是：

1. `雷霆战机` 类复杂 prompt 的失败，属于 **turn 期间失败**。
2. `贪吃蛇` 类简单 prompt 的“成功但前端很晚才显示”，属于 **成功后的回传路径问题**。

也就是说：

> **不是一个问题，而是至少两个问题。**

这一步之后，很多之前混在一起的怀疑就能明确拆开：

- `雷霆战机` 失败不是 readback / promote / preview 展示问题。
- `贪吃蛇` 的慢回显也不等价于“turn 中途断”。

### 3.3 关于“tester/checker 是不是主因”的判断被明确下调

今天曾一度怀疑：

1. Box 里代码已经写完。
2. 终端显示 turn 也结束。
3. 前端仍然迟迟不回。
4. 那会不会是 tester/checker 做了很重的后处理？

后来结合代码和现象重新判断后，今天明确收敛为：

> **tester/checker 会放大“系统还在做很多事”的感知，但它们不是今天复杂 prompt 失败的主因，也不是 6~7 分钟延迟的核心来源。**

### 3.4 “HTTP 轮询不稳定”也被下调为次要因素

今天用户很担心：

- `/logs`
- `/versions`
- `/events`
- status polling

这些 HTTP 轮询本身是不是不稳定，会不会正是把长任务搞挂的根因。

今天的代码级分析结论是：

1. 前端轮询确实存在，而且 `CodegenAppShell.tsx` 里是固定 1 秒一次。
2. 它会带来压力，会制造一部分感知延迟。
3. 但它解释不了：
   - 复杂 prompt 在 Box 里还没写完时就中途死亡
   - 或单次状态请求几分钟级的卡顿

所以今天最终判断是：

> **轮询是问题，但不是今天主问题的第一根因。**

### 3.5 错误定位从“抽象 transport 失败”压缩到了更具体的层级

今天这一天里，错误定位是不断收窄的。

最初看到的是：

- `fetch failed`
- `transport_lost`
- `codex_turn_unexpected_error`

后来通过改造后的 Workbench/failureContext，错误进一步收敛到了：

- `upstash_box_exec_failed`
- `Upstash Box command failed during request: fetch failed other side closed`

这意味着：

> **今天已经不再只是模糊地说“transport 断了”，而是能更具体地说：承载 daemon/curl 的 Box exec stream 在中途被对端关闭。**

### 3.6 今天后半段最重要的路线变化：决定推进 async turn 模型

在复杂 prompt 的失败原因逐渐收敛后，今天进一步确认了一件事：

> **只要主链路仍然依赖“一条长时间存活的 Box exec stream 撑到 turn 完成”，复杂 prompt 迟早还会继续撞上不稳定边界。**

因此今天明确决定：

1. 不再只补 transport/retry 小补丁。
2. 要推动一轮更大的架构调整。
3. 把原来的同步长阻塞 `/execute`，改成：
   - daemon 内部异步执行 turn
   - 宿主侧只做 submit / status / result

这就是今天后半段的 async turn refactor 的背景。

---

## 4. 今天已经落地的主要实现

### 4.1 阶段级耗时与失败原因暴露已经落地

涉及文件：

- `L:\game_edit\src\lib\ai\execution-trace.ts`
- `L:\game_edit\src\lib\workspace\types.ts`
- `L:\game_edit\src\lib\ai\executors\types.ts`
- `L:\game_edit\src\lib\ai\executors\legacy-package-executor.ts`
- `L:\game_edit\src\lib\ai\executors\app-server-package-executor.ts`
- `L:\game_edit\src\lib\ai\codex-package-task.ts`
- `L:\game_edit\src\components\CodegenAppShell.tsx`
- `L:\game_edit\src\components\RequestWorkbench.tsx`

今天这部分已经实现了：

1. `ExecutionStage` / `FailureContext` 被显式结构化。
2. Workbench 能看到 stage timeline。
3. 失败时能看到：
   - `checkpoint`
   - `reason`
   - `code`
   - `message`
   - transport/session 相关上下文
4. 成功结果被分成：
   - `direct_success`
   - `recovered_success`
   - `hard_failure`
5. `recovered_success` 会保留原始 failureContext 和 recovery source。

这是今天整个诊断能力提升的基础。

### 4.2 Workbench / RequestWorkbench 兼容旧 trace 的兜底修复已经落地

涉及文件：

- `L:\game_edit\src\components\RequestWorkbench.tsx`
- `L:\game_edit\src\components\CodegenAppShell.tsx`
- `L:\game_edit\src\lib\ai\execution-trace.ts`

今天中途因为老 trace 数据缺字段，页面连续崩了两次。

已修复内容：

1. 旧 trace 没有 `stages/testsRun/filesProduced` 时，不再直接崩。
2. `upsertExecutionStage()` 和 merge 路径现在都能处理 `undefined/null`。
3. 老 trace 现在可以安全渲染，不会因为历史结构不兼容而把首页打崩。

### 4.3 daemon / transport / Upstash Box 第一轮加固已经落地

涉及文件：

- `L:\game_edit\src\lib\ai-sessions\app-server-daemon.ts`
- `L:\game_edit\src\lib\ai-sessions\service.ts`
- `L:\game_edit\src\lib\sandbox\providers\upstash-box.ts`

今天已经实现的加固包括：

1. daemon `/execute` 超时不再只是写一条 message，而是会真正结束请求。
2. `refreshExternalTokens()` 加了 timeout / catch / structured error。
3. stale wrapper 重新启动前会先 shutdown。
4. health 检查要求 `ok:true`，而不是仅有响应。
5. `box.exec.stream(command)` 的错误现在能被分类，而不是都退化成泛化的 `fetch failed`。
6. service/executor 层会尽量保留底层错误分类，而不是一律只剩 `codex_turn_unexpected_error`。

### 4.4 recovered-success 语义与 Workbench 展示已经收敛

涉及文件：

- `L:\game_edit\src\lib\ai\executors\app-server-package-executor.ts`
- `L:\game_edit\src\lib\ai\codex-package-task.ts`
- `L:\game_edit\src\components\CodegenAppShell.tsx`
- `L:\game_edit\src\components\RequestWorkbench.tsx`
- `L:\game_edit\src\lib\workspace\storage.ts`

今天这部分的关键成果是：

1. 原来“失败后恢复成功”在 UI 上会显得像旧失败残留。
2. 现在 recovered-success 会明确显示：
   - 原始失败
   - recovery source
   - 当前最终 outcome
3. legacy trace 还会被归一化，避免 recovered-success 被误判成 direct success 或 hard failure。

### 4.5 Host binding 体感从 10 分钟对齐到 1 小时

涉及文件：

- `L:\game_edit\src\lib\host-tokens\server\service.ts`

今天做的判断与修改是：

1. 主 OAuth session 正常情况下本来就是约 1 小时。
2. 用户感知到的“掉得很快”，更多来自 binding 那层的 10 分钟逻辑。
3. 已把 `bindTokenExpiresAt` 改成与 host auth session 的 `expiresAt` 对齐。

也就是说：

> **今天已经处理了“登录体感像 10 分钟就掉”的问题。**

### 4.6 async turn refactor 已经开始落地，而且复杂 prompt 已经因此跑通

涉及文件（核心）：

- `L:\game_edit\src\lib\ai-sessions\types.ts`
- `L:\game_edit\src\lib\ai-sessions\repository.ts`
- `L:\game_edit\src\lib\ai-sessions\service.ts`
- `L:\game_edit\src\lib\ai-sessions\client.ts`
- `L:\game_edit\src\lib\ai-sessions\app-server-daemon.ts`
- `L:\game_edit\src\app\api\ai\sessions\[id]\messages\route.ts`
- `L:\game_edit\src\app\api\ai\sessions\[id]\messages\[turnId]\route.ts`
- `L:\game_edit\src\app\api\ai\sessions\[id]\messages\[turnId]\result\route.ts`
- `L:\game_edit\src\app\api\package\generate\route.ts`
- `L:\game_edit\src\app\api\package\modify\route.ts`
- `L:\game_edit\src\app\api\package\debug\route.ts`
- `L:\game_edit\src\components\CodegenAppShell.tsx`

今天这轮改造已经做到了：

1. ai-session turn 有了真正的持久化记录。
2. daemon 侧可以接受 turn submit，并由 turn 记录持有生命周期状态。
3. session API 已具备：
   - submit
   - status
   - result
4. package route 在带 `aiSessionId` 的情况下，会返回：
   - `202`
   - `accepted: true`
   - `asyncTurn`
5. 前端 `CodegenAppShell` 已经能：
   - 记录 `turnId`
   - 用 status/result 做异步轮询和收尾
   - 在 terminal 后拉 result
   - 在 Workbench 中展示 pending / terminal 结果

这轮改造带来的最直接结果是：

> **今天后面用户自己复测时，`雷霆战机` 已经能成功生成。**

这意味着这轮 async turn 改造已经不是纸上方案，而是对主问题产生了真实效果。

---

## 5. 今天踩过并解决掉的关键问题

### 问题 A：新增的 Workbench 诊断字段把首页打崩

#### 现象

页面一打开就报：

- `Cannot read properties of undefined (reading 'length')`
- `Cannot read properties of undefined (reading 'findIndex')`

#### 原因

旧项目/旧 trace 数据没有：

- `stages`
- `testsRun`
- `filesProduced`
- 其他新结构字段

而新 UI 直接假设这些字段存在。

#### 解决

1. 给 `RequestWorkbench.tsx` 增加缺省回退。
2. 给 `CodegenAppShell.tsx` 和 `execution-trace.ts` 增加 `undefined/null` 兼容。
3. 给 workspace storage 增加 legacy trace normalize。

### 问题 B：早期错误过于泛化，看不出究竟断在哪一层

#### 现象

最开始看到的只是：

- `fetch failed`
- `transport_lost`

很难知道：

- 是 daemon 挂了
- 是 Box exec stream 断了
- 还是 refresh 出错

#### 解决

通过 failure classification 改造，把错误进一步压缩到：

- `upstash_box_exec_failed`
- `daemon_execute_timeout`
- `daemon_external_token_refresh_failed`

等更具体层级。

### 问题 C：recovered-success 在 UI 上像“旧失败残留”

#### 现象

像贪吃蛇这种场景，有时会：

1. 先发生 transport error
2. 再从 workspace recovery 成功

但 UI 一度会出现：

- 明明已经成功
- 却看起来像没刷新、像继承了雷霆战机的失败痕迹

#### 解决

今天把结果语义收敛成：

- `direct_success`
- `recovered_success`
- `hard_failure`

并明确展示 original failure + recovery source。

### 问题 D：Host 登录状态体感太短

#### 现象

用户感知到：

- 明明已经登录过了
- 但不久后又像是要重新绑定

#### 原因

不是主 OAuth session 真只有几分钟，
而是 binding 那层给人制造了 10 分钟体感。

#### 解决

把 binding 有效期改成和 1 小时 auth session 对齐。

### 问题 E：复杂 prompt 成功路径虽然打通了，但回传仍然太慢

#### 现象

`雷霆战机` 已经能成功生成，但从 Box 里代码写完到前端最终回显，仍然偏慢。

#### 当前判断

今天后段已经把这个问题进一步收敛到两条最像的原因：

1. daemon `/turns/:id/status` / `/result` 返回 payload 过大
2. 旧同步 `executeMessage()` 主链还活着

这部分今天已经分析清楚，但**还没有继续下刀修改**。

---

## 6. 今天已经打通的主链路

截至今天，以下主链路已经打通或明显推进：

1. Host OAuth / binding 体验从 10 分钟体感对齐到 1 小时。
2. Workbench 能看清：
   - 阶段耗时
   - 原始失败
   - recovery source
   - 最终 outcome
3. `雷霆战机` 类复杂 prompt 已经不再稳定死于旧的长阻塞主链，今天实测已经成功生成。
4. ai-session submit/status/result 的 async turn 基本链路已经落地。
5. 浏览器侧已经能持有 `turnId` 并完成 terminal 后的 result 拉取与收尾。
6. recovered-success 和 hard-failure 的语义已经明显比之前清楚。

这意味着：

> **今天最大的成果，不是单个 bug 被修掉，而是“复杂 prompt 终于能成功生成”这件事已经被 async turn 改造推过了。**

---

## 7. 当前已经确认的事实

### 已确认成功的部分

1. `雷霆战机` 现在已经可以成功生成。
2. Host binding 不再给人“10 分钟就像掉登录”的体感。
3. Workbench 现在已经能明确区分：
   - 直接成功
   - 恢复成功
   - 硬失败
4. 原始失败原因与 recovery source 现在已经能在 UI 中看到。
5. async turn 的 submit/status/result 不是纸面方案，已经接入到主链的一部分。

### 已确认仍然存在的问题

1. 成功后的回传仍然偏慢。
2. daemon 当前仍把 `messages` 整体带进 turn 持久化和 `/status` / `/result` 协议层返回。
3. `CodegenAppShell.tsx` 当前仍是固定 1 秒轮询。
4. `executeMessage()` 旧同步等待链仍然活在主路径上，不是死代码。
5. recovery 逻辑目前仍有新旧两份语义并存的情况，后续需要收敛。

---

## 8. 今天最关键的实现/调试方法总结

### 诊断方法

1. 不再只看 HTTP 状态码，而是强制把 failure 分解到 stage / code / message / transport/session 上。
2. 把“复杂 prompt 失败”和“成功后回传慢”拆成两条不同问题分别分析。
3. 不再把 recovered-success 当成普通 success，而是保留完整失败来源。

### transport / daemon 方法

1. daemon `/execute` 不再只是超时写 message，而要真正结束请求。
2. refreshExternalTokens 必须有 timeout / catch / structured error。
3. stale wrapper 重启前先 shutdown。
4. Box exec 失败必须被具体分类，而不是只剩 `fetch failed`。

### 结果表达方法

1. 统一用 `direct_success / recovered_success / hard_failure`。
2. 原始失败与最终恢复不能互相覆盖。
3. Workbench 必须能回答：
   - 这次到底有没有失败过？
   - 如果失败过，是怎么救回来的？

### async turn 方法

1. 把长时间 turn 生命周期从宿主请求中剥离出来。
2. submit/status/result 分离。
3. 浏览器只持有 `turnId` 和轻量状态，再在 terminal 后拉 result。

---

## 9. 当前还没完全收口的核心问题（下一步重点）

### 9.1 成功后的回传仍然偏慢

这是今天结束时**最主要的遗留问题**。

当前已经比较明确的判断是：

1. 不是生成本身又失败了。
2. 不是 tester/checker 的主耗时。
3. 不是轮询本身单独造成几分钟延迟。
4. 更像是：
   - daemon `/status` / `/result` payload 太大
   - service 内部为了拿轻量状态，仍在搬 full turn
   - 旧同步 `executeMessage()` 链还活着

### 9.2 daemon 协议层的 status/result 还没真正瘦下来

当前状态是：

1. app API 层已经拆成 status / result。
2. 但 daemon 内层 `/turns/:id/status` 和 `/result` 还在回 full turn。
3. 这使得 service 即使只想返回轻量状态，也要先搬完整 turn。

### 9.3 同步 executor 主链还没有彻底清掉

目前已确认：

1. `executeMessage()` 还在 `while + 250ms sleep` 等 terminal。
2. `app-server-package-executor.ts` 仍直接 await 它。
3. package route 的非 `aiSessionId` 分支也仍然可能走这条旧同步链。

也就是说：

> **今天 async turn 已经落地了一大块，但旧同步主链还没有完全退出舞台。**

### 9.4 recovery 逻辑仍有重复/并存

今天已经明确看出：

1. service 层有一套 async turn 的 finalization / recovery 语义。
2. executor 里还留着旧的 `tryRecoverPackageAfterExecutionFailure` / readback 重试逻辑。
3. 这会继续制造语义重叠和维护成本。

---

## 10. 当前最推荐的下一步（如果继续开发）

基于今天的全部排查和当前代码状态，下一轮最推荐的顺序是：

### 优先级 1
**瘦 daemon payload**

建议方向：

1. `turn-status.json` 只保留：
   - phase
   - startedAt
   - completedAt
   - code
   - error
   - turnStatus
   - threadId
   - artifactState
2. 把 messages 单独拆成：
   - `turn-messages.jsonl` 或等价独立文件
3. `/turns/:id/status` 不再返回 `messages`
4. `/turns/:id/result` 默认也不要夹带 `messages`
5. `executionEngine.daemonMessages` 从 public result 里拿掉

### 优先级 2
**彻底切掉同步 `executeMessage()` 主链**

目标是：

1. app-server 主生成路径不再同步 await turn terminal。
2. 主路径统一走：
   - submit
   - status
   - result
3. package route 的非 `aiSessionId` 分支也要决定：
   - 要么强制走 session-backed async
   - 要么至少不要继续用旧同步 executor 作为主路径

### 优先级 3
**前端 polling 改成退避**

推荐做法：

1. 1s → 2s → 4s → 8s
2. terminal 临近阶段可适当缩短
3. 不再固定 1 秒 forever

### 优先级 4
**收敛 recovery 逻辑到一份主语义**

建议保留 service/async turn 那份，逐步削弱 executor 里的旧兼容逻辑。

---

## 11. 当前可用的人工验证步骤（经验）

如果后续继续人工验证，今天已经收敛出下面这些有效检查方式：

1. 在 Workbench 里看：
   - `Outcome`
   - `Original failure`
   - `Recovery source`
   - `Stage Timeline`
2. 观察 `failureContext.code` 是否已经从泛化错误压缩到更具体层级。
3. 对复杂 prompt（雷霆战机）与简单 prompt（贪吃蛇）分别复测，确认：
   - 是否都能生成
   - 是否仍有 recovered-success
   - 成功后回传时间是否还很长
4. 如果继续查慢回传，重点看：
   - daemon `/status` 是否仍搬 full turn
   - `executionEngine.daemonMessages` 是否还随 result 一起返回
   - package route 是否仍走同步 executor

---

## 12. 当前阶段性结论

今天最大的成果，不是把某一个 transport error 文案改得更清楚，而是：

> **把原来“复杂 prompt 会中途失败”的主问题基本打穿了，让 `雷霆战机` 这类复杂提示词也已经能成功生成。**

与此同时，今天也把失败与恢复的可观测性大幅拉高了：

1. 现在不再只看到模糊的 `fetch failed`。
2. Workbench 已能明确显示：
   - 原始失败
   - recovery source
   - final outcome
3. Host binding 的 10 分钟体感问题也已经处理。

但今天也确认了新的主问题：

> **当前系统已经不是“生成总失败”，而是“成功后的回传仍然过重、过慢”。**

而这个新问题，已经比较明确地收敛到了：

1. daemon `/status` / `/result` payload 过大
2. service 仍在内部搬 full turn
3. 旧同步 `executeMessage()` 主链未完全退出

所以今天的阶段性结论可以概括为：

> **今天已经把系统从“复杂 prompt 过早死亡”推进到了“复杂 prompt 可成功生成，但成功回传路径仍需瘦身与去同步化”的阶段。**

---

## 13. 文件索引（本轮重点改过/查过的文件）

### 诊断 / Workbench / trace

- `L:\game_edit\src\lib\ai\execution-trace.ts`
- `L:\game_edit\src\lib\workspace\types.ts`
- `L:\game_edit\src\lib\workspace\storage.ts`
- `L:\game_edit\src\components\CodegenAppShell.tsx`
- `L:\game_edit\src\components\RequestWorkbench.tsx`

### ai-session / daemon / async turn

- `L:\game_edit\src\lib\ai-sessions\service.ts`
- `L:\game_edit\src\lib\ai-sessions\repository.ts`
- `L:\game_edit\src\lib\ai-sessions\types.ts`
- `L:\game_edit\src\lib\ai-sessions\client.ts`
- `L:\game_edit\src\lib\ai-sessions\app-server-daemon.ts`
- `L:\game_edit\src\lib\ai-sessions\app-server-stdio.ts`

### Box / sandbox / runtime

- `L:\game_edit\src\lib\sandbox\providers\upstash-box.ts`

### package route / executor

- `L:\game_edit\src\app\api\package\generate\route.ts`
- `L:\game_edit\src\app\api\package\modify\route.ts`
- `L:\game_edit\src\app\api\package\debug\route.ts`
- `L:\game_edit\src\lib\ai\codex-package-task.ts`
- `L:\game_edit\src\lib\ai\executors\types.ts`
- `L:\game_edit\src\lib\ai\executors\legacy-package-executor.ts`
- `L:\game_edit\src\lib\ai\executors\app-server-package-executor.ts`

### host token / OAuth / binding

- `L:\game_edit\src\lib\host-tokens\server\service.ts`
- `L:\game_edit\src\app\api\codex\host\session\latest\route.ts`
- `L:\game_edit\src\app\api\codex\host\session\refresh\route.ts`
- `L:\game_edit\src\app\api\codex\host\session\revoke\route.ts`

### ai-session routes

- `L:\game_edit\src\app\api\ai\sessions\[id]\messages\route.ts`
- `L:\game_edit\src\app\api\ai\sessions\[id]\messages\[turnId]\route.ts`
- `L:\game_edit\src\app\api\ai\sessions\[id]\messages\[turnId]\result\route.ts`

### 相关测试

- `L:\game_edit\tests\projects\app-server-daemon.test.ts`
- `L:\game_edit\tests\projects\ai-session-service.test.ts`
- `L:\game_edit\tests\projects\ai-session-service-transport-hardening.test.ts`
- `L:\game_edit\tests\api\ai-sessions-api.test.ts`
- `L:\game_edit\tests\api\package-routes.test.ts`
- `L:\game_edit\tests\workspace\server-backed-workspace.test.ts`
- `L:\game_edit\tests\storage\host-token-service-server.test.ts`
- `L:\game_edit\tests\storage\host-token-service-client.test.ts`
- `L:\game_edit\tests\sandbox\upstash-box-provider.test.ts`
