# Node Plugin × Canvas × Agent Context Contract

本文是 Canvas 节点交互、社区插件与 Agent 上下文之间的规范性契约。它回答同一个问题：
**用户在画布上看到某个节点是任务输入时，核心如何保证 Agent 实际收到同一输入。**

本文中的“必须 / 不得”是实现与社区插件的兼容性要求。完整实体与命令模型见
[`CANVAS.md`](./CANVAS.md)，最小信任边界见
[`INTERACTION-KERNEL.md`](./INTERACTION-KERNEL.md)。

## 1. 唯一事实源

1. **Task 是唯一运行边界。** Agent 执行 Task，不执行 Node 或插件组件。
2. **持久 Canvas revision 是唯一输入事实源。** daemon 不接受浏览器上传的 Canvas snapshot、
   Node 内容或文件路径。
3. **typed Edge 是唯一关系事实源。** UI 来源标签、Task 输入预览与上下文编译不得各自维护
   一套不相容的来源规则。
4. **artifact manifest 是文件权限事实源。** 插件 payload、标题、URL 或路径字符串不能授予
   Agent 文件访问权。
5. **插件 ID 不改变核心语义。** 核心不得按 `image`、`text` 或任意社区插件 ID 分支处理连接、
   Task、上下文权限、artifact 验证或布局。

## 2. 人机交互到 Agent 上下文

| 用户操作 | 持久 Canvas 变换 | Agent 可见性 |
| --- | --- | --- |
| `Node A → Task T` | `source/full` | A 的有界内容；artifact 经 daemon 验证后作为只读文件 |
| `Task A → Task T` | `depends-on/summary` | A 的标题与目标摘要，不自动授予产物文件 |
| 普通连接指向 Node | `references/none` | 纯视觉关系，不进入 Run |
| 从 Node A 端口直接创建空 Node B | `A → B source/full` | 尚未运行；该边是 B 升级为输出槽时的待提升内容关系 |
| 在空 Node B 上创建 Task T | B 归属 T，并把 B 的有效入边原子提升为 `source → T` | 提升后的 Task 输入进入 Run |
| 在有内容 Node A 上提交目标 | 创建新 Task T 与 `A → T modified/full` | A 进入新 Task；原 Node 不被覆盖 |
| 从资源库选择生成内容作为附件 | 不改写 Canvas；RunIntent 只保存 `runId + artifactId` | daemon 按 closed manifest 复验后作为只读文件 |
| `contextRole=summary` | 保留标题、类型或目标摘要 | 不授予 Node artifact 文件 |
| `contextRole=none` | 保留视觉/血缘关系 | 永不进入 Agent 上下文，也不在输出槽升级时提升 |

“空 Node 升级为输出槽”是一个核心原子变换，不是 UI 拼接动作：

```text
变换前                              变换后

Source ──full──> Empty Node         Source ──full──> Task
                         + Run  =>                      │
                                                      ▼
                                                  Output Node
```

原 Node 入边可以继续作为内容血缘显示；新增的 Task 入边负责运行授权。相同来源的多条有效入边
只提升一次，`full` 优先于 `summary`。`none` 边不提升；一次输出槽升级最多继承 500 个唯一
来源，超限时整个 command 原子失败。

## 3. UI 与运行时一致性

- 来源标签只能展示 `full` 或 `summary` 的有效输入关系。
- UI 展示为本次来源的节点，在 Task 创建后必须出现在 `compileTaskContext().inputs` 中。
- `full` Node 的 artifact identity 必须出现在 `taskContextArtifactRefs()` 的结果中，并由 daemon
  通过 closed manifest 解析；解析失败时 Run 在启动前失败，不能静默降级成“无图片”。
- `summary` 与 `none` 不得出现在 verified artifact attachment 中。
- UI 不得因为插件 renderer 显示了缩略图，就推断 Agent 已获得图片 bytes。
- 调试与验收以每个 Run 的 `.gg/context/runs/<runId>/pack.json` 为最终证据。

## 4. 核心与插件的权限边界

核心平台统一负责：

- Task/Run 生命周期、typed Edge 和上述原子图变换；
- contextRole 的含义、上下文裁剪和 Task context 编译；
- artifact identity、manifest、只读路径、size 与 digest 验证；
- output slot 采用、ProjectionPlan、Node/Edge/receipt 物化；
- 缺失、禁用或未知插件时仍保持安全的 Canvas 与 artifact 引用。

节点插件只负责：

- `initialPayloadSchema`、data-only `initialPayload` 与严格 `ui` 模板；空内容判定、生成动画与内容渲染由 Canvas 统一提供；
- 指令占位、快捷动作和纯 UI 标记；
- data-only `artifactClaims`；
- data-only `nodeContext`：分别声明 `summary/full` 可见的正文上限、payload 顶层字段白名单，
  以及 `full` 是否携带 artifact identity；
