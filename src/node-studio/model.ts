export const CUSTOM_NODE_MANIFEST_SCHEMA_VERSION = 1 as const

export type CustomNodeContentKind = 'text' | 'image' | 'table' | 'card'
export type CustomNodeIconId = 'text' | 'image' | 'table' | 'card'

export interface CustomNodeManifest {
  schemaVersion: typeof CUSTOM_NODE_MANIFEST_SCHEMA_VERSION
  revision: number
  installed: boolean
  id: string
  label: string
  description: string
  contentKind: CustomNodeContentKind
  icon: CustomNodeIconId
  defaultWidth: number
  placeholder: string
  actions: string[]
  emptyTitle: string
  emptyDescription: string
  sampleTitle: string
  sampleContent: string
  updatedAt: string
}

const RESERVED_IDS = new Set([
  'pdf', 'web', 'image', 'text', 'table', 'formula', 'code', 'graphic', 'smart', 'file',
])

export function createBlankCustomNodeManifest(now = new Date()): CustomNodeManifest {
  return {
    schemaVersion: CUSTOM_NODE_MANIFEST_SCHEMA_VERSION,
    revision: 0,
    installed: false,
    id: '@local/custom-node',
    label: '自定义节点',
    description: '根据你的工作流承载专属内容',
    contentKind: 'card',
    icon: 'card',
    defaultWidth: 340,
    placeholder: '描述希望这个节点完成的任务…',
    actions: [],
    emptyTitle: '等待内容',
    emptyDescription: '描述需求，由 Agent 生成',
    sampleTitle: '自定义节点示例',
    sampleContent: '这是节点内容区的实时预览。',
    updatedAt: now.toISOString(),
  }
}

export function draftCustomNodeFromRequirement(
  requirement: string,
  current: CustomNodeManifest,
  now = new Date(),
): CustomNodeManifest {
  const normalized = requirement.trim()
  const kind = inferContentKind(normalized)
  const label = inferLabel(normalized, kind)
  const slug = slugify(label)
  const actions = inferActions(normalized)
  return {
    ...current,
    id: `@local/${slug}`,
    label,
    description: normalized || current.description,
    contentKind: kind,
    icon: kind,
    defaultWidth: kind === 'table' ? 400 : kind === 'image' ? 360 : 340,
    placeholder: inferPlaceholder(kind),
    actions,
    emptyTitle: kind === 'image' ? '等待图像' : kind === 'table' ? '等待数据' : '等待内容',
    emptyDescription: '描述需求，由 Agent 生成',
    sampleTitle: `${label}示例`,
    sampleContent: inferSampleContent(kind, normalized),
    updatedAt: now.toISOString(),
  }
}

