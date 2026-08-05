import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeSse } from '../../src/agent/sse.js'

test('SSE consumer resolves on a terminal message without waiting for HTTP EOF', async () => {
  let streamCancelled = false
  let closeData = ''
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        'id: 1',
        'event: agent-event',
        'data: {"type":"done","stopReason":"end_turn"}',
        '',
        'id: 2',
        'event: close',
        'data: {"runId":"run-1","status":"done","sessionId":null,"artifacts":["artifacts/node/output.txt"],"artifactsComplete":true}',
        '',
        '',
      ].join('\n')))
      // Deliberately keep the stream open. Some proxies and embedded fetch
      // bridges do not surface HTTP EOF promptly after the protocol close.
    },
    cancel() {
      streamCancelled = true
      return new Promise<void>(() => {
        // A fetch bridge is allowed to delay transport cleanup indefinitely.
        // Protocol completion must not wait for this promise.
      })
    },
  })

  await Promise.race([
    consumeSse({ body }, (message) => {
      if (message.event !== 'close') return false
      closeData = message.data
      return true
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE close timed out')), 500)),
  ])

  assert.equal(JSON.parse(closeData).status, 'done')
  assert.equal(streamCancelled, true)
})
