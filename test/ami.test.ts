import { afterEach, describe, expect, test } from 'bun:test'

import { AmiHttpClient, parseAmiResponse } from '@/lib/asterisk/ami'

import { getTestPort, testLogger } from './helpers'

interface RecordedRequest {
  cookie: null | string
  fields: URLSearchParams
  url: URL
}

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(async () => {
  for (const server of servers) {
    await server.stop(true)
  }
  servers.length = 0
})

describe('AMI HTTP client', () => {
  test.each(['/manager', '/rawman'])('logs in, reloads modules, and logs off through %s', async (path) => {
    const requests: RecordedRequest[] = []
    const server = startAmiServer(path === '/manager', requests)
    const client = new AmiHttpClient(testLogger, {
      secret: 'top-secret',
      uri: `http://127.0.0.1:${server.port}${path}?deployment=freepbx`,
      username: 'hackfedd',
    })

    await client.reload(['chan_iax2.so', 'pbx_config.so'])

    expect(requests.map(request => request.fields.get('Action'))).toEqual([
      'Login',
      'Reload',
      'Reload',
      'Logoff',
    ])
    expect(requests.map(request => request.url.pathname)).toEqual([path, path, path, path])
    expect(requests.every(request => request.url.search === '?deployment=freepbx')).toBeTrue()
    expect(requests[0]?.fields.get('Username')).toBe('hackfedd')
    expect(requests[0]?.fields.get('Secret')).toBe('top-secret')
    expect(requests.slice(1).every(request => request.cookie === 'mansession_id=session-123')).toBeTrue()
    expect(requests.slice(1, 3).map(request => request.fields.get('Module'))).toEqual([
      'chan_iax2.so',
      'pbx_config.so',
    ])
  })

  test('logs off after a reload failure', async () => {
    const actions: Array<null | string> = []
    const server = Bun.serve({
      fetch: async request => {
        const fields = new URLSearchParams(await request.text())
        const action = fields.get('Action')
        actions.push(action)

        if (action === 'Login') {
          return amiResponse('Success', 'Authentication accepted', false, {
            'Set-Cookie': 'mansession_id=session-123; Path=/',
          })
        }
        if (action === 'Reload') {
          return amiResponse('Error', 'Module reload failed')
        }
        return amiResponse('Goodbye', 'Thanks')
      },
      hostname: '127.0.0.1',
      port: getTestPort(),
    })
    servers.push(server)

    const client = new AmiHttpClient(testLogger, {
      secret: 'secret',
      uri: `http://127.0.0.1:${server.port}/manager`,
      username: 'hackfedd',
    })

    const error = await getRejectedError(client.reload(['chan_iax2.so']))
    expect(error.message).toContain('Module reload failed')
    expect(actions).toEqual(['Login', 'Reload', 'Logoff'])
  })

  test('reports authentication failures', async () => {
    const server = Bun.serve({
      fetch: () => amiResponse('Error', 'Authentication failed'),
      hostname: '127.0.0.1',
      port: getTestPort(),
    })
    servers.push(server)

    const client = new AmiHttpClient(testLogger, {
      secret: 'wrong',
      uri: `http://127.0.0.1:${server.port}/rawman`,
      username: 'hackfedd',
    })

    const error = await getRejectedError(client.reload(['pbx_config.so']))
    expect(error.message).toContain('Authentication failed')
  })

  test('rejects malformed manager responses', () => {
    expect(() => parseAmiResponse('<html><body>not an AMI table</body></html>')).toThrow('no response fields')
    expect(() => parseAmiResponse('not an AMI response')).toThrow('no response fields')
  })
})

function amiResponse (
  response: string,
  message: string,
  isHtml = false,
  headers?: HeadersInit
): Response {
  const body = isHtml
    ? `<html><body><table><tbody><tr><td>Response</td><td>${response}</td></tr><tr><td>Message</td><td>${message}</td></tr></tbody></table></body></html>`
    : `Response: ${response}\r\nMessage: ${message}\r\n\r\n`

  return new Response(body, headers ? { headers } : undefined)
}

async function getRejectedError (promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('Expected promise to reject')
}

function startAmiServer (isHtml: boolean, requests: RecordedRequest[]): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    fetch: async request => {
      const fields = new URLSearchParams(await request.text())
      const action = fields.get('Action')
      requests.push({
        cookie: request.headers.get('cookie'),
        fields,
        url: new URL(request.url),
      })

      if (action === 'Login') {
        return amiResponse('Success', 'Authentication accepted', isHtml, {
          'Set-Cookie': 'mansession_id=session-123; Path=/; HttpOnly',
        })
      }
      if (request.headers.get('cookie') !== 'mansession_id=session-123') {
        return amiResponse('Error', 'Missing session', isHtml)
      }
      if (action === 'Logoff') {
        return amiResponse('Goodbye', 'Thanks', isHtml)
      }
      return amiResponse('Success', 'Module reloaded', isHtml)
    },
    hostname: '127.0.0.1',
    port: getTestPort(),
  })
  servers.push(server)
  return server
}
