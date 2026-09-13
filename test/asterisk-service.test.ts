import type { TelephonyDirectory } from '@hackfed/schemas/v1'

import { TelephonyDirectorySchema } from '@hackfed/schemas/v1'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { AsteriskModule } from '@/lib/asterisk/render'

import { Asterisk } from '@/lib/asterisk'
import { Directory } from '@/lib/common/directory'
import { ConfigSchema } from '@/lib/config/config.schema'

import { getTestPort, telephonyDirectory, testLogger } from './helpers'

const servers: Array<ReturnType<typeof Bun.serve>> = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const server of servers) {
    await server.stop(true)
  }
  servers.length = 0
  for (const directory of temporaryDirectories) {
    await rm(directory, { force: true, recursive: true })
  }
  temporaryDirectories.length = 0
})

describe('Asterisk service', () => {
  test('reloads both modules at startup and retains pending reloads after failure', async () => {
    let data = telephonyDirectory
    let version = 1
    const requestEtags: Array<null | string> = []
    const server = Bun.serve({
      fetch: request => {
        requestEtags.push(request.headers.get('if-none-match'))
        const etag = `"v${version}"`
        if (request.headers.get('if-none-match') === etag) {
          return new Response(null, { headers: { ETag: etag }, status: 304 })
        }
        return Response.json(data, { headers: { ETag: etag } })
      },
      hostname: '127.0.0.1',
      port: getTestPort(),
    })
    servers.push(server)

    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'hackfedd-asterisk-'))
    temporaryDirectories.push(outputDirectory)
    const config = ConfigSchema.parse({
      general: {
        directory: `http://127.0.0.1:${server.port}`,
        directory_refresh_interval: 3600,
        ignored_orgs: ['skip'],
        org_id: 'xkem',
      },
      telephony: {
        output: {
          asterisk: {
            directory: outputDirectory,
            reload: {
              ami: { secret: 'not-used' },
              type: 'ami+http',
            },
          },
          type: 'asterisk',
        },
      },
    })
    const directory = new Directory({
      directory: {
        refreshIntervalSeconds: 3600,
        root: config.general.directory,
      },
      kind: 'telephony',
      parentLogger: testLogger,
      schema: TelephonyDirectorySchema,
    })
    const reloads: AsteriskModule[][] = []
    let shouldFail = true
    const service = new Asterisk(testLogger, config, {
      directory,
      reloader: {
        reload: async modules => {
          reloads.push([...modules])
          await Promise.resolve()
          if (reloads.length > 1 && shouldFail) {
            shouldFail = false
            throw new Error('reload failed')
          }
        },
      },
    })

    await service.start()
    expect(reloads).toEqual([['chan_iax2.so', 'pbx_config.so']])
    const generatedFiles = await readdir(outputDirectory)
    expect(generatedFiles.toSorted((left, right) => left.localeCompare(right))).toEqual([
      'extensions-inbound.conf',
      'extensions-outbound.conf',
      'iax.conf',
    ])
    const directoryStats = await stat(outputDirectory)
    expect(directoryStats.mode & 0o777).toBe(0o755)
    const generatedModes = await Promise.all(generatedFiles.map(async file => {
      const fileStats = await stat(path.join(outputDirectory, file))
      return fileStats.mode & 0o777
    }))
    expect(generatedModes).toEqual([0o644, 0o644, 0o644])

    data = changedRemoteEndpoint(telephonyDirectory)
    version = 2
    const reloadError = await getRejectedError(directory.update())
    expect(reloadError.message).toContain('reload failed')
    expect(await directory.update()).toBeTrue()
    expect(reloads).toEqual([
      ['chan_iax2.so', 'pbx_config.so'],
      ['chan_iax2.so'],
      ['chan_iax2.so'],
    ])
    expect(requestEtags).toEqual([null, '"v1"', '"v1"'])
    service.stop()
  })

  test('fails startup when the configured local exchange is missing', async () => {
    const server = Bun.serve({
      fetch: () => Response.json(telephonyDirectory),
      hostname: '127.0.0.1',
      port: getTestPort(),
    })
    servers.push(server)
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'hackfedd-asterisk-'))
    temporaryDirectories.push(outputDirectory)
    const config = ConfigSchema.parse({
      general: {
        directory: `http://127.0.0.1:${server.port}`,
        org_id: 'xkem',
      },
      telephony: {
        org_exchange_id: 'missing',
        output: {
          asterisk: { directory: outputDirectory },
          type: 'asterisk',
        },
      },
    })

    const startupError = await getRejectedError(new Asterisk(testLogger, config).start())
    expect(startupError.message).toContain('xkem/missing')
    expect(await readdir(outputDirectory)).toEqual([])
  })
})

function changedRemoteEndpoint (source: TelephonyDirectory): TelephonyDirectory {
  const result = structuredClone(source)
  const exchange = result.orgs.find(org => org.orgId === 'bksp')?.exchanges[0]
  if (!exchange) {
    throw new Error('test fixture is missing bksp')
  }
  exchange.endpoint = '[fd79:7636:1f08:883d::8]:4571'
  return result
}

async function getRejectedError (promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('Expected promise to reject')
}
