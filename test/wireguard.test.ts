import type { WireguardDirectory } from '@hackfed/schemas/v1'

import { WireguardDirectorySchema } from '@hackfed/schemas/v1'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { writeFileAtomic } from '@/lib/common/atomic-file'
import { Directory } from '@/lib/common/directory'
import { ConfigSchema } from '@/lib/config/config.schema'
import { filterWireguardDirectory, quarantineUnresolvableWireguardEndpoints, WireGuard } from '@/lib/wireguard'

import { getRejectedError, getTestPort, testLogger } from './helpers'

const PUBLIC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const PRIVATE_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
const servers: Array<ReturnType<typeof Bun.serve>> = []
const temporaryDirectories: string[] = []
const rejectLookup = (): Promise<void> => Promise.reject(new Error('DNS lookup failed'))

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

  test('validates endpoint hostnames while skipping IP literals', async () => {
    const directory: WireguardDirectory = structuredClone(wireguardDirectory)
    const remote = directory.orgs.find(org => org.orgId === 'bksp')
    if (!remote) {
      throw new Error('test fixture is missing bksp')
    }
    remote.peers.push({
      address: 'fd79:7636:1f08:883d::9/128',
      endpoint: 'evn.dipier.ro:39242',
      publicKey: PUBLIC_KEY,
    })
    const resolved: string[] = []

    const result = await quarantineUnresolvableWireguardEndpoints(directory, hostname => {
      resolved.push(hostname)
      return Promise.resolve()
    })

    expect(resolved).toEqual(['evn.dipier.ro'])
    expect(result.failures).toEqual([])
    expect(result.directory.orgs.find(org => org.orgId === 'bksp')?.peers).toHaveLength(2)
  })

  test('quarantines an unresolvable endpoint without rejecting other peers', async () => {
    const directory: WireguardDirectory = structuredClone(wireguardDirectory)
    const remote = directory.orgs.find(org => org.orgId === 'bksp')
    const peer = remote?.peers[0]
    if (!peer) {
      throw new Error('test fixture is missing bksp peer')
    }
    peer.endpoint = 'evn.dipier.ro:39242'

    const result = await quarantineUnresolvableWireguardEndpoints(directory, rejectLookup)

    expect(result.failures).toEqual([{
      address: 'fd79:7636:1f08:883d::8/128',
      endpoint: 'evn.dipier.ro:39242',
      message: 'DNS lookup failed',
      orgId: 'bksp',
    }])
    expect(result.directory.orgs.find(org => org.orgId === 'bksp')).toBeUndefined()
    expect(result.directory.orgs.find(org => org.orgId === 'xkem')?.peers).toHaveLength(2)
  })

  test('applies healthy peers and retries quarantined DNS endpoints until recovery', async () => {
    const contents: WireguardDirectory = structuredClone(wireguardDirectory)
    const remote = contents.orgs.find(org => org.orgId === 'bksp')
    const peer = remote?.peers[0]
    if (!peer) {
      throw new Error('test fixture is missing bksp peer')
    }
    peer.endpoint = 'evn.dipier.ro:39242'
    let isResolvable = false
    const fixture = await makeService({
      contents,
      resolveHostname: () => isResolvable
        ? Promise.resolve()
        : Promise.reject(new Error('DNS lookup failed')),
      strategy: 'systemctl',
    })

    await fixture.service.start()
    expect(await Bun.file(fixture.outputPath).text()).not.toContain('evn.dipier.ro:39242')

    isResolvable = true
    expect(await fixture.directory.update()).toBeTrue()
    expect(await Bun.file(fixture.outputPath).text()).toContain('evn.dipier.ro:39242')
    expect(await fixture.directory.update()).toBeFalse()
    expect(fixture.commands.filter(command => command[1] === 'restart')).toHaveLength(2)
    fixture.service.stop()
  })

  test('starts an inactive systemd unit when the configuration is unchanged', async () => {
    const fixture = await makeService({
      resultForCommand: command => command[1] === 'is-active'
        ? { exitCode: 3, stderr: '', stdout: 'inactive' }
        : { exitCode: 0, stderr: '', stdout: 'ok' },
      strategy: 'systemctl',
      writeFile: async (targetPath, contents) => {
        await writeFileAtomic(targetPath, contents)
        return false
      },
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
    const fixture = await makeService({ strategy: 'systemctl' })
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
    const fixture = await makeService({
      resultForCommand: command => command[1] === 'restart'
        ? { exitCode: 1, stderr: 'unit failed', stdout: '' }
        : { exitCode: 0, stderr: '', stdout: 'unit contents' },
      strategy: 'systemctl',
    })

    const error = await getRejectedError(fixture.service.start())
    expect(error.message).toContain('unit failed')
  })

  test('propagates wg-quick up failures while tolerating an inactive down', async () => {
    process.env.HFD_SKIP_PREFLIGHT_CHECKS = '1'
    const fixture = await makeService({
      resultForCommand: command => command[1] === 'up'
        ? { exitCode: 1, stderr: 'up failed', stdout: '' }
        : { exitCode: 1, stderr: 'not active', stdout: '' },
      strategy: 'cmd',
    })

    const error = await getRejectedError(fixture.service.start())
    expect(error.message).toContain('up failed')
  })
})

interface ServiceOptions {
  contents?: WireguardDirectory
  resolveHostname?: (hostname: string) => Promise<void>
  resultForCommand?: (command: readonly string[]) => { exitCode: number, stderr: string, stdout: string }
  strategy: 'cmd' | 'systemctl'
  writeFile?: (targetPath: string, contents: string) => Promise<boolean>
}

async function makeService ({
  contents = wireguardDirectory,
  resolveHostname,
  resultForCommand = () => ({ exitCode: 0, stderr: '', stdout: 'ok' }),
  strategy,
  writeFile,
}: ServiceOptions): Promise<{
  commands: string[][]
  directory: Directory<WireguardDirectory>
  outputPath: string
  service: WireGuard
}> {
  const server = Bun.serve({
    fetch: request => request.headers.get('if-none-match') === '"v1"'
      ? new Response(null, { status: 304 })
      : Response.json(contents, { headers: { ETag: '"v1"' } }),
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
    ...(resolveHostname && { resolveHostname }),
    runCommand: command => {
      commands.push([...command])
      return Promise.resolve(resultForCommand(command))
    },
    ...(writeFile && { writeFile }),
  })

  return { commands, directory, outputPath, service }
}
