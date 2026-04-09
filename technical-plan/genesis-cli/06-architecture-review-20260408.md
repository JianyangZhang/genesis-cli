# Genesis CLI 架构评审报告（基于 `origin/main@5d81d53`）

## 1. 评审目标

本报告基于第一性原理，对当前 `Genesis CLI` 在最新基线上的整体架构进行一次面向后续技术决策的深度评审。

评审关注的不是“某个功能是否已经做出来”，而是更底层的五个问题：

1. 当前架构是否服务于一个清晰、稳定、可演进的产品主线。
2. 各层边界是否真正由代码兑现，而不是只停留在文档口径。
3. 当前的复杂度主要来自产品必需，还是来自边界错位和历史包袱。
4. 相对 `pi-mono` 的内化策略是否合理，哪些改造是必要的，哪些地方削薄过头。
5. 如果继续迭代，接下来 1 到 3 个阶段的投资应该优先放在哪里，才能最大化收益并最小化返工。

***

## 2. 评审范围与方法

### 2.1 范围

本次评审覆盖：

- 根级产品与开发文档：`README.md`
- 技术方案文档：`technical-plan/genesis-cli/*`
- 核心包：
  - `packages/app-cli`
  - `packages/app-tui-core`
  - `packages/app-ui`
  - `packages/app-runtime`
  - `packages/app-tools`
  - `packages/kernel`
  - `packages/pi-ai`
- 参考上游：`/Users/zhangjianyang/pi-mono`

### 2.2 方法

评审采用“第一性原理 + 代码实态交叉验证”的方式：

- 先看产品主链是什么，再判断代码是否围绕主链组织。
- 先看系统必须解决的最小问题，再判断当前分层是否最直接地解决这些问题。
- 先识别真正的系统边界，再评估这些边界是否被不该承载的层所侵入。
- 对 `pi-mono` 不做“是否相似”的表面比较，而是分析“哪些能力被内化、哪些被删除、删除后是否补上了替代品”。

***

## 3. 执行摘要

### 3.1 总体判断

当前 `Genesis CLI` 的总体方向是正确的，且比很多“CLI Agent 项目”更接近可持续演进的状态。

核心优点在于：

- 已经形成相对清晰的分层意识：`app-cli -> app-tui-core/app-ui -> app-runtime -> kernel -> pi-agent-core`
- 已经明确把产品体验、终端渲染、运行时编排、工具治理和底层内核分开
- 已经围绕 `Interactive / Print / JSON / RPC` 建立共享 runtime 主链
- 已经主动内化最关键的 provider / session / auth / tools 能力，避免继续绑死在上游高层产品栈
- 已经在 debug、自检、recent sessions、resume、权限治理等高价值链路上补足一部分产品化基础

但从“可长期演进的产品内核”标准看，当前架构仍处于“方向基本正确、关键边界尚未拉直”的阶段，而不是“主架构已经稳定完成”的阶段。

### 3.2 一句话结论

当前最大的问题不是功能不够多，而是：

`kernel` 被最小化后只保留了“可运行能力”，却没有完整保留 `session core`；其结果是 `app-runtime` 与 `app-cli` 不得不长期兜底会话、历史、恢复、命令与体验层语义，形成新的边界回流。

### 3.3 决策建议

后续技术决策应遵循以下优先级：

1. 先把 `session core` 补完整，避免历史/恢复/压缩/摘要/会话元数据继续分散在多层。
2. 再把命令系统和 interactive orchestration 收回到稳定边界，降低 `app-cli` 的过重宿主职责。
3. 再推进 MCP、extensions、subagent、plan 的产品化，而不是继续在当前边界不稳的情况下扩大协议面。

***

## 4. 现状分析

## 4.1 当前主链

当前真实主链可以概括为：

`app-cli -> app-ui + app-tui-core -> app-runtime -> kernel -> pi-agent-core -> provider/tool backends`

从职责角度看：

- `app-cli`
  - 负责命令入口、参数解析、interactive 模式宿主、TTY 生命周期、启动前自检、bootstrap 接线
  - 真实入口明确，但 interactive 逻辑仍然偏重
- `app-tui-core`
  - 负责 terminal capability、mode lifecycle、frame diff、screen composition
  - 方向正确，是后续把终端语义从 `app-cli` 中拆出的关键抓手
