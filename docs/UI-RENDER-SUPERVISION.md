# UI Render Supervision

GGAI 的 Canvas UI 状态多、交互复杂。组件测试负责行为，但仅靠 jsdom 不能证明最终排版没有跑偏；
仅靠人工或 Agent 临时点击，又无法稳定复现同一个界面。因此仓库提供一套独立于产品路由的真实
浏览器渲染面。

## 原则

- 场景必须直接复用 `src/` 中的生产组件，不复制一套展示版 UI；
- 场景状态由确定性 fixture 注入，不依赖登录、外部 Agent、随机 Run 或人工点击；
- 截图使用固定 Chromium 版本、viewport、字体等待与 ready 标记；
- 渲染面不进入正式产品导航，不改变用户 UI；
- 每个涉及视觉状态的 PR 必须增加或更新对应场景；
- 行为测试仍是合并门禁，截图用于布局、层次和文案的人工监督，二者不能互相替代。

## 本地使用

安装正常依赖后，首次安装固定 Chromium：

```bash
npx --yes playwright@1.55.0 install chromium
```

生成全部场景：

```bash
npm run ui:render:capture
```

产物位于 `artifacts/ui-render/`：每个场景一张 PNG，并附带可直接打开的 `index.html` 画廊与
`manifest.json`。只捕获单个场景：

```bash
npm run ui:render:capture -- --scenario task-run-draft
```

也可以直接启动渲染面进行实时调试：

```bash
npm run ui:render:serve
```

随后打开：

```text
http://127.0.0.1:4173/ui-render/index.html?scenario=task-run-draft
```

## CI 与 PR 审查

`.github/workflows/ui-render-supervision.yml` 会在 UI、场景或捕获脚本变化时运行，上传
`ui-render-*` artifact，并在 PR 中维护一个固定评论指向最新 workflow run。下载 artifact 后打开
`index.html` 即可逐图审查，不需要先启动 daemon 或执行点击脚本。

## 新增场景

1. 在 `src/ui-render/scenarios.tsx` 中组合真实生产组件与确定性依赖；
2. 在 `ui-render/scenarios.json` 中登记相同 ID、标题与 viewport；
3. 确保场景在字体与异步状态稳定后设置 `html[data-ui-render-ready='true']`；
4. 同时补充组件行为测试，避免把截图误当作功能断言。

截图不得展示 provider、digest、文件路径或其他本不应进入产品 UI 的基础设施信息。
