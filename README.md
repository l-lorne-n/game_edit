# AI Mini-Game Workspace

使用方法：
1：git clone 到本地文件夹

2：cd game_edit

3：找到 .env.example文件,将其重命名为.env,该项目默认使用中转站apipyi的apikey,将key粘贴到APIYI_LLM_API_KEY的后面,同时保留了openrouter的接口(但是该通道测试不足,无法保证一定好用),如果想要切换到open router,请先将#LLM_PROVIDER=apiyi这行取消注释,并将apiyi更换为openrouter,同时将其对应的key填到OPENROUTER_LLM_API_KEY后面.

4：npm install 

5：npm run dev

6：打开本地3000端口即可

项目说明

这是一个分两阶段演进的 AI 原生 2D 游戏编辑器项目。

- 第一版（v1）是“受约束 DSL + 可玩预览”的 AI 游戏原型编辑器。
- 第二版（v2）是在第一版经验基础上，演进出的“多项目 + 代码生成 + 沙箱运行 + 调试/修复 + Workbench 可解释性”工作区。

当前仓库默认分支面向第二版使用场景，但第一版相关代码仍然保留在仓库中，方便展示演进过程与设计取舍。

## 项目目标

这个项目不是通用游戏引擎，也不是为了追求复杂美术效果。

它想解决的是一个更具体的问题：

- 用户输入自然语言
- AI 尝试生成一个可运行的小游戏原型
- 系统尽量对生成结果做校验、修复、归档与解释
- 用户可以继续修改、调试、回退、分支化迭代

换句话说，这个项目关注的重点是：

- 自然语言到游戏原型的闭环
- 生成结果的可运行性
- 失败时的兜底与修复
- 版本管理与可解释性

---

## 第二版（当前主版本）：多项目代码生成工作区（第一版的介绍在下面，第二版是主要版本，先介绍第二版）

第二版的核心思想是：

- 不再只生成受约束的 dodge DSL
- 而是生成一个固定结构的小游戏代码包
- 把小游戏放进浏览器沙箱里运行
- 通过测试者与检查者流程决定是否可用
- 用项目与快照管理整个生成/修改/修复过程

### 第二版整体架构

第二版的主入口在：

- `src/app/page.tsx`
- `src/components/CodegenAppShell.tsx`

它把系统拆成 4 个关键层：

1. UI 工作区层
2. 项目/快照状态层
3. AI 代码生成与修复层
4. 沙箱运行与测试层

### 第二版的 Agent 系统与分工

第二版在产品表现上采用了“架构师 / 工人 / 修理工 / 测试者 / 检查者”的角色设计，但底层不是五个完全独立的自治体，而是一个更务实的组合：

- 生成角色（Architect / Worker / Fixer）
- 确定性测试角色（Tester）
- 审查与路由角色（Checker）

这样设计的原因是：

- 让用户能理解当前系统“正在做什么”
- 又避免做成一个复杂但不可靠的多 agent 传话系统

#### 1. 架构师（Architect）

职责：

- 在新建游戏时负责生成完整的小游戏包，并同时确定哪些参数（比如背景颜色、速度等）为editable，当玩家需要对这些参数进行修改时，直接转入“工人”
- 在用户修改已经明显超出原有 editable 范围时，负责做设计级重构
- 输出新的包结构、玩法规则、manifest 描述与可编辑范围

为什么需要它：

- 有些修改不是“补丁式修改”，而是在改玩法规则本身
- 例如碰撞逻辑、穿墙规则、核心机制变化，不适合交给只做局部 patch 的角色

能力边界：

- 允许触及 `indexHtml`、`gameJs`、`styleCss`、`manifestJson` 四个文件
- 允许改变玩法逻辑与结构
- 适用于 `design` 路由

对应代码：

- `src/lib/workspace/routing.ts`
- `src/components/CodegenAppShell.tsx`

#### 2. 工人（Worker）

职责：

- 处理落在当前 editable scope 内的修改请求
- 例如已有玩法上的小幅改动、数值调整、界面文案、局部逻辑 patch

