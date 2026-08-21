# GGAI

生成式图形画布：React/Vite 前端负责节点、连线与预览；本地 Node daemon 负责把画布上下文交给已登录的 Agent CLI，并通过 SSE 把过程与产物事件送回 UI。

## 本地运行

要求 Node.js 24.19+（低于 25）与 npm 10.9+。版本不符合 `package.json` 的范围时开发安装会提示警告，daemon 启动时还会验证内置 SQLite 版本。先安装锁定依赖：

```bash
npm ci
npm run deps:doctor
```

日常开发只需一个终端：

```bash
npm run dev
```

这会同时启动 `127.0.0.1:7380` 的 daemon 与 `localhost:3000` 的 Vite。若端口上已有同一项目的旧 daemon，启动器会先替换它，并等到 `/health` 确认当前 Canvas schema 后再打开前端，避免画布连上过期协议。修改 `daemon/` 会自动重建并重启后端，一次 Ctrl+C 会结束两者。预览工具需要其他端口时直接透传给 Vite，启动器会把该端口的精确回环 Origin 同步给 daemon：

```bash
npm run dev -- --host localhost --port 7100 --strictPort
```

`npm run dev:all` 是兼容别名。只做拆分进程调试时，可分别运行 `npm run daemon -- --project-root "$PWD" --allow-origin http://localhost:7100` 与 `npm run dev:frontend -- --port 7100`。

节点指令默认复用本机已有的 `codex` CLI，启动器不会安装或复制 Codex。GUI 启动器的 PATH 顺序异常时，会优先复用 PATH 中由 Homebrew 管理的 Codex；`GGAI_CODEX_COMMAND` 可显式覆盖。daemon 只执行 `codex login status` 探针，不读取或保存凭证。acpx 是 pre-1.0 的实验性备选，默认不注册；安装后必须同时以 `--acpx-agent codex` 显式启用，并配置 `VITE_GGAI_AGENT_ID=acpx:codex`。acpx 默认仅自动批准读取，非交互写入会失败；在理解其项目级权限边界后，才可显式传 `--acpx-approval approve-all`。

可选的前端环境变量见 [.env.example](./.env.example)：

- `VITE_GGAI_DAEMON_URL`：daemon 地址，默认 `http://127.0.0.1:7380`
- `VITE_GGAI_AGENT_ID`：后台 Agent id，默认 `codex`

daemon 参数：

```bash
npm run daemon -- --port 7380 --project-root /path/to/project \
  --allow-origin http://localhost:3000
```

可用 `--acpx-agent <id>` 增加允许的 adapter；任意未配置的 `acpx:<id>` 会被拒绝。acpx 需要非交互写入时可加：

```bash
npm run daemon -- --project-root "$PWD" --acpx-agent codex --acpx-approval approve-all
```

这会把 acpx 自身在该项目目录中的 permission 策略放开；默认 Codex transport 的 cwd 仍隔离在本 Run 的 `.gg/runs/<runId>/`，项目根只作为只读引用，另以 `--add-dir` 授权 `artifacts/.branches/<branch-hash>/<runId>/files/`。Canvas 不提供旧 `/canvas/source` 绑定协议。

Electron、LaunchAgent 等环境的 PATH 与交互式终端不同时，应显式传入 CLI 路径：

```bash
npm run daemon -- --project-root "$PWD" \
  --codex-command /absolute/path/to/codex \
  --acpx-command /absolute/path/to/acpx
```

也可使用 `GGAI_CODEX_COMMAND` / `GGAI_ACPX_COMMAND`。`GET /agents` 会返回实际解析的 `binaryPath`，并在执行前检查 transport 需要的 CLI flags、所选 approval 模式和已配置 adapter；版本存在但缺少 named-session、prompt 或 session cancel 能力的 CLI 会被标记为 unavailable。acpx 执行时先幂等 ensure 稳定命名的会话，再发送 prompt 供后续 resume；同一 cwd、adapter、sessionName 同时只允许一个 run。

acpx 的公开 CLI 只能取消会话当前 turn，不能按 request id 撤销另一个进程已经排队但尚未执行的请求。GGAI 已对进程内会话强制单飞，并在本地 client 关闭后二次 cancel 常驻 owner；但 daemon 非正常崩溃或外部程序共用同一 GGAI session 时，上游仍无法给出严格取消保证。因此不要从外部复用 GGAI 命名会话；非正常退出后，重新启用 acpx 前先确认并停止遗留的 acpx owner。直接 Codex transport 不受此限制，也是默认生产路径。

服务始终绑定 `127.0.0.1`，不接受外网监听地址。
daemon 自身默认只允许 `localhost:3000`、`127.0.0.1:3000` 与 `[::1]:3000`；一体启动器会按 Vite 的实际端口精确追加 Origin。手动拆分启动时，其他端口仍必须用 `--allow-origin` 显式加入。

## 验证

```bash
npm run build         # 前端类型检查 + daemon 编译 + Vite 生产构建
npm run test:daemon   # 单元测试 + 本地 HTTP/SSE 端到端测试
npm run test:ui       # React StrictMode 画布交互回归测试
npm run test:startup  # 一键启动参数 / Origin / Codex 解析测试
npm test              # 启动器 + daemon + UI 全部测试
npm run deps:check    # manifest/lock 一致性 + 非阻断式依赖信息报告
npm run deps:audit    # 手动严格漏洞审计；CI 中仅报告、不阻断
npm run verify        # 上述策略、完整 lint、测试、构建与最小 daemon 包验证
```

若执行环境禁止监听本地端口，`test:daemon` 的 HTTP/SSE 用例需要允许临时绑定 `127.0.0.1` 随机端口。

## 运行时文件

一次执行会在项目内维护：

```text
.gg/context/pack.md
.gg/context/pack.json
.gg/context/AGENTS.md
.gg/context/runs/<runId>/
.gg/skills/
.gg/runtime/task-sessions.json
.gg/runtime/plugin-capabilities/<digest>.json
.gg/runtime/projection-plans/<branch-hash>.json
.gg/runs/<runId>/
artifacts/.branches/<branch-hash>/<runId>/files/<relative-path>
artifacts/.branches/<branch-hash>/<runId>/.ggai/artifact-manifest.v1.json
```

daemon 不覆盖项目已有的根 `AGENTS.md`。详细协议、安全边界与模块说明见 [docs/AGENT-BACKEND.md](./docs/AGENT-BACKEND.md)，依赖升级和生产 runtime 规则见 [docs/DEPENDENCIES.md](./docs/DEPENDENCIES.md)，画布上下文策略见 [docs/AGENT-ARCHITECTURE.md](./docs/AGENT-ARCHITECTURE.md)。
最终 v3-only 路径、能力与发布门禁见 [docs/V3-CONVERGENCE.md](./docs/V3-CONVERGENCE.md)。
