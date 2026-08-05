import type { ProjectionPluginContractV2 } from './projectionPlanV2.js'

/**
 * Daemon-owned, data-only artifact claims for the built-in content plugins.
 *
 * These contracts intentionally contain no renderers or executable hooks and
 * can therefore be validated, cloned, logged, or sent over a protocol boundary.
 */
export const BUILTIN_PROJECTION_PLUGIN_CONTRACTS_V2 = [
  {
    id: 'code',
    artifactRules: [{
      extensions: [
        '.r', '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.java',
        '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts', '.c', '.h',
        '.cc', '.cpp', '.hpp', '.cs', '.fs', '.fsx', '.scala', '.sh', '.bash',
        '.zsh', '.fish', '.sql', '.html', '.css', '.scss', '.sass', '.less',
        '.vue', '.svelte', '.lua', '.pl', '.ex', '.exs', '.erl', '.hrl',
      ],
      mediaTypes: [
        'text/x-r', 'text/x-python', 'text/javascript', 'application/javascript',
        'application/typescript', 'text/x-java-source', 'text/x-c', 'text/x-c++',
        'text/x-shellscript', 'application/sql', 'text/html', 'text/css',
      ],
      priority: 20,
    }],
  },
  {
    id: 'image',
    artifactRules: [{
      extensions: [
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp',
        '.tif', '.tiff', '.ico',
      ],
      mediaTypes: ['image/*'],
      priority: 20,
    }],
  },
  {
    id: 'pdf',
    artifactRules: [{
      extensions: ['.pdf'],
      mediaTypes: ['application/pdf'],
      priority: 20,
    }],
  },
  {
    id: 'table',
    artifactRules: [{
      extensions: ['.csv', '.tsv', '.xls', '.xlsx', '.ods', '.parquet', '.arrow', '.feather'],
      mediaTypes: [
        'text/csv', 'text/tab-separated-values', 'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.apache.parquet',
        'application/vnd.apache.arrow.file',
      ],
      priority: 20,
    }],
  },
  {
    id: 'text',
    artifactRules: [{
      extensions: ['.txt', '.md', '.markdown', '.rst', '.adoc', '.tex', '.log'],
      mediaTypes: ['text/*'],
      priority: 5,
    }],
  },
  {
    id: 'file',
    artifactRules: [],
    acceptsUnknown: true,
  },
] satisfies readonly ProjectionPluginContractV2[]