为什么需要它：

- 不是每次修改都要走“重构”
- 当用户只是改小范围内容时，直接 patch 更快、更便宜，也更符合编辑器语义

能力边界：

- 主要面向 `patch` 路由
- 默认只应该做局部修改，不负责大规模重构
- editable scope 主要来自当前包的 `manifest.editable`

对应代码：

- `src/lib/workspace/routing.ts`
- `src/components/CodegenAppShell.tsx`

#### 3. 修理工（Fixer）

职责：

- 接收用户给出的错误描述，或者检查者直接转发来的错误状态
- 结合当前目标版本、最近 evaluator 结果与运行状态，尝试做修复

为什么需要它：

- “改功能”和“修错误”是两条不同的产品路径
- 修错误时，用户通常希望系统围绕某个明确目标版本和报错上下文来修，而不是重新设计玩法

能力边界：

- 对应 `debug` 模式
- 可以修改四文件包，但其目标是“修复可运行性或行为问题”，不是重新定义产品方向

对应代码：

- `src/components/CodegenAppShell.tsx`
- `src/app/api/package/debug/route.ts`
- `src/lib/ai/generate-package.ts`

#### 4. 测试者（Tester）

职责：

- 不是 LLM agent，而是确定性的运行验证工具
- 在沙箱中检查小游戏是否启动、是否报错、是否返回测试结果

为什么这样设计：

- 如果“测试者”也是一个会瞎猜的模型，那整个系统会失去可信度
- 这里必须尽量靠可重复的确定性行为

能力边界：

- 只负责运行与记录，不做主观评估
- 当前可做的验证包括：
  - iframe sandbox 启动
  - READY 握手
  - `runTests()` 钩子（如果项目实现了）
  - 运行时报错捕获
  - 超时检测

对应代码：

- `src/components/SandboxPreview.tsx`
- `src/lib/evaluator/static.ts`
- `src/lib/evaluator/types.ts`

#### 5. 检查者（Checker）

职责：

- 给修改请求做路由判断
- 判断这次请求更像是 worker patch 还是 architect redesign
- 汇总 tester 结果与执行信息，形成可解释输出，如果tester报错，将问题直接转发给“修理工”

为什么需要它：

- 如果只显示“成功/失败”，用户不知道系统到底为什么这么决定
- 检查者是系统的解释层和边界判断层

能力边界：

- 它可以建议与解释
- 它负责给出 `routeDecision`
- 但它不是独立执行者，真正执行仍由生成/修复角色完成

对应代码：

- `src/lib/workspace/routing.ts`
- `src/components/RequestWorkbench.tsx`
- `src/components/CodegenAppShell.tsx`

### 第二版如何确定 agent 分工

当前第二版的路由决策核心在：

- `src/lib/workspace/routing.ts`

它主要根据三件事判断：

1. 当前模式
   - `create`
   - `modify`
   - `debug`
2. 当前目标版本的 `manifest.editable`
3. 用户请求中是否包含明显的“规则/机制级改动”信号

例如：

- `create` -> 默认走架构师
- `debug` -> 默认走修理工
- `modify` -> 先看是否命中 editable scope；如果像是碰撞规则、墙体规则、机制变化，则更倾向架构师

### 第二版的代码产物结构

第二版不再让 AI 输出旧版 DSL，而是输出一个固定的 4 文件包：

- `indexHtml`
- `gameJs`
- `styleCss`
- `manifestJson`

相关定义在：

- `src/lib/package/contracts.ts`
- `src/lib/package/template.ts`

这样做的原因是：

- 仍然允许“任意小游戏代码生成”
- 但把输出限制在可控范围内，便于：
  - 归档
  - diff
  - fallback
  - 修理
  - 沙箱测试

### 第二版的项目与归档管理

第二版引入了“工作区 -> 项目 -> 快照”的层级：

- 一个工作区里可以有多个项目
- 一个项目代表一个小游戏
- 一个项目下面可以有多个快照（归档版本）

