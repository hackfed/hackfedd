import type { WireguardDirectory } from '@hackfed/schemas/v1'

import { WireguardDirectorySchema } from '@hackfed/schemas/v1'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { writeFileAtomic } from '@/lib/common/atomic-file'
import { Directory } from '@/lib/common/directory'
import { ConfigSchema } from '@/lib/config/config.schema'
import { filterWireguardDirectory, WireGuard } from '@/lib/wireguard'

import { getTestPort, testLogger } from './helpers'

const PUBLIC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const PRIVATE_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
const servers: Array<ReturnType<typeof Bun.serve>> = []
const temporaryDirectories: string[] = []

const wireguardDirectory: WireguardDirectory = WireguardDirectorySchema.parse({
  orgs: [
    {
      name: 'Local\nPostUp = touch /tmp/hackfedd-injected',
      orgId: 'xkem',
      peers: [
        { address: 'fd79:7636:1f08:883d:0:0:0:101/128', endpoint: null, publicKey: PUBLIC_KEY },
        { address: 'fd79:7636:1f08:883d::102/128', endpoint: null, publicKey: PUBLIC_KEY },
      ],
    },
    {
      name: 'Remote',
      orgId: 'bksp',
      peers: [{ address: 'fd79:7636:1f08:883d::8/128', endpoint: '198.51.100.8:51820', publicKey: PUBLIC_KEY }],
    },
    {
      name: 'Ignored',
      orgId: 'skip',
      peers: [{ address: 'fd79:7636:1f08:883d::66/128', endpoint: null, publicKey: PUBLIC_KEY }],
    },
  ],
})

afterEach(async () => {
  delete process.env.HFD_SKIP_PREFLIGHT_CHECKS
  for (const server of servers) {
    await server.stop(true)
  }
  servers.length = 0
  for (const directory of temporaryDirectories) {
    await rm(directory, { force: true, recursive: true })
  }
  temporaryDirectories.length = 0
})

describe('WireGuard', () => {
  test('filters the current address and ignored organizations', () => {
    const filtered = filterWireguardDirectory(
      wireguardDirectory,
      'fd79:7636:1f08:883d::101',
      ['skip']
    )

    expect(filtered.orgs.map(org => org.orgId)).toEqual(['bksp', 'xkem'])
    expect(filtered.orgs.flatMap(org => org.peers.map(peer => peer.address))).toEqual([
      'fd79:7636:1f08:883d::8/128',
      'fd79:7636:1f08:883d::102/128',
    ])
    expect(filtered.orgs.find(org => org.orgId === 'xkem')?.name).toBe(
      'Local PostUp = touch /tmp/hackfedd-injected'
    )
  })

  test('starts an inactive systemd unit when the configuration is unchanged', async () => {
    const fixture = await makeService('systemctl', command => command[1] === 'is-active'
      ? { exitCode: 3, stderr: '', stdout: 'inactive' }
      : { exitCode: 0, stderr: '', stdout: 'ok' },
    async (targetPath, contents) => {
      await writeFileAtomic(targetPath, contents)
      return false
    })
    await fixture.service.start()
    fixture.service.stop()

    expect(fixture.commands).toEqual([
      ['systemctl', 'cat', 'wg-quick@hackfed0.service'],
      ['systemctl', 'is-active', '--quiet', 'wg-quick@hackfed0.service'],
      ['systemctl', 'start', 'wg-quick@hackfed0.service'],
    ])
    const rendered = await Bun.file(fixture.outputPath).text()
    expect(rendered).toContain('fd79:7636:1f08:883d::8/128')
    expect(rendered).not.toContain('fd79:7636:1f08:883d:0:0:0:101/128')
    expect(rendered).not.toContain('fd79:7636:1f08:883d::66/128')
    expect(rendered).not.toContain('\nPostUp = touch /tmp/hackfedd-injected')
  })

  test('does not restart an active systemd unit when the configuration is unchanged', async () => {
    const fixture = await makeService('systemctl')
    await fixture.service.start()
    fixture.service.stop()
    await fixture.service.start()
    fixture.service.stop()

    expect(fixture.commands).toEqual([
      ['systemctl', 'cat', 'wg-quick@hackfed0.service'],
      ['systemctl', 'is-active', '--quiet', 'wg-quick@hackfed0.service'],
      ['systemctl', 'restart', 'wg-quick@hackfed0.service'],
      ['systemctl', 'cat', 'wg-quick@hackfed0.service'],
      ['systemctl', 'is-active', '--quiet', 'wg-quick@hackfed0.service'],
    ])
  })

  test('propagates systemctl restart failures', async () => {
    const fixture = await makeService('systemctl', command => command[1] === 'restart'
      ? { exitCode: 1, stderr: 'unit failed', stdout: '' }
      : { exitCode: 0, stderr: '', stdout: 'unit contents' })

    const error = await getRejectedError(fixture.service.start())
    expect(error.message).toContain('unit failed')
  })

  test('propagates wg-quick up failures while tolerating an inactive down', async () => {
    process.env.HFD_SKIP_PREFLIGHT_CHECKS = '1'
    const fixture = await makeService('cmd', command => command[1] === 'up'
      ? { exitCode: 1, stderr: 'up failed', stdout: '' }
      : { exitCode: 1, stderr: 'not active', stdout: '' })

    const error = await getRejectedError(fixture.service.start())
    expect(error.message).toContain('up failed')
  })
})

async function getRejectedError (promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('Expected promise to reject')
}

async function makeService (
  strategy: 'cmd' | 'systemctl',
  resultForCommand: (command: readonly string[]) => {
    exitCode: number
    stderr: string
    stdout: string
  } = () => ({ exitCode: 0, stderr: '', stdout: 'ok' }),
  writeFile?: (targetPath: string, contents: string) => Promise<boolean>
): Promise<{ commands: string[][], outputPath: string, service: WireGuard }> {
  const server = Bun.serve({
    fetch: () => Response.json(wireguardDirectory),
    hostname: '127.0.0.1',
    port: getTestPort(),
  })
  servers.push(server)
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'hackfedd-wireguard-'))
  temporaryDirectories.push(outputDirectory)
  const outputPath = path.join(outputDirectory, 'hackfed0.conf')
  const config = ConfigSchema.parse({
    general: {
      directory: `http://127.0.0.1:${server.port}`,
      ignored_orgs: ['skip'],
      org_id: 'xkem',
    },
    wireguard: {
      address: 'fd79:7636:1f08:883d::101',
      output: {
        type: 'wgquick',
        wgquick: { path: outputPath, strategy },
      },
      private_key: PRIVATE_KEY,
    },
  })
  const directory = new Directory({
    directory: {
      refreshIntervalSeconds: 3600,
      root: config.general.directory,
    },
    kind: 'wireguard',
    parentLogger: testLogger,
    schema: WireguardDirectorySchema,
  })
  const commands: string[][] = []
  const service = new WireGuard(testLogger, config, {
    directory,
    runCommand: command => {
      commands.push([...command])
      return Promise.resolve(resultForCommand(command))
    },
    ...(writeFile && { writeFile }),
  })

  return { commands, outputPath, service }
}
