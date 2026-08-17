# 本地 UI 状态实验室与渲染监督

GGAI 的 Canvas UI 状态多、交互复杂。组件测试负责行为，但仅靠 jsdom 不能证明最终排版没有跑偏；
仅靠人工或 Agent 临时点击，又无法稳定复现同一个界面。因此仓库提供一套独立于产品路由的真实
浏览器渲染面。它不是线上 UI 的截图替代品，而是开发过程中持续可用的本地状态事实源：
同一条用户旅程里的空节点、生成中、完成、失败与侧栏披露必须能被并排追踪。

## 原则

- 场景必须直接复用 `src/` 中的生产组件，不复制一套展示版 UI；
- 场景状态由确定性 fixture 注入，不依赖登录、外部 Agent、随机 Run 或人工点击；
- 截图使用固定 Chromium 版本、viewport、字体等待与 ready 标记；
- 渲染面不进入正式产品导航，不改变用户 UI；
- 每个涉及视觉状态的 PR 必须增加或更新对应场景；
- 每个场景必须声明生命周期、视觉选择、控制归属与披露层级；
- 场景必须同时包含人工查验重点和可执行 DOM / 文案契约；
- 行为测试仍是合并门禁，截图用于布局、层次和文案的人工监督，二者不能互相替代。

## 本地状态实验室

启动实时渲染面：

```bash
npm run ui:render:serve
```

打开 `http://127.0.0.1:4173/ui-render/index.html`。默认页面按用户旅程组织所有状态，包含：

- 精确 viewport 中运行的真实生产组件；
- 空节点 → 生成中 → 完成 / 失败的有序状态轨迹；
- 当前状态的控制 owner 和披露层级；
- 设计原则、人工查验重点与自动契约数量；
- 独立打开单个精确画布的入口。

渲染面由 Vite HMR 驱动，修改组件后无需等待远程 CI。它不进入产品导航，也不连接 daemon、
登录态或真实 Agent。

## 本地使用

安装正常依赖后，首次安装仓库锁定版本的 Chromium：

```bash
npx playwright install chromium
```

最快的自动反馈只运行场景 ready 条件与设计契约，不写 PNG：

```bash
npm run ui:render:check
```

生成全部场景：

```bash
npm run ui:render:capture
```

产物位于 `artifacts/ui-render/`：每个场景一张 PNG，并附带可直接打开的 `index.html` 画廊与
`manifest.json`。报告按旅程排列，并记录源码 commit、dirty 状态、每项契约结果与图片摘要。
只捕获单个场景：

```bash
npm run ui:render:capture -- --scenario task-run-draft
```

需要保留一份不会被下一次默认捕获覆盖的开发记录时：

```bash
npm run ui:render:record
```

记录写入 `artifacts/ui-render-runs/<time>-<commit>/`。可以把任意记录作为视觉基线：

```bash
npm run ui:render:capture -- \
  --baseline artifacts/ui-render-runs/<baseline> \
  --fail-on-change
```

不带 `--fail-on-change` 时仍会在报告中标出变化，但不会阻止有意的 UI 演进。

## CI 与 PR 审查

`.github/workflows/ui-render-supervision.yml` 是本地门禁的远程复验，不是唯一反馈入口。它会在
UI、场景或捕获脚本变化时运行，上传
`ui-render-*` artifact，并在 PR 中维护一个固定评论指向最新 workflow run。下载 artifact 后打开
`index.html` 即可逐图审查，不需要先启动 daemon 或执行点击脚本。

## 新增场景

1. 在 `src/ui-render/scenarios.tsx` 中组合真实生产组件与确定性依赖；
2. 在 `ui-render/scenarios.json` 中登记相同 ID、旅程 step、状态归属、viewport 和 ready selector；
3. 写出至少一项人工 checkpoint 和一项可执行 check；
4. 确保场景的 `data-ui-render-settled='true'` 只在目标状态真正落定后出现；
5. 同时补充组件行为测试，避免把截图误当作功能断言；
6. 运行 `npm run ui:render:check`，再打开本地状态实验室检查整条旅程。

自动契约支持：精确 selector 数量、selector 可见、文案存在与文案不存在。它们适合守住
“只有一个节点外壳”“生成期间不开放节点操作”“详情必须进入右侧抽屉”“不泄漏 digest”等
明确边界；布局权重、留白与视觉节奏仍由人工查验。

截图不得展示 provider、digest、文件路径或其他本不应进入产品 UI 的基础设施信息。