相关核心代码：

- `src/lib/workspace/types.ts`
- `src/lib/workspace/state.ts`
- `src/lib/workspace/storage.ts`

#### 项目管理

支持：

- 新建项目
- 删除项目
- 切换项目
- 项目级聊天记录保留

删除项目时：

- 会连带删除该项目下全部快照
- 这是有意设计的，因为项目是最上层容器

#### 快照（归档）管理

支持：

- 自动归档新结果
- 手动归档当前结果
- Restore 恢复历史版本
- 选择某个快照作为修改基线
- 选择某个快照作为 Debug 目标
- 父子快照关系展示
- 删除父级快照时递归删除子分支

快照分支关系与去重/层级展示逻辑主要在：

- `src/lib/workspace/state.ts`

#### 本地持久化设计

第二版的数据默认保存在浏览器本地，而不是云端。

优先使用：

- IndexedDB

兜底使用：

- localStorage

相关实现：

- `src/lib/workspace/storage.ts`

并且还支持把第一版遗留的 archive 数据迁移成：

- `Imported Legacy Project`

### 第二版 UI 结构

第二版主界面由四块区域组成：

#### 1. 左侧项目栏

作用：

- 显示项目列表
- 新建项目
- 切换当前项目
- 删除当前项目

对应代码：

- `src/components/CodegenAppShell.tsx`

#### 2. 中左聊天区

作用：

- 展示当前项目的完整消息记录
- 提供三种显式模式切换：
  - 创建游戏
  - 改游戏
  - 修错误
- 在 `modify` 模式下选择修改基线快照
- 在 `debug` 模式下选择修复目标版本

设计原因：

- 不再让系统暗中猜“你是在修改还是在报错”
- 把用户意图显式表达成模式

#### 3. 中间状态栏

作用：

- 展示当前请求的 agent 执行状态
- 用 `generator / tester / checker` 三段状态展示本次运行过程
- 显示状态 badge、说明文字与耗时

这是“产品化的 agent 视觉层”，帮助用户理解当前系统在忙什么。

#### 4. 右侧预览与快照区

作用：

- 显示当前项目的游戏预览
- 管理快照
- Restore / Archive / Delete Snapshot
- 选择当前查看的快照

### 第二版 Workbench 设计

第二版重新引入了 Workbench，并把它变成解释层。

对应代码：

- `src/components/RequestWorkbench.tsx`

Workbench 目前有 4 个大框：

#### 1. Routing Summary

里面展示：

- 这次请求被路由到哪个 agent
- routeMode 是 `design / patch / repair` 哪一种
- confidence
- primary / secondary reason codes
- inferred editable scope
- allowedPaths
- allowedChangeTypes
- 这次为什么这么路由

这个框解决的问题是：

- “为什么这次是工人，不是架构师？”

#### 2. Execution Trace

里面展示：

- requestMode
- endpoint
- targetId
- roleLabel
- statusMessage
- source（model / repair / template 等）
- provider / model
- repaired / fallbackUsed
- staticCode / sandboxCode
- testsRun
- filesProduced

这个框解决的问题是：

- “这次到底真正跑了什么？”

#### 3. Evaluator

里面展示：

- 当前 evaluator 结果
- READY / TIMEOUT / TEST_FAILED 等状态
- bootMs
- errors / logs

这个框用来解释：

- 系统为什么认为它能跑/不能跑

#### 4. Attempts

里面展示：

- attemptsCount
- 每次模型尝试的：
  - provider
  - model
  - mode
  - outcome
  - durationMs
  - errorMessage

这个框用来解释：

- 为什么会 fallback
- 是 parse 失败、schema 失败、error 还是 timeout

### 第二版的运行与验证链路

第二版的 API 主要是：

- `src/app/api/package/generate/route.ts`
- `src/app/api/package/modify/route.ts`
- `src/app/api/package/debug/route.ts`

背后的主逻辑在：

- `src/lib/ai/generate-package.ts`

主链路大致是：