- `app-ui`
  - 负责 formatter、resume browser、footer、slash command registry 和部分命令定义
  - 已经具备“体验层库”的雏形，但尚未完全承接 interactive 语义
- `app-runtime`
  - 负责统一 `SessionFacade`、事件标准化、工具治理接线、plan engine、recent session catalog
  - 是当前多模式共享主线里最健康的一层
- `app-tools`
  - 负责工具目录、风险分级、权限引擎、mutation queue、审计
  - 已经形成独立治理边界，结构合理
- `kernel`
  - 负责最小会话创建、provider registry、provider 实现、auth storage、model registry、built-in tools、session metadata
  - 是当前最关键也是最需要进一步重构的一层

## 4.2 当前架构的正向信号

### 4.2.1 产品主线已被明确限定

这是当前架构最重要的优点之一。

项目已经不再试图同时把所有 provider、所有宿主、所有协议面一次做满，而是明确：

- 以 OpenAI-compatible 路径作为近期产品主链
- Anthropic 路径保留最小兼容
- interactive workbench 是当前产品体验主场
- README、technical-plan、代码实现基本围绕同一主线收敛

这意味着当前项目已经避免了最常见的架构陷阱之一：没有主线，所有模块都“看起来重要”。

### 4.2.2 分层意识比功能堆叠更强

从代码结构和文档口径看，当前团队已经明确拒绝了以下错误方向：

- 不把 `app-cli` 当成总控黑洞
- 不把 `runtime` 直接做成 provider 协议层
- 不把 `kernel` 直接塞回产品体验逻辑
- 不继续沿用旧 mode-dispatch 渲染堆叠，而是引入 `app-tui-core`

这说明项目不是在无意识地“边写边长”，而是在主动做结构治理。

### 4.2.3 runtime 事件契约方向正确

`app-runtime` 通过 `SessionFacade`、`EventNormalizer` 和统一 `RuntimeEvent`，把上游原始事件转成产品层稳定契约，这个方向非常正确。

其价值在于：

- Interactive / Print / JSON / RPC 可以共享同一语义层
- CLI 模式不必直接理解 kernel 原始事件
- 后续可以围绕 runtime contract 建立更稳定的测试和宿主接入层

这是当前项目里最接近“长期稳定平台层”的部分。

### 4.2.4 工具治理已被从执行内核剥离

`app-tools` 作为独立的 catalog/policy/audit 边界，是很好的结构决策。

它的好处是：

- tool governance 不与 provider 实现硬耦合
- permission / audit / mutation queue 成为可独立演进的产品治理层
- MCP 即便还未真正跑通，也至少有了治理落点

### 4.2.5 对复杂链路开始重视可观测性

当前基线里，interactive 启动前自检、debug trace-id、auth source 解析、session recovery source 日志、recent session prune 等路径已经具备明显的产品级调试意识。

这对后续继续做复杂功能非常关键，因为这类系统一旦没有观测面，后续会快速退化成“只有作者自己知道怎么修”。

***

## 5. 第一性原理视角下，当前系统真正要解决什么问题

如果从第一性原理出发，`Genesis CLI` 不是“一个会调模型的 CLI”，而是一个需要同时解决以下六类问题的系统：

1. 稳定会话
   - 用户开始、继续、压缩、恢复、切换、查看历史时，不应破坏上下文一致性
2. 稳定执行
   - 模型请求、工具调用、权限判定、错误恢复要形成闭环
3. 稳定交互
   - interactive 工作台要具备清晰的输入、滚动、权限、状态和恢复体验
4. 稳定模式复用
   - interactive / print / json / rpc 不能各自维护不同的语义真相
5. 稳定演进
   - 新增 MCP、subagent、extensions、plan 时，不能打散现有主线
6. 稳定维护
   - 架构必须可测试、可调试、可回归、可接手

用这六条倒推当前系统，最大的短板不是 UI 还不够像 Claude，也不是 MCP 还没做完，而是：

会话这一根主轴还没有被一个足够稳固的核心边界接住。

***

## 6. 关键问题清单

以下问题按严重度与决策影响排序。

## 6.1 P0: `session core` 被削得过薄，导致会话语义分散

### 现象

当前 `packages/kernel` 具备最小可运行 session 能力：

