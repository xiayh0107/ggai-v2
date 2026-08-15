# Node Skills：节点的任务能力契约

Node 不只具有内容类型，也可以具有明确、可审计的任务能力。Node Skills 将用户管理的
Skill 资产绑定到某类 Node 或某个 Node 实例，并在 Agent 与这些 Node 交互时固定进 Run。

这里的 skill 是包含根级 `SKILL.md` 的数据资产，不是 Canvas 权限，也不是可执行插件。
它可以来自 Agent 默认 skills 目录、任意其他本地目录，或用户自己的仓库。安装是一次明确的
资产所有权转移：成功后原目录不再保留，Run 只依赖工作空间资产库中的受管修订。

## 1. 四层模型

```text
外部 Skill 目录
    │ 显式移动并安装；不扫描默认目录
    ▼
Workspace SkillAssetCatalog
    │ 不可变 revision + 内容 digest
    ├── Node type 默认绑定
    └── Canvas Node 实例绑定（继承并追加 / 完全替换）
            │
            ▼
Run 接受时解析参与 Node → 固定有效 skills 与来源 → 写入 Run 专属 context
```

### SkillAsset

一次安装会递归读取一个包含 `SKILL.md` 的目录，拒绝 symlink、特殊文件、超限文件与目录逃逸，
然后将整个目录原子移动到 daemon 管理的内容寻址目录：

```text
.gg/workspace/skills/
├── catalog.json
└── assets/<sha256>/...
```

Canvas 和绑定只保存精确引用：

```ts
interface SkillAssetRef {
  skillId: string
  revision: number
  digest: string
}
```

新安装产生新 revision，不覆盖旧 revision。归档只从日常管理视图中退场，不删除历史字节，
所以旧 Canvas revision 与已接受 Run 仍可复现。

安装成功后，`.gg/workspace/skills/assets/<sha256>` 是该修订唯一的事实源。Catalog 写入失败时，
daemon 会把目录移回原位置；来源与资产库不在同一文件系统时安装会拒绝，避免用复制后删除伪装
成不可回滚的“移动”。若要继续在 Git 仓库中编辑 Skill，应先在仓库保留独立开发副本，再把待发布
目录交给工作空间安装。

### Node type 默认绑定

Workspace 可以为任意 Node type 绑定默认 skills，包括内置类型与 community/custom runtime type。
绑定自身使用 revision CAS；两个管理窗口不能静默覆盖彼此。

### Node 实例绑定

`CanvasNode.skillBindings` 是可选的持久字段：

```ts
interface NodeSkillBindings {
  inheritType: boolean
  skills: SkillAssetRef[]
}
```

- 字段缺失：继承类型默认 skills，不增加实例 skill；
- `inheritType: true`：类型默认 + 实例 additions；
- `inheritType: false`：完全使用实例列表。

同一个 skill id 不允许同时绑定两个 revision。`DuplicateNode` 保留实例绑定；修改必须经过
`UpdateNodeSkillBindings` command，因此进入 Canvas revision、outbox、CAS 与版本历史。

## 2. Agent 解析边界

Run 只解析实际参与本次 Task 的 Node：

1. 该 Task 拥有的输出 Node（`target`）；
2. 直接指向该 Task 的 Node 输入边（`context`）；
3. RunIntent 显式附加的 Node（`attachment`）。

daemon 合并每个 Node 的类型默认和实例绑定。若参与 Node 对同一 skill id 指向不同 revision，
Run 在接受前以 `skill_binding_conflict` 失败，禁止按顺序覆盖。所有引用随后从 Workspace catalog
重新校验文件数量、大小、单文件 digest 与整体 snapshot digest。

接受成功后，Run 保存：

- 完整 skill bytes；
- 精确 `SkillAssetRef`；
- title/description；
- 授权来源 Node、Node type 与角色；
- 整体 `skillCapabilityDigest`。

同一份内容写入：

```text
.gg/context/runs/<runId>/skills/
├── index.json
└── <skill-id>-r<revision>-<digest-prefix>/
    └── SKILL.md
```

`pack.md` 明确要求 Agent 只读取 index 中列出的 Node-bound skills。项目其他目录、Agent 默认
skills 目录或已经归档但未绑定的 skill 都不会自动加入。skill 文本只能指导任务，不能扩大
typed-edge、attachment、文件系统、artifact 或 Canvas command 权限。

## 3. 管理协议

浏览器使用严格 JSON 协议；所有写入由 daemon 持有 Workspace lease：

| Method | Path | 作用 |
| --- | --- | --- |
| `GET` | `/skill-assets` | 列出不可变 revision 与类型绑定 |
| `POST` | `/skill-assets/import` | 从显式绝对路径移动并安装新 revision |
| `DELETE` | `/skill-assets/:skillId` | 归档 skill id，不删除历史内容 |
| `PUT` | `/skill-bindings/types/:nodeType` | 以 CAS 更新类型默认绑定 |

实例绑定不另设旁路 API，统一使用 Canvas `UpdateNodeSkillBindings` command。客户端解码器拒绝
未知字段、错误 revision、错误 digest 与 widened envelope。

首期先完成资产、协议、Canvas 与 Run 纵向能力，管理 UI 另行接入 Node Studio / Node inspector；
UI 不得自行扫描磁盘或把路径写进 CanvasNode。

## 4. 容量与安全门禁

- 每个 skill 最多 256 个文件，单文件 1 MiB，总计 4 MiB；
- 每个 Node 最多 32 个绑定，每个 Run 最多 32 个 skill、8 MiB；
- 只接受普通文件，逐文件 `O_NOFOLLOW` + exact read + SHA-256；
- catalog、blob 与 Workspace 父目录都必须位于 canonical project root，拒绝 symlink 穿透；
- 外部绝对路径不持久化、不进入 Canvas、Run summary 或 Agent pack；
- 安装后原目录不存在，修改受管 snapshot 会在 Run 接受前失败；
- 已接受 Run 使用自己的固定副本，不受后续安装新修订、归档或绑定修改影响。

## 5. 回归门禁

1. 类型继承、实例追加、实例替换和 revision 冲突都有纯函数测试；
2. command wire、共享 reducer、DuplicateNode 与 Node context read model 保持一致；
3. install/move、失败回滚、CAS、archive、tamper、source symlink 与 Workspace parent symlink 有 daemon 测试；
4. HTTP 管理协议拒绝额外字段与 stale revision；
5. 真实 Run 测试必须证明类型 skill 和实例 skill 都出现在 Run 专属目录，并被 Agent transport 读取；
6. 空绑定 Run 的 digest 仍稳定，旧 Canvas 文档因可选字段保持可读。