1. 根据模式生成 prompt
2. 调用模型
3. 从返回文本中提取 JSON/YAML 候选
4. 解析为 4 文件包
5. 做静态校验
6. 不通过则做一次 repair
7. 再不通过则 fallback 到模板包

### 第二版的沙箱与测试

当前第二版不是把生成代码直接跑在宿主页面，而是用 iframe sandbox 运行。

相关代码：

- `src/components/SandboxPreview.tsx`

主要做了这些事：

- 通过 `srcdoc` 注入小游戏包
- 用 `postMessage` 做 host/guest 通信
- 监听 READY
- 触发 `RUN_TESTS`
- 捕获：
  - runtime error
  - unhandled rejection
  - console.error
  - READY timeout

这样做的意义是：

- 让 AI 生成的小游戏尽量隔离运行
- 不直接污染主应用页面
- 同时又能把运行结果传回 Workbench

### 第二版的局限

第二版虽然比第一版自由很多，但它仍然有明确边界：

- 仍然不是通用游戏引擎
- 仍然没有真正的云端项目同步
- 生成结果可能 fallback
- `runTests` 并不是所有生成项目都稳定实现
- OpenRouter 路径虽然预留了，但主验证路径仍然是 apiyi
- 当前的路由决策仍然是启发式，不是完美规划器

---

## 第一版：受约束 DSL 游戏编辑器

第一版的目标不是任意生成小游戏，而是：

- 在一个狭窄玩法域里
- 把自然语言稳定映射成结构化 DSL
- 再把 DSL 映射成可玩的浏览器原型

### 第一版为什么需要 DSL

第一版最大的问题是：

- 直接让 AI 输出“最终游戏代码”太不稳定
- 很难验证
- 很难修复
- 很难版本化

所以第一版在 AI 和运行时之间设计了一个中间映射层：

- `GameDsl`

相关定义：

- `src/lib/game/dsl.ts`

这个中间层把“游戏”约束成固定结构：

- `meta`
- `arena`
- `player`
- `enemies`
- `spawners`
- `collectibles`
- `rules`
- `ui`
- `theme`

它的价值在于：

- AI 输出先变成结构化数据
- 再由系统统一做校验、修复、预览
- 不直接相信原始模型输出

### 第一版如何解决“AI 发来的内容难以解析”

第一版的关键经验就是：

- 模型并不会老老实实输出你想要的严格 JSON

它会出现的问题包括：

- YAML / JSON 混用
- 外层包了 `dsl` / `game` 字段
- 字段名不统一
- 数值和字符串类型混乱
- 版本号写成 `1`、`1.0`、`v1`
- collectibles / enemies / spawners 的结构别名五花八门

第一版的解决方案主要落在：

- `src/lib/game/validate.ts`
- `src/lib/ai/generate-game.ts`

#### 第一步：提取结构化候选

在 `src/lib/ai/generate-game.ts` 里：

- 先尝试结构化输出
- 不行再从普通文本里提取 JSON / YAML 候选
- 支持 code fence 与裸对象

这一步解决的是：

- “模型没有按最理想格式说话，但也许还能救回来”

#### 第二步：做统一归一化

在 `src/lib/game/validate.ts` 里：

- `normalizeDslCandidate()`
- `adaptToCanonicalDsl()`

它会把各种近似结构映射成统一 DSL：

- 版本号统一成 `1.0`
- arena/player/enemy/spawner/collectible 的别名字段统一
- 缺失字段补默认值
- 不完整配置补成可玩的最小结构

这一步就是第一版最重要的“中间映射层经验”。

#### 第三步：做三层验证

第一版不是只做 schema parse，而是做三层验证：

1. schema validation
2. rules validation
3. smoke simulation

对应代码：

- `src/lib/game/validate.ts`
- `src/lib/game/rules.ts`
- `src/lib/game/smoke.ts`

也就是：

- 结构合法还不够
- 还要看规则是否合法
- 最后还要跑一个烟雾测试，看它能不能基本跑起来

