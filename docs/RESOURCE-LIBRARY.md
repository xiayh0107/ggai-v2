# Workspace Resource Library

资源库是 Workspace 级的资源控制面，与工作空间、节点工作台并列。它不是 Canvas
的另一种表示，也不是 Run-owned artifact 列表的别名。本文是资源库的信息架构、
scope、路由、命名与信任边界的规范性文档。

## 1. 稳定信息架构

资源库的一级 provider 固定为：

| Provider | 用户面向的内容 | Scope | 当前边界 |
| --- | --- | --- | --- |
| 生成内容 | Agent 任务生成的图像、文本、代码、表格、数据与其它文件 | 项目 | 由 closed Run manifest 建立 catalog；已实现只读查看与下载 |
| 项目文件与数据 | 用户上传、显式引用或挂载给项目的文件、素材和数据集 | 项目 | 需独立文件 catalog；未接入时显示规划态 |
| 节点能力 | 已安装、已启用、可更新与社区贡献的节点类型 | Workspace | 资源库负责发现/安装/管理；节点工作台负责创作/预览/调试 |
| 任务 Skills | 可绑定到节点类型和节点实例的不可变任务能力修订 | Workspace | 从显式目录导入；资源库管理资产与类型默认绑定，Canvas 管理实例覆盖 |
| 存储与同步 | 本地目录、网盘、同步与版本快照连接 | Workspace / 项目 | 需显式连接 catalog；未接入时显示规划态 |
| 计算与部署 | 计算集群、远程服务器和部署目标 | Workspace | 需显式连接 catalog；未接入时显示规划态 |

「全部」只能表示当前 provider 内的全部类型，不能用一个 artifact 媒体类型筛选器
伪装成整个资源库的「全部资源」。项目文件、生成内容、节点能力和运行环境是不同的
资源域，不得因为其中某一个 provider 已经可用就隐去其它分区。

## 2. Scope 与项目选择

- 资源库壳始终是 Workspace scope。`/resources` 不需要 project 参数，即使没有任何项目
  也必须可打开，并显示稳定分区与诚实空态。
- 「生成内容」和「项目文件与数据」是 project-scoped provider。用户从资源库进入时，
  必须通过项目选择器显式选择范围；也可选「全部项目」，但实现必须从守护的 Project catalog
  聚合，不得扫描目录。
- 从 Canvas 的项目内入口进入时，当前 opaque Project id 是用户已明确的上下文，
  可以直达对应 project-scoped provider。这不等于 Workspace 主导航可以自动推测项目。
- 严禁将「最近打开」、最近更新、列表第一项或历史浏览器状态当作隐式默认项目；
  Workspace 根不是 Project，任何资源选择器都不得展示或接受根目录作为项目范围。
  未选择项目时应显示项目选择状态，不应失败为「资源库地址无效」。
- 项目切换必须取消旧请求、清理旧列表并校验新 Project identity，禁止短暂把 A 项目的
  资源显示在 B 项目标题下。

## 3. 路由与入口

规范路由：

```text
/resources                                      # Workspace 级资源库首页
/resources/generated?project=<opaque-id>        # 项目生成内容
/resources/files?project=<opaque-id>            # 项目文件与数据
/resources/capabilities                         # 节点能力
/resources/skills                               # 任务 Skills 与节点类型默认绑定
/resources/connections                          # 存储与同步
/resources/compute                              # 计算与部署
```

- Workspace 主导航「资源库」只导航到 `/resources`，不拼接或推测 project id。
- Canvas 左侧工作台提供「生成内容」入口，它必须带当前项目的 opaque id，
  并直达 `/resources/generated`。该按钮不得标成泛化的「资源库」。
- 资源库页使用 Workspace 的全局壳与主导航，正确标记当前分区；project-scoped 子视图
  使用「资源库 / provider / 项目名」面包屑，项目名只来自 Project catalog。
- 从生成内容返回 Canvas 是上下文动作，不得取代资源库的全局导航或面包屑。

## 4. 命名与文案

| 层级 | 规范名称 | 说明 |
| --- | --- | --- |
| 全局区域 | 资源库 | 「管理项目文件、生成内容、节点能力和连接」 |
| Run-owned artifact provider | 生成内容 | 「由任务生成并独立于画布保存」 |
| Canvas 内深链 | 生成内容 / 项目资源 | 仅指当前项目的 provider，不冒充全局区域 |
| 节点安装与管理 | 节点能力 | 与「节点工作台」的创作职责分离 |

用户界面不得暴露 `artifact`、manifest、Run id、Task id、`projectDir` 等内部术语或身份。
「资源管理站」不是第二个并列产品名称；不得用它将「生成内容」子视图包装成资源库全部。

从 Canvas 移除节点后，提示应表达为：「已从画布移除，生成内容已保留在资源库。」
若提供可操作出口，则连接到「资源库 > 生成内容」。

## 5. Provider 信任边界

- 每个 provider 只能从 daemon 管理的显式 catalog 读取资源。不得递归扫描 daemon 根、
  Project root、受管项目目录、用户主目录或任意挂载目录来推断资源。
- Project discovery 只来自 `projects.json` 的 opaque identity，见
  [`WORKSPACE-PROJECTS.md`](./WORKSPACE-PROJECTS.md)。资源库不得建立第二套项目发现逻辑。
- 生成内容只来自 closed Run manifest，其列表、预览和下载必须持续执行
  [`CANVAS.md`](./CANVAS.md) 的 artifact 身份、路径和完整性校验。
- 项目文件与数据不得从 Run manifest 推断；只有用户上传、显式引用或受控挂载进入它的
  独立 catalog。
- 节点能力只来自受管注册表；连接、存储与计算目标只来自对应配置 catalog。
- Provider 的聚合层只可保存 opaque provider/project/resource identity，不得把绝对路径发送给浏览器。

## 6. 规划态与能力边界

- 未有 daemon/API 的 provider 保留在信息架构中，显示「规划中」或「尚未接入」，并且不可点击。
- 不得用静态数组、随机计数、样例项目、失效的上传/删除/放回画布按钮，或没有持久化语义的操作
  伪造已实现能力。
- 只读 provider 必须如实说明可预览与下载，不显示物理删除、重新放置、跨项目移动等虚假操作。
- Provider 加载失败只影响对应子视图，不应使整个资源库壳不可用。

## 7. 防退化验收门禁

资源库变更必须至少覆盖：

1. Workspace 主导航始终到 `/resources`，不根据最近项目改写目标。
2. 零项目时 `/resources` 仍显示完整分区，且未实现 provider 有诚实规划态。
3. 项目型 provider 在未选择项目时显示选择态，不自动选择、不报整库地址无效。
4. Canvas 深链只带当前 opaque Project id，直达「生成内容」，并显示正确面包屑与项目名。
5. 项目切换中止旧请求，不在新 scope 下短暂显示旧资源。
6. 生成内容在 Canvas Node/Task 移除后仍可发现，分页、partial、完整性失败、预览和下载的现有测试继续有效。
7. 一级页标题与空态不把所有资源等同于 Agent 生成文件，用户界面不暴露内部 artifact/Run 术语。
8. IA 使用单一共享定义或同一组契约测试，避免 Workspace、Canvas 入口和资源页各自定义后漂移。
