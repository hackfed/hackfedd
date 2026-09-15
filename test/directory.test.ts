import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { Directory } from '@/lib/common/directory'

import { getRejectedError, getTestPort, testLogger } from './helpers'

const servers: Array<ReturnType<typeof Bun.serve>> = []
const schema = z.object({ value: z.number() })

afterEach(async () => {
  for (const server of servers) {
    await server.stop(true)
  }
  servers.length = 0
})

describe('Directory', () => {
  test('uses ETags and retries a document when an awaited handler fails', async () => {
    let version = 1
    const ifNoneMatch: Array<null | string> = []
    const server = Bun.serve({
      fetch: request => {
        ifNoneMatch.push(request.headers.get('if-none-match'))
        const etag = `"v${version}"`
        if (request.headers.get('if-none-match') === etag) {
          return new Response(null, { headers: { ETag: etag }, status: 304 })
        }
        return Response.json({ value: version }, { headers: { ETag: etag } })
      },
      hostname: '127.0.0.1',
      port: getTestPort(),
    })
    servers.push(server)

    const directory = makeDirectory(server.port)
    expect(await directory.get()).toEqual({ value: 1 })

    version = 2
    let shouldFail = true
    directory.on('changed', () => {
      if (!shouldFail) {
        return
      }

      shouldFail = false
      throw new Error('apply failed')
    })

    const error = await getRejectedError(directory.update())
    expect(error.message).toContain('apply failed')
    expect(await directory.update()).toBeTrue()
    expect(await directory.update()).toBeFalse()
    expect(ifNoneMatch).toEqual([null, '"v1"', '"v1"', '"v2"'])
  })

  test('serializes polling and stops scheduling new requests', async () => {
    let version = 0
    let activeHandlers = 0
    let maximumActiveHandlers = 0
    let requestCount = 0
    const server = Bun.serve({
      fetch: () => {
        requestCount++
        version++
        return Response.json({ value: version }, { headers: { ETag: `"v${version}"` } })
      },
      hostname: '127.0.0.1',
      port: getTestPort(),
    })
    servers.push(server)

    const directory = makeDirectory(server.port, 0.005)
    await directory.get()
    directory.on('changed', async () => {
      activeHandlers++
      maximumActiveHandlers = Math.max(maximumActiveHandlers, activeHandlers)
      await Bun.sleep(25)
      activeHandlers--
    })

    directory.startPolling()
    await Bun.sleep(90)
    directory.stopPolling()
    await Bun.sleep(35)
    const stoppedRequestCount = requestCount
    await Bun.sleep(30)

    expect(maximumActiveHandlers).toBe(1)
    expect(requestCount).toBeGreaterThan(2)
    expect(requestCount).toBe(stoppedRequestCount)
  })

  test('retries a partially applied document without blocking successful work', async () => {
    const ifNoneMatch: Array<null | string> = []
    const server = Bun.serve({
      fetch: request => {
        ifNoneMatch.push(request.headers.get('if-none-match'))
        if (request.headers.get('if-none-match') === '"v1"') {
          return new Response(null, { status: 304 })
        }
        return Response.json({ value: 1 }, { headers: { ETag: '"v1"' } })
      },
      hostname: '127.0.0.1',
      port: getTestPort(),
    })
    servers.push(server)

    const directory = makeDirectory(server.port)
    let isComplete = false
    let applyCount = 0
    directory.on('changed', () => {
      applyCount++
      return isComplete
    })

    expect(await directory.update()).toBeTrue()
    expect(await directory.update()).toBeTrue()
    isComplete = true
    expect(await directory.update()).toBeTrue()
    expect(await directory.update()).toBeFalse()
    expect(applyCount).toBe(3)
    expect(ifNoneMatch).toEqual([null, null, null, '"v1"'])
  })

  test('coalesces overlapping manual updates', async () => {
    let requests = 0
    const server = Bun.serve({
      fetch: async () => {
        requests++
        await Bun.sleep(20)
        return Response.json({ value: 1 }, { headers: { ETag: '"v1"' } })
      },
      hostname: '127.0.0.1',
      port: getTestPort(),
    })
    servers.push(server)

    const directory = makeDirectory(server.port)
    await Promise.all([directory.update(), directory.update(), directory.update()])
    expect(requests).toBe(1)
  })
})

function makeDirectory (port: number | undefined, refreshIntervalSeconds = 60): Directory<z.infer<typeof schema>> {
  if (!port) {
    throw new Error('test server did not bind a port')
  }

  return new Directory({
    directory: {
      refreshIntervalSeconds,
      root: `http://127.0.0.1:${port}`,
    },
    kind: 'test',
    parentLogger: testLogger,
    schema,
  })
}