- 新建 session
- 从 `sessionFile` 恢复 messages
- 手动 compaction
- 基础 metadata 提取

但它并不具备一个成熟 `session core` 应有的完整能力集合，例如：

- 稳定的 session metadata 模型
- 统一的 transcript persistence 规范
- 分支/重开/树形会话能力
- 更完整的 compaction lifecycle
- 更明确的 resume/context rebuild contract
- 会话标题、摘要、预览、工作目录、模型变化等统一归档边界

### 结果

这些能力被拆散到多层：

- `kernel/session-metadata.ts` 维护一套基于 session jsonl 的 metadata 提取逻辑
- `app-runtime/services/recent-session-catalog.ts` 维护另一套用户级 recent session 持久化与搜索逻辑
- `app-cli/mode-dispatch.ts` 维护 interactive 场景下的恢复展示、输入回写、部分 session-facing orchestration

### 根因

内化 `pi-mono` 时保留了“可运行的 session 最小主链”，但没有同步保留 `pi-mono` 里已经较成熟的 session domain 能力，导致“最小化成功了，可持续性没有一起保住”。

### 影响

- 会话恢复链路存在双真相风险
- `resume` 的产品语义依赖运行时补丁而非内核事实
- compaction、summary、preview、recent history 很难形成单一事实来源
- 后续做 `/clear`、fork、history、branching、跨宿主恢复时成本会持续上升

### 结论

这是当前最重要的架构问题，优先级高于继续扩命令和扩协议面。

***

## 6.2 P0: 历史与恢复存在“双轨持久化”，边界不够稳定

### 现象

当前至少存在两条会话数据轨：

1. kernel 本地会话文件
   - `.genesis-local/sessions/*.jsonl`
2. runtime 用户级 recent catalog
   - `~/.genesis-cli/sessions/recent.json`
   - `~/.genesis-cli/sessions/entries/<sessionId>.json`

前者更接近底层恢复数据，后者更接近产品层 resume 目录。

### 问题

双轨本身并不是绝对错误，但当前实现中存在以下风险：

- metadata 来源不统一
- 字段语义存在重复推断
- runtime 在关闭会话、输入、assistant text、compaction event 等多个时机增量写 recent catalog
- sessionFile 与 recent entry 的一致性更多依赖调用顺序，而不是明确的领域契约

### 为什么这是架构问题

如果一个系统的“恢复真相”需要由多个层在不同时间点拼出来，那么：

- 调试成本高
- 跨模式复用会脆弱
- 后续引入 IDE host / RPC host 时会出现更多同步问题

### 结论

应尽快把“底层会话事实”和“产品级 resume 索引”明确区分：

- 一个作为 source of truth
- 一个作为 index / cache / projection

而不是让两者都带有部分事实语义。

***

## 6.3 P0: interactive 主线仍然让 `app-cli` 承担过多产品语义

### 现象

`app-cli/src/mode-dispatch.ts` 中集中承载了大量 interactive 主线逻辑：

- transcript buffer
- thinking / assistant / usage 状态
- permission pending UI
- changed paths 跟踪
- resume browser orchestration
- 内建公开 slash commands
- footer / welcome / input loop 交互拼装

### 问题

`app-cli` 理论上应是 mode host 和 TTY 宿主，但当前它仍然承担了过多“显示什么、恢复如何表现、命令如何组织、状态如何解释”的产品层职责。

这会导致：

- `app-ui` 无法成为真正的体验层中心
- interactive 体验迭代仍需频繁改 `app-cli`
- future host（IDE、RPC UI）更难复用这套产品语义

### 结论

`app-cli` 已经比早期更克制，但还没有真正完成从“interactive 总装车间”到“宿主层”的收口。

***

## 6.4 P1: 命令体系仍然分裂，公开命令与执行模型还未完全统一

### 现象

当前 slash command 的定义分散在两处：

- `app-cli` 中维护一批 interactive 公开命令，如 `/help` `/exit` `/clear` `/resume` `/review` `/status` 等
- `app-ui` 中维护另一批 built-in commands，如 `/model` `/compact` 以及部分 internal 命令

同时，technical-plan 也明确指出当前命令类型体系仍未完全打通 `prompt / ui / local` 执行链。

### 问题

这意味着系统尚未拥有一个统一命令平台，具体表现为：

