# UI 回归截图

这里保存高风险 UI 回归的关键审查画面。截图用于代码评审和人工比对，不能替代行为测试；
每组截图都必须能指向相邻的自动化回归。

## Canvas IndexedDB 滚动兼容

- [修复前：浏览器数据库版本冲突导致整页加载失败](./canvas-indexeddb-version-before.png)
- [修复后：同一浏览器配置可直接进入空画布](./canvas-indexeddb-version-after.png)
- 自动化覆盖：
  - `src/canvas/persistence.test.ts` 验证打开更高版本数据库时不请求降级，并验证首次初始化的 store。
  - `src/components/canvas/CanvasShell.test.ts` 验证加载失败、错误提示、点击重试和恢复画布的完整 UI 状态流。

截图日期：2026-08-11。

## Canvas 统一提示词控件

- [节点派生任务的草稿态](./canvas-shared-prompt-control-draft.png)
- 自动化覆盖：
  - `src/components/canvas/CanvasTaskRunPanel.test.tsx` 验证同一 prompt control、输入 surface、footer、textarea 与主按钮从 draft 原位切换到 running，再从取消终态原位恢复。
  - `src/components/canvas/CanvasContextComposer.test.tsx` 验证节点派生与空画布创建使用同一个 `CanvasPromptControl` 外壳。
- 运行态不再拥有“正在生成”独立卡片；状态只替换同一控件的 detail、只读输入和主按钮。

截图日期：2026-08-11。

## Canvas 组合节点共享外壳

- [多选成员形成标准组合节点](./canvas-compound-node-shared-shell.png)
- 自动化覆盖：
  - `src/components/canvas/CanvasStage.test.tsx` 验证组合节点复用 `CanvasNodeShell`、
    `rounded-[16px]`、标准 header / 四边端口与纯图标 Node 工具条。
  - `src/components/canvas/CanvasContextComposer.test.tsx` 验证组合节点复用普通 Node 的
    固定宽度提示词控件，不再按选区宽度生成 680px 专属面板。
- 临时组合只改变 Node 的成员语义；只有用户显式保存后才成为 Collection。

截图日期：2026-08-11。

## Canvas Shift 多选不误选文字

- [Shift 选择两个节点后只形成组合节点，不产生原生文字高亮](./canvas-shift-multiselect-no-text-selection-after.png)
- 自动化覆盖：
  - `src/canvas/interaction.test.ts` 验证画布加选手势同时阻止默认文本扩选并清空临时 Selection。
  - `src/components/canvas/CanvasStage.test.tsx` 验证普通点击不受影响，Shift 点击与 Shift 框选均抑制原生文字选择且保留类型化多选。
- 该规则只作用于画布加选手势；节点正文、日志和输入区仍可正常拖选与复制。

截图日期：2026-08-11。

## Canvas 组合节点拖线创建

- [从组合节点端口拖到空白处后打开节点类型菜单](./canvas-compound-port-create-menu-after.png)
- 自动化覆盖：
  - `src/components/canvas/CanvasStage.test.tsx` 验证组合端口拖线到空白处会在释放点打开菜单。
  - 选择类型后创建一个新节点，并从组合中的每个成员分别建立来源连接。
- 轻点组合端口仍保留待连接状态；只有拖到空白并释放才进入创建流程。

截图日期：2026-08-13。

## 更新规则

1. 只保存能解释产品回归或关键状态转换的截图，不收集普通开发过程图。
2. 文件名使用 `功能-场景-before|after.png`，同组截图必须成对。
3. 更新截图时同步更新或新增行为测试，并在本文件写明覆盖位置。
4. 截图不得包含凭据、本机绝对路径、内部日志或用户隐私数据。
