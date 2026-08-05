import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentEventTranslator,
  translateAgentLine,
  translateAgentMessage,
  translateStderrLine,
} from '../translator.js'

test('buffers split ACP NDJSON chunks and ignores blank lines', () => {
  const seen: string[] = []
  const translator = new AgentEventTranslator({ onSessionId: (id) => seen.push(id) })
  const first = translator.push('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_')
  const second = translator.push('chunk","content":{"type":"text","text":"hello"}}}}\n\n')

  assert.deepEqual(first, [])
  assert.deepEqual(second, [{ type: 'text-delta', text: 'hello' }])
  assert.equal(translator.sessionId, 's-1')
  assert.deepEqual(seen, ['s-1'])
  assert.equal(translator.takeSessionId(), 's-1')
  assert.equal(translator.sessionId, null)
})

test('handles split UTF-8 bytes and a final line without newline', () => {
  const bytes = new TextEncoder().encode('你好')
  const translator = new AgentEventTranslator()

  assert.deepEqual(translator.push(bytes.slice(0, 2)), [])
  assert.deepEqual(translator.push(bytes.slice(2)), [])
  assert.deepEqual(translator.flush(), [{ type: 'text-delta', text: '你好' }])
})

test('translates ACP thoughts, tool calls, results, plans, usage, and completion', () => {
  const message = (update: Record<string, unknown>) => translateAgentMessage({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'acp-session', update },
  })

  assert.deepEqual(message({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'checking' },
  }).events, [{ type: 'thinking', text: 'checking' }])

  assert.deepEqual(message({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Read config',
    rawInput: { path: 'config.json' },
  }).events, [{ type: 'tool-call', name: 'Read config', input: { path: 'config.json' } }])

  assert.deepEqual(message({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    rawOutput: { bytes: 12 },
  }).events, [{ type: 'tool-result', result: { bytes: 12 } }])

  assert.deepEqual(message({
    sessionUpdate: 'plan_update',
    plan: { entries: [{ content: 'Inspect files', status: 'pending' }] },
  }).events, [{ type: 'thinking', text: 'Plan:\n- [pending] Inspect files' }])

  assert.deepEqual(message({ sessionUpdate: 'usage_update', used: 53_000, size: 200_000 }).events, [
    { type: 'usage', tokensIn: 53_000, tokensOut: 0 },
  ])

  assert.deepEqual(translateAgentMessage({
    jsonrpc: '2.0',
    id: 2,
    result: { stopReason: 'cancelled' },
  }).events, [{ type: 'done', stopReason: 'cancelled' }])
})

test('translates ACP permission requests', () => {
  const result = translateAgentMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'session/request_permission',
    params: {
      sessionId: 's-1',
      title: 'Approve file edit?',
      description: 'Allow editing src/main.ts?',
      subject: { type: 'tool_call', toolCall: { toolCallId: 'call-1' } },
    },
  })

  assert.deepEqual(result, {
    sessionId: 's-1',
    events: [{
      type: 'permission-request',
      id: '5',
      action: 'Approve file edit?',
      detail: 'Allow editing src/main.ts?',
    }],
  })
})

test('captures Codex thread id and translates common item events', () => {
  assert.deepEqual(translateAgentMessage({ type: 'thread.started', thread_id: 'thread-42' }), {
    events: [],
    sessionId: 'thread-42',
  })

  assert.deepEqual(translateAgentMessage({
    type: 'item.completed',
    item: { type: 'reasoning', text: 'I should inspect the project.' },
  }).events, [{ type: 'thinking', text: 'I should inspect the project.' }])

  assert.deepEqual(translateAgentMessage({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'Done.' },
  }).events, [{ type: 'text-delta', text: 'Done.' }])

  assert.deepEqual(translateAgentMessage({
    type: 'item.started',
    item: { type: 'command_execution', command: 'npm test' },
  }).events, [{ type: 'tool-call', name: 'command', input: { command: 'npm test' } }])

  assert.deepEqual(translateAgentMessage({
    type: 'item.completed',
    item: { type: 'command_execution', aggregated_output: 'ok', exit_code: 0 },
  }).events, [{ type: 'tool-result', result: 'ok' }])

  assert.deepEqual(translateAgentMessage({
    type: 'item.started',
    item: { type: 'mcp_tool_call', server: 'docs', tool: 'lookup', arguments: { q: 'ACP' } },
  }).events, [{ type: 'tool-call', name: 'docs.lookup', input: { q: 'ACP' } }])

  assert.deepEqual(translateAgentMessage({
    type: 'item.completed',
    item: { type: 'file_change', changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] },
  }).events, [
    { type: 'file-write', path: 'src/a.ts', nodeId: undefined },
    { type: 'file-write', path: 'src/b.ts', nodeId: undefined },
  ])
})

test('emits Codex turn usage before completion and handles failure', () => {
  assert.deepEqual(translateAgentMessage({
    type: 'turn.completed',
    usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 },
  }).events, [
    { type: 'usage', tokensIn: 120, tokensOut: 30 },
    { type: 'done', stopReason: 'end_turn' },
  ])

  assert.deepEqual(translateAgentMessage({
    type: 'turn.failed',
    error: { message: 'process crashed' },
  }).events, [
    { type: 'error', message: 'process crashed' },
    { type: 'done', stopReason: 'error' },
  ])
})

test('falls back safely for plain output, stderr, malformed, and unknown JSON', () => {
  assert.deepEqual(translateAgentLine('plain stdout'), {
    events: [{ type: 'text-delta', text: 'plain stdout' }],
    sessionId: null,
  })
  assert.deepEqual(translateStderrLine('warning: experimental feature'), [
    { type: 'error', message: 'warning: experimental feature' },
  ])
  assert.deepEqual(translateAgentLine('{not-json'), {
    events: [{ type: 'text-delta', text: '{not-json' }],
    sessionId: null,
  })
  assert.deepEqual(translateAgentMessage({ future: { arbitrary: true } }), {
    events: [],
    sessionId: null,
  })
})

test('treats explicit ACP and generic error envelopes as terminal', () => {
  assert.deepEqual(translateAgentMessage({
    jsonrpc: '2.0',
    id: 7,
    error: { message: 'ACP failed' },
  }).events, [
    { type: 'error', message: 'ACP failed' },
    { type: 'done', stopReason: 'error' },
  ])

  assert.deepEqual(translateAgentMessage({ type: 'failure', message: 'generic failed' }).events, [
    { type: 'error', message: 'generic failed' },
    { type: 'done', stopReason: 'error' },
  ])
})

test('bounds an unterminated output line and resumes after the next newline', () => {
  const translator = new AgentEventTranslator()
  const overflow = translator.push('x'.repeat(1024 * 1024 + 1))
  assert.deepEqual(overflow, [
    { type: 'error', message: 'Agent output line exceeded 1048576 characters' },
    { type: 'done', stopReason: 'error' },
  ])
  assert.deepEqual(translator.push('discarded\n{"type":"message","text":"after"}\n'), [
    { type: 'text-delta', text: 'after' },
  ])
})