- 命令定义位置不唯一
- 命令类型语义不完全统一
- 公开命令和内部命令之间的分层不够系统化
- interactive 命令逻辑与 UI 宿主耦合仍然偏紧

### 影响

- 后续补 `/btw`、skills、extensions、host-specific commands 时容易继续分裂
- 命令测试难以按同一抽象层收敛
- README、产品语义和代码容易再次漂移

### 结论

命令系统当前处于“功能已经足够用户可见，但平台抽象还没完成”的状态，应纳入第二阶段治理重点。

***

## 6.5 P1: `pi-mono` 内化策略总体正确，但缺少正式的 upstream 管理契约

### 现象

当前项目已经明确采用“内化最小内核”策略，但仓库内没有看到一个正式的 upstream management 机制，例如：

- 内化来源清单
- 文件级映射关系
- 偏离点说明
- upstream sync 策略
- 每次升级时的核查清单

### 问题

在早期这不是致命问题，但随着内化范围扩大，这会带来三个后果：

1. 以后很难明确哪些代码是“借鉴后重写”，哪些是“保留兼容语义”
2. 当上游修 bug 或演进 session / provider / auth 逻辑时，很难系统判断是否值得吸收
3. 新维护者很容易误以为当前 kernel 仍与 `pi-mono` 高度同构，导致错误判断

### 结论

当前缺的不是继续“抄更多”，而是先把已经内化的部分做成有边界意识的 fork/derivation 管理。

***

## 6.6 P1: 配置、bootstrap、provider 初始化链路偏复杂

### 现象

当前 interactive 启动链路会经历：

- settings 分层加载
- env 注入
- bootstrap defaults 解析
- `ensureAgentDirBootstrapped()`
- startup check
- runtime createAdapter
- session init auth resolution

同时，interactive 模式对 bootstrap 配置提出了更强硬的前置要求：

- API key 必须存在
- bootstrap baseUrl/api 必须存在
- provider/model 必须存在

### 问题

这条链路并非不可接受，但当前职责较为分散：

- 一部分在 `app-cli/main.ts`
- 一部分在 `bootstrap.ts`
- 一部分在 `PiMonoSessionAdapter`
- 一部分在 `kernel/ModelRegistry`

这会让“模型配置从哪里来、什么时候落盘、什么时候只是校验、什么时候才真正影响 session”变得不够直观。

### 结论

这条链可以工作，但还不够“可解释”，后续适合收敛为一个更明确的 session bootstrap contract。

***

## 6.7 P2: MCP / extensions / app-config / app-evaluation 的边界成立，但产品闭环尚未完成

### 现象

当前仓库已经预留了：

- `app-config`
- `app-extensions`
- `app-evaluation`
- MCP types / governance 相关结构

### 问题

这些边界的存在是好事，但目前仍偏骨架化，容易带来一个误判：

“仓库结构已经准备好了，因此这些能力已经是平台化的。”

实际上并不是。

尤其是 MCP，目前更多停留在类型和治理预留，并没有打通连接、发现、刷新、调用、错误恢复的主闭环。

### 结论

这些包当前应视为“未来稳定落点”，而不是“当前架构已经完成的平台层”。

***

## 7. `pi-mono` 内化专项分析

本节专门回答：当前项目内化了 `pi-mono` 的什么部分、是否修改了源码，以及这些修改是否合理。

## 7.1 当前到底内化了什么

### 7.1.1 没有内化的部分

当前项目没有内化 `pi-mono` 的整套高层产品栈，尤其没有直接引入：

- `pi-coding-agent` 的完整产品能力面
- `pi-tui`
- extensions 全栈
- tree session、branching、HTML export、settings manager 等大量高层能力

同时，最底层的 `@mariozechner/pi-agent-core` 仍然保持为外部依赖，并未 vendored。

### 7.1.2 已内化的部分

当前实际内化的是两块：

1. `packages/pi-ai`
   - 是对 `pi-mono/packages/ai` 的最小表面抽取
   - 去掉了大量 provider SDK 依赖与复杂能力，只保留统一消息、模型、流式事件、工具参数校验等基础抽象
2. `packages/kernel`
   - 相当于从 `pi-mono/packages/coding-agent/src/core/*` 中抽取出“当前主链真正需要的最小执行内核”
   - 包括：
     - session 创建
     - auth storage
     - model registry
     - provider registry / provider implementation
     - built-in tools
     - 简化版 session manager
     - 简化版 session metadata