- `artifactClaims` 命中后由平台用同一 `ui` 模板展示 daemon 已验证的 artifact。

节点插件不得：

- 创建或改写 Task、Run、Edge、Canvas entity ID、坐标或 command；
- 自己解释 `full / summary / none`，或扩大其文件权限；
- 把 payload 中的路径、URL、base64 字符串当作 verified artifact；
- 让 renderer、`isEmpty` 或快捷动作决定 daemon 的上下文授权；
- 覆盖内置 artifact claim、声明 unknown fallback 或依赖某个 Agent transport。

## 5. 内容与空白状态

Canvas 持久模型还没有独立、可跨浏览器/daemon 验证的 `contentState`。当前输出槽资格由
核心保守判定：user-origin、未归属 Task、没有 artifact、没有非空文本，且 payload 为空。
节点内容可见性由平台统一依据 text、payload 与 artifactRefs 判定，类型定义不能注入函数改变输出槽资格。

因此在引入版本化的 data-only content-state 契约之前：

- 希望支持“创建空节点后直接运行”的社区节点类型，应让 `initialPayload` 使用 `{}`；
- 参数默认值应放在 UI 默认值中，在用户确认后再写入 payload；
- payload-only 内容不得被核心静默当作空白并覆盖；
- 后续 content-state 协议必须同时被浏览器、共享 reducer 与 daemon 验证，不能只增加
  任意浏览器回调函数。

这项限制是显式兼容边界，不允许用具体 plugin ID 特判绕过。

## 6. 社区插件兼容性门禁

每个内置和社区插件必须通过同一组与 ID 无关的场景：

1. 插件 Node 作为 `full` Task 直接输入；
2. 插件 Node 连接空目标 Node，目标升级为输出槽后仍成为 Task 输入；
3. copied Node 的 artifact identity 在派生 Task 中仍由 manifest 验证；
4. `full / summary / none` 分别产生完整、摘要和零上下文；
5. 多输入去重与 `full > summary` 优先级稳定；
6. 插件禁用或缺失后，Canvas 仍可打开，artifact 引用不丢失；
7. UI 来源列表与 `pack.json.inputs` 一致；
8. 任何 payload 路径都不能绕过 manifest 获得文件访问权。

测试必须覆盖完整链路，而非只测试组件或编译器的一端：

```text
gesture / selection
→ Canvas command
→ persisted revision
→ context compiler
→ verified artifact attachment
→ pack.json
```

## 7. 演进规则

- 新插件能力优先使用可序列化、可版本化、可由 daemon 复验的数据契约。
- React 函数、闭包与 renderer 不能成为持久语义或安全边界。
- 新 Edge relation 不得隐式获得 Agent 权限；权限仍由显式 `contextRole` 决定。
- 修改输出槽、来源或上下文规则时，必须同时更新本文、`INTERACTION-KERNEL.md`、核心 reducer、
  context compiler 和跨层回归测试。
- 若 UI 无法证明来源会进入最终上下文，应在 Run 前明确提示，而不是静默提交。

## 8. 节点上下文投影

`NodeTypeDefinition.nodeContext` 是严格的纯数据契约，不是 renderer hook。当前结构为：

```ts
interface NodeContextPolicy {
  schemaVersion: 1
  summary: {
    textMaxChars: number
    payloadFields: string[]
  }
  full: {
    textMaxChars: number
    payloadFields: 'all' | string[]
    artifactRefs: 'all' | 'none'
  }
}
```

执行规则：

1. `contextRole` 永远是权限上限：`summary` 不携带 artifact，`none` 永不进入上下文；插件不能扩大它。
2. payload 只允许顶层 JSON 字段白名单；不得声明路径读取、函数、模板代码或任意 projector。
3. 插件能力在 Run 接受前由 daemon 规范化、固定 digest，并和 artifact claims 一起写入
   `plugin-capabilities.json`。运行中的热更新不能改变已接受 Run。
4. `pack.json` 的每个 typed-edge Node 输入和显式 Node attachment 都保存 `contextProjection`，
   记录正文裁剪、payload 字段选择、artifact 因策略或预算被省略的数量。该 receipt 是调试
   “用户看见什么 / Agent 收到什么”的证据。
5. 旧能力快照没有 `nodeContext` 时使用只读兼容策略：`summary` 维持标题/类型，`full` 维持旧的
   完整正文、payload 与 artifact 行为。新建快照必须写当前策略。
6. 内置策略由 daemon 拥有，community 注册不能覆盖；community 与节点工作台生成的节点可声明
   更窄策略，但不能接管 unknown artifact 或获得 Canvas command 权限。
7. 目标 Task 的 output slots 只把 `id/title/type/contentState` 写入 pack；`type` 约束目标
   `pluginId`，但 frame、renderer、选择态、日志和运行态永不作为 Agent 上下文。