#### 第四步：repair 与 fallback

在 `src/lib/ai/generate-game.ts` 中：

- 如果生成结果验证不过，会尝试 repair
- repair 再不过，就 fallback

fallback 来源包括：

- 模板 DSL
- last known good

对应代码：

- `src/lib/game/templates.ts`

这一步解决的是：

- “即使模型不稳定，UI 也尽量别彻底坏掉”

### 第一版的版本管理

第一版虽然还是单项目，但已经有了后面第二版版本系统的雏形：

- `live`
- `staged`
- `archive`
- lineage
- subtree delete

核心代码：

- `src/lib/state/session.ts`
- `src/lib/state/versioning.ts`
- `src/components/AppShell.tsx`

当时做的事情包括：

- 明确 modify 基线
- 归档去重
- 父子归档关系
- 删除父节点时级联删除子节点

这些能力后来直接变成了第二版 project/snapshot 体系的重要基础。

### 第一版的局限

第一版有很明显的边界：

- 只支持 top-down 2D dodge-survival 一种玩法域
- collectible 本质上还是 coin 语义
- 运行时是单解释器，不是真正多玩法引擎
- UI 更像单项目原型台，不像工作区
- 只能在受约束 DSL 域里“稳定生成”，不能自由生成小游戏代码

### 第一版给第二版打下了什么基础

第一版最大的价值不只是“做出一个 dodge 编辑器”，而是积累了第二版最关键的工程经验：

1. 云端模型接入经验
   - provider 配置
   - model 调用
   - timeout
   - repair
   - fallback

2. 解析不稳定 AI 输出的经验
   - 提取 JSON/YAML
   - 别名归一化
   - 中间结构统一

3. 运行前验证的经验
   - schema
   - rules
   - smoke

4. 版本管理经验
   - baseline
   - archive
   - lineage
   - subtree delete

5. Workbench / 状态可解释性需求
   - 用户不只需要“成功/失败”
   - 还需要知道到底发生了什么

正是因为第一版把这些基础问题趟过一遍，第二版才有能力从“受约束 DSL 编辑器”继续走到“多项目代码生成工作区”。

---

## 当前仓库结构（按两代系统共存理解）

```text
src/
  app/
    api/
      game/         # 第一版 DSL 路由
      package/      # 第二版代码包路由
      health/
  components/
    AppShell.tsx            # 第一版 UI
    CodegenAppShell.tsx     # 第二版 UI 主入口
    SandboxPreview.tsx      # 第二版沙箱预览
    RequestWorkbench.tsx    # 第二版 Workbench
  lib/
    ai/
    evaluator/
    game/
    package/
    runtime/
    state/
    workspace/
tests/
  critical/       # 第一版关键测试
  projects/       # 第二版项目/快照测试
  sandbox/        # 第二版沙箱测试
```

---

## 运行方式

### 基本运行

```bash
npm install
npm run dev
```

打开：

- `http://localhost:3000`

### 环境变量

建议复制：

- `.env.example` -> `.env.local` 或 `.env`

最小可用配置（apiyi）：

```env
APIYI_LLM_API_KEY=你的key
MODEL_CALL_TIMEOUT_MS=120000
```

可选显式写法：

```env
LLM_PROVIDER=apiyi
APIYI_LLM_API_KEY=你的key
MODEL_CALL_TIMEOUT_MS=120000
```

注意：

- 如果没有 API key，界面仍可运行，但会更多依赖 fallback package
- OpenRouter 路径存在，但当前主验证路径仍以 apiyi 为主

---

## 验证命令

```bash
npm run lint
npm run test:critical
npm run test:projects
npm run test:sandbox
npm run build
```

---

## 当前版本一句话总结

如果只用一句话描述当前仓库，我会这样说：

> 这是一个从“受约束 DSL 游戏编辑器”演进到“多项目 AI 小游戏代码生成工作区”的实验性全栈项目，重点不在做通用引擎，而在自然语言生成、可运行性验证、修复兜底、版本管理与可解释性。