### 7.1.3 没有被一起带下来的能力

对比 `pi-mono/packages/coding-agent/src/core/agent-session.ts` 与 `session-manager.ts`，Genesis 当前没有一起带下来的关键能力包括：

- 树形 session 管理
- branching / navigate tree
- richer compaction lifecycle
- auto retry / auto compaction
- settings manager
- prompt templates / skills / extension resources
- extension command/runtime
- bash execution persistence 全链
- session export / HTML export
- 更完整的会话内状态机和工具运行时

## 7.2 是否修改了源码

结论是：修改了，而且不是“小修小补”，而是做了明显的结构性改造。

这不是简单 vendor，而更接近：

“以 `pi-mono` 的核心思路为参考，对最小内核做了一次针对 Genesis 产品主线的重组与裁剪。”

### 主要改造点

1. 从“完整 coding-agent core”改为“最小 kernel”
   - 把高层产品能力整体剥离
   - 保留最小 session/provider/tools/auth/model 能力
2. 从“树形 session manager”改为“扁平 jsonl session file + metadata parser”
   - 大幅降低实现复杂度
   - 也同时削弱了 session domain 能力
3. 从“上游统一产品能力面”改为“Genesis runtime + adapter + host”三层分工
   - `PiMonoSessionAdapter` 成为当前 kernel 与 product runtime 的桥
4. 从“全量 provider 能力面”改为“OpenAI-compatible 主链 + Anthropic 兼容保留”
   - 更符合当前产品优先级
5. 从“上游 settings / auth / models 体系”改为“Genesis 本地 bootstrap + agentDir 模型目录”
   - 更利于项目自身控制运行条件

## 7.3 这些改动合理吗

### 合理且必要的部分

以下改造是合理且必要的：

- 不再依赖 `pi-coding-agent` 全量高层产品栈
  - 否则 Genesis 很难形成独立产品边界
- 把 provider / auth / model / tools 关键能力内收进仓库
  - 否则调试、修复、验收都会受制于外部栈
- 把 Interactive / Runtime / Kernel 明确拆层
  - 否则很快会重新回到单文件总控模式
- 对 `pi-ai` 做最小表面收缩
  - 有助于减少无关依赖和不必要的能力面

### 合理但还不完整的部分

- 把 `pi-mono` 内化为“最小 kernel”这个方向是正确的
- 但当前“最小化”主要体现在代码体积和职责裁剪上，还没有同时把“最小但完整的 session domain”做出来

换句话说：

方向是对的，最小化的刀法还不够精细。

### 不够合理的部分shu

最不合理的不是“删掉了很多能力”，而是：

删掉了 `pi-mono` 中成熟度较高的 session 领域能力之后，没有及时建立与之等价的新边界。

这导致：

- 当前 kernel 更像 provider/tools wrapper
- runtime 和 cli 被迫承担本该由 session core 持有的职责

## 7.4 专项结论

对 `pi-mono` 的内化总体结论是：

- 战略上正确
- 技术上有收益
- 产品上必要
- 架构上尚未收尾

后续不应回退到“重新依赖上游高层 coding-agent”，而应继续沿着“自有 kernel + 自有 runtime + 自有体验层”推进，但要把 session core 这一块补完整。

***

## 8. 改进方案

## 8.1 方案 A：把 `kernel` 正式拆成两层

建议在逻辑上把当前 `packages/kernel` 拆成两个子边界，即便短期不一定拆包，也至少要拆职责：

1. `kernel/session-core`
   - session file
   - transcript persistence
   - session metadata
   - resume/context rebuild
   - compaction lifecycle
   - session summary/title/preview
   - 未来 fork/branch/reopen
2. `kernel/provider-runtime`
   - model registry
   - auth storage
   - provider registry
   - stream implementation
   - built-in tools

### 收益

- 让 `session` 从“provider 附属物”恢复为一等领域对象
- 让 runtime 不再依赖隐式 session 能力
- 后续 resume/history/clear/compact 的收敛路径更明确

## 8.2 方案 B：把 recent sessions 改成 session core 的 projection

建议明确：

- `sessionFile` 及其结构化 metadata 是底层事实
- `recent.json` / `entries/*.json` 是面向产品 resume 的投影索引

