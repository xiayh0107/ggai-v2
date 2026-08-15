# 节点创作工作台

节点工作台把节点插件规范变成可操作、可预览、可校验的产品能力。它创建跨项目复用的
节点类型定义；Canvas 里的 Node 仍只是某个类型的实例。

## 第一阶段边界

工作台保存的是严格 JSON 清单，不执行动态代码。清单只允许：身份、受限内容模板、默认
宽度、空态文案、示例内容、提示词占位与快捷指令。节点外壳、Task、Run、Edge、文件权限、
连接端口和命令通道始终由平台控制。

定义由 daemon 持久化在 `.gg/workspace/node-definitions.json`。每次保存追加一个不可变
revision；Canvas Node 使用 `@local/package@revision` 作为运行时类型，避免新版本改变历史
节点。已安装版本不能物理删除。

Studio 的预览直接使用真实 `CanvasNodeCard`；普通内容通过 `NodePlugin.ui` 选择平台白名单
模板，由 `NodeTemplateView` 统一渲染。定义不能携带 React 组件、CSS class、节点外壳、空态或
运行态。端口、选择、生成动画、活动条与 Composer 始终由 Canvas 平台负责，因此预览与真实
画布不会再维护两套视觉实现。

## Agent 边界

“快速起稿”是不执行代码的本地结构草拟；“让 Agent 设计”通过受限的 Node Studio Run 生成
候选 `node-definition.json` artifact。该 Run 复用 daemon 的隔离 artifact 目录、日志、会话与
取消能力，但不是 Canvas entity，因此不能产生 Canvas command。候选会被 exact-schema
validator、闭合 artifact manifest 与内容摘要重新校验，revision / installed / updatedAt 由
daemon 填充。Agent 结果先进入独立候选区，不覆盖当前草稿；只有用户点击“应用候选”后才进入
编辑器。只有用户点击保存或安装时，daemon 才写入定义目录；只有安装版本会注册进画布创建
菜单。Agent 无权直接修改目录、注册表或 Canvas。

## 后续阶段

1. 项目绑定的 Agent 共创、版本差异、接受/撤销变更。
2. `artifactClaims` 与平台拥有的有限 Artifact template，支持 Agent 产物直接落成自定义节点；普通内容
   仍只使用平台模板，不开放 Agent 生成 JSX / CSS。
3. JSON 包导入、签名包导出与社区发布、审核。
4. 如确需代码型节点，使用独立构建进程与 sandbox iframe/worker；不得在主应用中动态 import。
