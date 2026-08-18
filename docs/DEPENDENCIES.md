# 依赖管理

本项目是私有应用，当前直接依赖以精确版本保存，完整依赖树由 `package-lock.json` v3 锁定。快速开发阶段允许版本范围、私有或替代 registry、带生命周期脚本的新依赖；开发使用 `npm install`，CI 和发布验证使用普通 `npm ci`。

## 工具链

- 运行基线：Node.js 24.19.0、npm 10.9.8（见 `.nvmrc` 与 `packageManager`）。
- 支持范围：Node.js 24.19+ 且低于 25；npm 10.9+ 或 npm 11。Node 22 不再是受支持运行时。
- daemon 使用 Node 24 内置的 `node:sqlite`，并在启动时要求 linked SQLite 3.51.3 或更新版本。
- 项目级 `.npmrc` 显式关闭 `engine-strict` 与 `ignore-scripts`，让生命周期脚本正常执行，并让新依赖默认保存精确版本。registry 使用 npm/用户当前配置，工具链版本不匹配只提示警告。

首次安装：

```bash
nvm use
npm ci
npm run deps:doctor
```

## 依赖边界

- `dependencies`：浏览器生产代码和 daemon 运行时直接加载的包。`chokidar` 属于 daemon 运行时依赖；`node:sqlite` 是 Node 24 内置模块，不进入 npm manifest。
- `devDependencies`：TypeScript、Vite、Tailwind、ESLint 和类型声明，只参与开发与构建。
- Codex 与 acpx 是用户级 CLI，不写入项目依赖，开发启动器也不会安装或复制它们。默认生产路径要求已有并已认证的 Codex；acpx 即使已安装也必须通过 `--acpx-agent` / `GGAI_ACPX_AGENTS` 显式启用。
- acpx 官方建议全局安装以保留跨调用会话：`npm install --global acpx`。不使用临时 `npx acpx` 启动生产会话。
- acpx 当前公开 CLI 不能按 request id 撤销跨进程 queue 中的 pending 请求，因此只作为实验性 opt-in；不得从外部程序复用 GGAI 命名会话，非正常 daemon 退出后必须先清理遗留 owner。
- 系统服务或 Electron 应通过 `--codex-command` / `--acpx-command` 或 `GGAI_CODEX_COMMAND` / `GGAI_ACPX_COMMAND` 固定绝对路径。`GET /agents` 暴露解析后的 `binaryPath`；能力探针会验证当前 transport 依赖的 flags、所选 approval 模式、acpx adapter、named-session 创建、prompt 和 session cancel 能力。
- `@agentclientprotocol/sdk` 尚未被当前代码加载；ACP SDK 阶段落地前不提前加入依赖。

## 日常命令

```bash
npm run dev            # 一条命令启动 Vite + daemon
npm run deps:check     # manifest/lock 一致性 + registry、integrity、许可证和脚本信息报告
npm run deps:doctor    # Node/npm、依赖树和外部 Agent CLI
npm run deps:audit     # 手动严格漏洞审计；CI 中仅报告、不阻断
npm run deps:outdated  # 只读查看可更新版本；有更新时 npm 会返回非零状态
npm run deps:sbom      # 从 lockfile 输出 CycloneDX SBOM JSON
npm run test:ui        # Vitest + jsdom 的 React StrictMode 画布回归测试
npm test               # 启动器、daemon 与 UI 的全部测试
npm run verify         # 依赖策略 + 完整 lint + 全部测试 + 生产构建
npm run package:daemon:verify # 生成并干净安装最小 daemon 运行包
```

## 增删与升级流程

1. 运行 `npm install --save <pkg>` 或 `npm install --save-dev <pkg>`，不要手改 lockfile；依赖生命周期脚本会正常执行。
2. 新运行时包必须能在源码中找到直接 import；构建、测试工具必须放在 `devDependencies`。
3. 检查新增包的维护状态、许可证、install script、传递依赖和安全公告。
4. 单独处理主版本升级；普通 PR 只合并同一依赖族的 minor/patch 更新。
5. 依次运行 `npm run deps:audit` 和 `npm run verify`，提交 manifest 与 lockfile。

项目不再维护 install script、许可证或 registry 白名单，也不阻止版本范围和缺少 registry integrity 元数据的锁定来源。`npm install` 与 CI 的 `npm ci` 都按 npm 默认行为执行生命周期脚本；`deps:check` 只把相关信息列出来，不作为开发门禁。manifest 与 lockfile 不一致仍会失败，因为 `npm ci` 本身无法在这种状态下复现安装。

`npm run daemon` 是开发入口，会先编译 TypeScript；`npm run daemon:start` 只启动已经生成的 `dist-daemon`。生产交付使用 `npm run package:daemon`：它排除测试与 source map，并从根 lockfile 确定性裁剪出独立的 runtime manifest/lockfile，不访问 registry 重新解析版本。npm 闭包只有 `chokidar` 与 `readdirp`，SQLite 由 Node 24 提供；runtime 允许正常执行依赖脚本，不会携带 React、Vite 或 TypeScript。

仓库根目录的 Dependabot 每周生成 npm 与 GitHub Actions 更新 PR；npm minor/patch 会分生产与开发两组，主版本保持独立 PR 以便单独迁移和回归验证。CI 自身的 Actions 依赖固定到完整 commit SHA。