因此 recent catalog 应更多做：

- 索引
- 搜索
- 浏览排序
- UI-friendly 摘要缓存

而不应承担太多事实拼接责任。

### 收益

- 减少双轨漂移
- 更容易做跨模式恢复
- 更容易给 RPC / IDE host 暴露统一 session 查询接口

## 8.3 方案 C：建立统一命令平台

建议将当前命令平台重构为一个统一模型：

- 命令定义统一注册
- 命令类型统一建模
  - `local`
  - `prompt`
  - `ui`
  - `host`
  - `extension`
- 可见性、可用性、模式适配统一处理
- `app-cli` 只负责输入派发与呈现接线
- `app-ui` 持有命令的体验语义
- `app-runtime` 持有命令可调用的稳定会话/治理能力

### 收益

- 减少命令分散定义
- 为 `/btw`、skills、extensions、IDE host 命令提供稳定扩展点
- 降低 README 与实现再次漂移的概率

## 8.4 方案 D：把 interactive orchestration 从 `app-cli` 继续向 `app-ui` 收口

建议把 interactive 进一步拆成三层：

1. `app-cli`
   - TTY host
   - input loop
   - screen flush
   - process lifecycle
2. `app-ui`
   - transcript state projection
   - permission panel model
   - resume browser model
   - footer model
   - command suggestion model
3. `app-tui-core`
   - terminal capability
   - layout/composition
   - patch encoding / diff

### 收益

- interactive 的产品语义更可测试
- 后续 IDE / web host 更容易复用 UI-level projection
- `app-cli` 体积和复杂度会明显下降

## 8.5 方案 E：正式建立 `pi-mono` 内化管理机制

建议新增一份内部治理文档或 manifest，至少包含：

- 当前内化来源列表
- 对应 Genesis 包/文件映射
- 相对 upstream 的保留点
- 相对 upstream 的删除点
- 已知偏离点
- 是否计划继续同步
- 升级核查清单

### 收益

- 避免上游与本仓库关系继续口头化
- 降低未来同步和审计成本
- 帮助维护者理解哪些行为是“有意偏离”，哪些是“尚未补齐”

## 8.6 方案 F：把 bootstrap/config/session-init 收敛成单一契约

建议新增一个清晰的 `SessionBootstrapContract` 概念，统一回答：

- 模型从哪里选定
- provider 配置何时落盘
- auth 何时校验
- agentDir 与 historyDir 的职责是什么
- startup check 和 session init 的边界在哪里

### 收益

- 配置行为更可解释
- interactive / print / json / rpc 更容易共享一套启动语义
- 测试覆盖更容易按契约组织

***

## 9. 优先级排序（Check-list）

### 9.1 P0

- [x] P0-1：补齐 `kernel session core`
  原因：是当前最深层的边界缺口；所有 `resume` / `compact` / `clear` / `history` 问题最终都会回到这里。
  进行中说明：上层 interactive 命令与 resume 展示逻辑已持续从 `app-cli` 向 `app-ui`/`runtime` 收口，但 kernel 侧统一 session core 还未真正补齐。
  已完成子项：
  - [x] P0-1.a：`SessionFacade` recovery snapshot / close event 输出更完整的 session-facing recovery 契约
  - [x] P0-1.b：`create-app-runtime` 侧减少对 `SessionFacade` recovery snapshot 的重复 canonicalize
  - [x] P0-1.c：`recoverSession` 优先继承 `recoveryData.workingDirectory` 作为会话上下文事实源
  - [x] P0-1.d：`SessionFacade` recovery snapshot 统一吸收内存态 plan/compaction 摘要，收紧 transcript/recovery 契约
  - [x] P0-1.e：compaction / summary / working directory 等会话域事实在 recovery 契约中进一步内聚