export function validateCustomNodeManifest(manifest: CustomNodeManifest): string[] {
  const errors: string[] = []
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 0) {
    errors.push('节点版本号无效')
  }
  if (!/^@local\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.id)) {
    errors.push('节点 ID 必须使用 @local/kebab-case')
  }
  if (RESERVED_IDS.has(manifest.id) || RESERVED_IDS.has(manifest.id.replace(/^@local\//u, ''))) {
    errors.push('节点 ID 不能覆盖内置节点')
  }
  if (!manifest.label.trim()) errors.push('节点名称不能为空')
  if (manifest.label.length > 80) errors.push('节点名称不能超过 80 个字符')
  if (!manifest.description.trim()) errors.push('节点说明不能为空')
  if (manifest.description.length > 500) errors.push('节点说明不能超过 500 个字符')
  if (!manifest.placeholder.trim()) errors.push('提示词占位不能为空')
  if (manifest.placeholder.length > 500) errors.push('提示词占位不能超过 500 个字符')
  if (!Number.isSafeInteger(manifest.defaultWidth)
    || manifest.defaultWidth < 280
    || manifest.defaultWidth > 640) {
    errors.push('节点宽度必须在 280–640 之间')
  }
  if (manifest.actions.length > 6) errors.push('快捷指令最多 6 个')
  if (manifest.actions.some((action) => !action.trim())) errors.push('快捷指令不能为空')
  if (manifest.actions.some((action) => action.length > 80)) errors.push('快捷指令不能超过 80 个字符')
  if (new Set(manifest.actions).size !== manifest.actions.length) errors.push('快捷指令不能重复')
  if (manifest.emptyTitle.length > 120 || manifest.emptyDescription.length > 240) {
    errors.push('空态文案过长')
  }
  if (manifest.sampleTitle.length > 120 || manifest.sampleContent.length > 10_000) {
    errors.push('示例内容过长')
  }
  const updatedAt = Date.parse(manifest.updatedAt)
  if (!Number.isFinite(updatedAt) || new Date(updatedAt).toISOString() !== manifest.updatedAt) {
    errors.push('更新时间格式无效')
  }
  return errors
}

export function isCustomNodeManifest(value: unknown): value is CustomNodeManifest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CustomNodeManifest>
  const exactKeys = [
    'schemaVersion', 'revision', 'installed', 'id', 'label', 'description', 'contentKind',
    'icon', 'defaultWidth', 'placeholder', 'actions', 'emptyTitle', 'emptyDescription',
    'sampleTitle', 'sampleContent', 'updatedAt',
  ]
  return Object.keys(value).length === exactKeys.length
    && exactKeys.every((key) => Object.hasOwn(value, key))
    && candidate.schemaVersion === CUSTOM_NODE_MANIFEST_SCHEMA_VERSION
    && typeof candidate.revision === 'number'
    && typeof candidate.installed === 'boolean'
    && typeof candidate.id === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.description === 'string'
    && ['text', 'image', 'table', 'card'].includes(candidate.contentKind ?? '')
    && ['text', 'image', 'table', 'card'].includes(candidate.icon ?? '')
    && typeof candidate.defaultWidth === 'number'
    && typeof candidate.placeholder === 'string'
    && Array.isArray(candidate.actions)
    && candidate.actions.every((action) => typeof action === 'string')
    && typeof candidate.emptyTitle === 'string'
    && typeof candidate.emptyDescription === 'string'
    && typeof candidate.sampleTitle === 'string'
    && typeof candidate.sampleContent === 'string'
    && typeof candidate.updatedAt === 'string'
}

export function customNodeRuntimeId(manifest: Pick<CustomNodeManifest, 'id' | 'revision'>): string {
  return `${manifest.id}@${manifest.revision}`
}

function inferContentKind(requirement: string): CustomNodeContentKind {
  if (/图像|图片|插画|照片|image|photo/iu.test(requirement)) return 'image'
  if (/表格|数据|指标|清单|table|data/iu.test(requirement)) return 'table'
  if (/文章|文本|文案|摘要|翻译|text|write/iu.test(requirement)) return 'text'
  return 'card'
}

function inferLabel(requirement: string, kind: CustomNodeContentKind): string {
  const quoted = requirement.match(/[“"]([^”"]{2,14})[”"]/u)?.[1]
  if (quoted) return quoted
  const prefix = requirement
    .replace(/^(我想要|我需要|创建|做一个|帮我做|构建|设计)\s*/u, '')
    .split(/[，。,.；;：:\n]/u)[0]
    ?.trim()
  if (prefix && prefix.length <= 14) return prefix.replace(/节点$/u, '')
  return ({ text: '智能文本', image: '创意图像', table: '数据工作表', card: '工作流卡片' })[kind]
}

function inferActions(requirement: string): string[] {
  const requested = [...requirement.matchAll(/(?:支持|可以|用于)([^，。；;]+)/gu)]
    .flatMap((match) => match[1]?.split(/[、和与]/u) ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 8)
  return [...new Set(requested)].slice(0, 5)
}

function inferPlaceholder(kind: CustomNodeContentKind): string {
  return ({
    text: '描述需要生成、改写或整理的文本…',
    image: '描述画面、风格、构图与尺寸…',
    table: '描述数据来源、字段与分析目标…',
    card: '描述希望这个节点完成的任务…',
  })[kind]
}

function inferSampleContent(kind: CustomNodeContentKind, requirement: string): string {
  if (kind === 'image') return '16:9 · 柔和自然光 · 电影感构图'
  if (kind === 'table') return '指标, 当前值, 环比\n访问量, 12480, +18%\n转化率, 4.8%, +0.6%'
  if (kind === 'text') return requirement || '在这里预览 Agent 生成的文本内容。'
  return requirement || '在这里预览节点的结构化内容。'
}

function slugify(value: string): string {
  const ascii = value.toLowerCase().trim()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (/^[a-z0-9-]+$/u.test(ascii) && ascii) return ascii
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return `node-${hash.toString(36)}`
}