- [x] P0-2：统一会话事实来源与 recent catalog 投影关系
  原因：当前 `resume` 体验和跨模式一致性都依赖这一层稳定。
  进行中说明：recent catalog / session metadata / rich recovery 的一致性护栏已补强，但“单一事实源 + 稳定投影”还未彻底收口。
  已完成子项：
  - [x] P0-2.a：recent-session metadata 缺失时可从 `sessionFile` 回填并刷新缓存
  - [x] P0-2.b：`listRecentSessions()` 优先以 `entries/<sessionId>.json` 作为 `recoveryData` 事实源，`recent.json` 仅作投影
  - [x] P0-2.c：`pruneRecentSessions()` 重写 `recent.json` / `last.json` 时优先吸收 entry facts
  - [x] P0-2.d：`recoverSession` 后续输入写入 recent catalog 时保持 recovered 事实（sessionId/workingDirectory/toolSet）一致
  - [x] P0-2.e：recent catalog 读取/剪枝阶段对重复 session 投影去重，保持单一会话事实视图
- [x] P0-3：建立 session / rich recovery 的架构验收测试
  原因：没有稳定自动化护栏，后续边界收口会频繁回归。
  进行中说明：TTY、resume、recent-session、interactive 命令链路的回归测试已大幅补齐，但还未形成完整的架构验收层。
  已完成子项：
  - [x] P0-3.a：补齐 `session_closed -> recordClosedRecentSession -> recent catalog` 的跨层验收护栏测试
  - [x] P0-3.b：补齐 `compaction event + session close + recent search` 组合场景验收护栏
  - [x] P0-3.c：补齐 `recoverSession + compaction + session close + recent search` 组合场景验收护栏
  - [x] P0-3.d：补齐 `resume browser list/search + recovery snapshot transition` 端到端验收护栏
  - [x] P0-3.e：补齐 `clear/new session transition + recent-session catalog` 端到端验收护栏
  - [x] P0-3.f：补齐 interactive `/clear` 与 runtime recent-session 记录协作的端到端验收护栏
  - [x] P0-3.g：补齐 interactive `/resume`（browser submit）与 runtime recent-session 记录协作的端到端验收护栏
  - [x] P0-3.h：补齐 interactive `/compact` 与 recent-session summary 更新协作的端到端验收护栏
  - [x] P0-3.i：补齐 interactive `/model` 切换与 recent-session 持久化协作的端到端验收护栏
  - [x] P0-3.j：补齐 interactive `/doctor` 与 runtime recent-session 持久化协作边界验收护栏
  - [x] P0-3.k：补齐 interactive `/usage` 与 recent-session 持久化协作边界验收护栏
  - [x] P0-3.l：补齐 interactive `/config` 与 recent-session 持久化协作边界验收护栏
  - [x] P0-3.m：补齐 interactive `/status` 与 recent-session 持久化协作边界验收护栏

### 9.2 P1

- [ ] P1-1：统一命令平台
  进行中说明：interactive 本地命令已大规模迁入 `app-ui` 命令工厂，但跨模式统一命令平台仍未完成。
- [ ] P1-2：把 interactive 体验语义继续从 `app-cli` 回收到 `app-ui`
  进行中说明：`/title`、`/help`、`/exit`、`/quit`、`/clear`、`/status`、`/usage`、`/config`、`/changes`、`/review`、`/diff`、`/doctor` 已外提，`/resume` 的展示与选择逻辑也在继续下沉；剩余是宿主专属生命周期控制。
  已完成子项：
  - [x] P1-2.a：interactive 本地命令工厂迁到 `app-ui`
  - [x] P1-2.b：`/resume` restored-context 预览渲染迁到 `app-ui`
  - [x] P1-2.c：`/resume` direct-selection 解析迁到 `app-ui`
  - [x] P1-2.d：`/resume` browser 选中索引恢复与调试摘要 helper 迁到 `app-ui`
  - [x] P1-2.e：`/resume` browser 打开/搜索/预览切换状态变换迁到 `app-ui`
  - [x] P1-2.f：`/resume` submit 命中解析与恢复后提示文案迁到 `app-ui`
  未完成子项：
  - [ ] P1-2.g：`/resume` 宿主专属控制流进一步收口
  - [ ] P1-2.h：其余 interactive 宿主专属能力与统一平台边界继续清理
- [ ] P1-3：整理 bootstrap / config / session-init 契约
  进行中说明：相关配置与模型信息展示已部分收口，但 bootstrap / session-init 契约层还未系统整理。
- [x] P1-4：建立 `pi-mono` 内化清单与 sync 策略
  完成说明：已建立并开始持续维护 `pi-mono` 内化清单与 sync 策略，后续重构以此为稳定约束。

### 9.3 P2

- [ ] P2-1：MCP 真正主链化
- [ ] P2-2：extensions / skills / subagent 产品化
- [ ] P2-3：IDE host / RPC host 的更强产品能力

***

## 10. 实施路径

## 阶段 0：冻结事实边界

目标：

- 先把现状事实讲清楚，避免边改边漂

动作：

- 产出 session 领域模型说明
- 产出 `pi-mono` 内化清单
- 产出 current command matrix
- 产出 resume/history 数据流图

验收：

- 文档、README、代码口径一致

## 阶段 1：收口 session core

目标：

- 把会话真相从 runtime/cli 回收到 kernel

动作：

- 引入更完整的 session metadata 结构
- 明确 compaction entry / session summary / title / preview
- 统一 `loadSessionMetadata` 和 runtime recent metadata 语义
- 给 resume/recover 提供稳定 contract

验收：

- `/resume` 不再依赖多处拼接事实
- `compact`、`clear`、恢复预览的关键信息来自同一事实源

## 阶段 2：收口命令与 interactive orchestration

目标：

- 降低 `app-cli` 的产品语义负担

动作：

- 统一命令注册中心
- 将 interactive projection state 迁入 `app-ui`
- `app-cli` 只保留 TTY host 和 mode lifecycle

验收：

- interactive 命令语义不再分散定义
- 同一命令模型可服务 interactive 与非 interactive 模式

## 阶段 3：稳定 bootstrap 与模式共享契约

目标：

- 让 startup / config / model / auth 更可解释

动作：

- 引入 bootstrap contract
- 合并 startup check / session init 部分重复逻辑
- 用契约测试验证 interactive / print / json / rpc 一致性

验收：

- 配置优先级、落盘时机、校验时机清晰且可测

## 阶段 4：在稳定主线之上推进 MCP / extension / subagent

目标：

- 把扩展建立在稳定主链上，而不是建立在补丁层上

动作：

- 打通 MCP 的连接、发现、刷新、调用、错误恢复闭环
- 统一 extension / skill / command / subagent 的入口策略

验收：

- 新能力接入不再要求同时修改多个底层边界

***

## 11. 风险提示

## 11.1 最大风险不是“改不动”，而是“边界不稳就继续扩功能”

如果在当前阶段继续优先做：

- 更复杂的 panel
- 更大的 MCP 面
- 更多新命令
- 更重的 extension 产品层

那么未来重构成本会显著上升，因为这些能力都会继续依赖当前分散的 session/command/orchestration 事实。

## 11.2 另一个风险是“为了最小化而过度最小化”

当前项目已经证明“从 `pi-mono` 内化最小 kernel”是有价值的，但下一步必须避免继续把成熟领域能力削掉而不补回。

真正的目标不是代码更少，而是：

在足够少的代码里保留足够完整的领域边界。

***

## 12. 结论

当前 `Genesis CLI` 的架构方向是成立的，且战略路线明显优于“继续绑定上游高层产品栈”或“把所有能力都堆回 CLI 入口”。

最重要的判断有三条：

1. 当前主问题不在体验表层，而在会话领域边界仍未完成收口。
2. 对 `pi-mono` 的内化总体合理，但 `session core` 被削薄过头，是当前最该补的架构债。
3. 后续技术决策应严格遵循：
   - 先 session core
   - 再 command/runtime/ui 边界
   - 最后再扩大 MCP / extensions / subagent 产品面

如果按这个顺序推进，当前仓库完全有机会从“方向正确、边界尚未稳定”升级为“真正可持续演进的自有 coding CLI 平台”。

***

## 13. 建议立即启动的工作项

建议立即立项以下 5 个 workstream：

1. `session-core-gap-audit`
   - 对照当前 kernel、runtime、cli，列出所有 session-facing 职责归属现状与目标归属
2. `recent-session-source-of-truth`
   - 明确 sessionFile 与 recent catalog 的事实源/投影关系，并做 schema 收敛方案
3. `command-platform-unification`
   - 梳理现有命令来源、类型、可见性、执行模型与 mode 依赖
4. `interactive-projection-extraction`
   - 将 `mode-dispatch` 中的产品投影状态提炼到 `app-ui`
5. `pi-mono-vendor-manifest`
   - 建立上游映射与偏离说明，形成可维护的内化治理机制
