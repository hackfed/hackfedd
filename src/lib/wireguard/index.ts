import type { Logger } from 'tslog'

import { type WireguardDirectory, WireguardDirectorySchema } from '@hackfed/schemas/v1'
import { Eta } from 'eta'
import { lookup } from 'node:dns/promises'
import { access, constants, mkdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'

import type { Config } from '@/lib/config/config.schema'

import { writeFileAtomic } from '../common/atomic-file'
import { Directory, type DirectoryEventHandler } from '../common/directory'
import defaultTemplate from './templates/wg-quick.eta' with { type: 'text' }

export interface CommandResult {
  exitCode: number
  stderr: string
  stdout: string
}

export type CommandRunner = (command: readonly string[]) => Promise<CommandResult>
export type HostnameResolver = (hostname: string) => Promise<void>
export interface WireGuardDependencies {
  directory?: Directory<WireguardDirectory>
  resolveHostname?: HostnameResolver
  runCommand?: CommandRunner
  writeFile?: AtomicWriter
}

type AtomicWriter = (targetPath: string, contents: string) => Promise<boolean>
interface EndpointFailure {
  address: string
  endpoint: string
  message: string
  orgId: string
}
interface RenderedWireGuard {
  contents: string
  failures: EndpointFailure[]
}

async function resolveHostname (hostname: string): Promise<void> {
  await lookup(hostname)
}

async function runCommand (command: readonly string[]): Promise<CommandResult> {
  const process = Bun.spawn([...command], {
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ])

  return { exitCode, stderr, stdout }
}

export class WireGuard {
  private readonly directory: Directory<WireguardDirectory>
  private readonly eta = new Eta()
  private readonly logger: Logger<unknown>
  private pendingReload = false
  private readonly resolveHostname: HostnameResolver
  private readonly runCommand: CommandRunner
  private started = false
  private readonly writeFile: AtomicWriter

  constructor (
    parentLogger: Logger<unknown>,
    private readonly config: Config,
    dependencies: WireGuardDependencies = {}
  ) {
    this.logger = parentLogger.getSubLogger({ name: 'WireGuard' })

    if (!config.wireguard) {
      throw new Error('WireGuard configuration is missing')
    }

    this.directory = dependencies.directory ?? new Directory({
      directory: {
        refreshIntervalSeconds: config.general.directory_refresh_interval,
        root: config.general.directory,
      },
      kind: 'wireguard',
      parentLogger: this.logger,
      schema: WireguardDirectorySchema,
    })
    this.runCommand = dependencies.runCommand ?? runCommand
    this.resolveHostname = dependencies.resolveHostname ?? resolveHostname
    this.writeFile = dependencies.writeFile ?? writeFileAtomic
  }

  public async start (): Promise<void> {
    if (this.started) {
      return
    }

    await this.assertWgQuick()
    const directory = await this.directory.get()
    const rendered = await this.renderWgQuick(directory)
    const isConfigChanged = await this.writeConfig(rendered.contents)
    await this.initWgQuick(isConfigChanged)
    this.pendingReload = false
    if (rendered.failures.length > 0) {
      this.directory.retryCurrent()
    }

    this.directory.on('changed', this.onDirectoryChanged)
    this.directory.startPolling()
    this.started = true
  }

  public stop (): void {
    this.directory.off('changed', this.onDirectoryChanged)
    this.directory.stopPolling()
    this.started = false
  }

  private async applyWgQuick (contents: WireguardDirectory): Promise<boolean> {
    const rendered = await this.renderWgQuick(contents)
    if (await this.writeConfig(rendered.contents)) {
      this.pendingReload = true
    }

    if (this.pendingReload) {
      await this.reloadWgQuick()
      this.pendingReload = false
    }

    return rendered.failures.length === 0
  }

  private async assertWgQuick (): Promise<void> {
    if (process.env.HFD_SKIP_PREFLIGHT_CHECKS) {
      this.logger.warn('skipping pre-flight checks because HFD_SKIP_PREFLIGHT_CHECKS is set')
      return
    }

    const wireguard = this.config.wireguard
    if (!wireguard) {
      throw new Error('WireGuard configuration is missing')
    }

    try {
      if (wireguard.output.wgquick.strategy === 'cmd') {
        if (!Bun.which('wg-quick')) {
          throw new Error('wg-quick not found in PATH')
        }
        if (!Bun.which('wg')) {
          throw new Error('wg not found in PATH')
        }
        if (!Bun.which('bash')) {
          throw new Error('bash not found in PATH')
        }

        const wg = await this.execute(['wg', '--version'], 'read the wg version')
        this.logger.debug('using wg version', wg.stdout.trim())
        const bash = await this.execute(['bash', '--version'], 'read the bash version')
        this.logger.debug('using bash version', bash.stdout.split('\n', 1)[0]?.trim())
      } else {
        // `systemctl status` fails for a valid but inactive unit. `cat` verifies
        // that the unit exists without requiring it to already be running.
        await this.execute(
          ['systemctl', 'cat', `wg-quick@${wireguard.interface_name}.service`],
          'locate the wg-quick systemd unit'
        )
      }

      const outputPath = wireguard.output.wgquick.path
      const outputDirectory = path.dirname(outputPath)
      await mkdir(outputDirectory, { recursive: true })
      await access(outputDirectory, constants.W_OK)
      if (await Bun.file(outputPath).exists()) {
        await access(outputPath, constants.W_OK)
      }
    } catch (error) {
      throw new Error(`Error during wg-quick pre-flight check: ${getErrorMessage(error)}`)
    }
  }

  private async execute (command: readonly string[], action: string): Promise<CommandResult> {
    const result = await this.runCommand(command)
    if (result.exitCode !== 0) {
      throw new Error(`Failed to ${action} (exit ${result.exitCode}): ${result.stderr.trim()}`)
    }
    return result
  }

  private async initWgQuick (isConfigChanged: boolean): Promise<void> {
    const wireguard = this.config.wireguard
    if (!wireguard) {
      throw new Error('WireGuard configuration is missing')
    }

    if (wireguard.output.wgquick.strategy === 'cmd') {
      const down = await this.runCommand(['wg-quick', 'down', wireguard.interface_name])
      if (down.exitCode === 0) {
        this.logger.info('WireGuard interface brought down successfully')
      } else {
        this.logger.warn('failed to bring down WireGuard interface; it might not have been up', down)
      }

      await this.execute(['wg-quick', 'up', wireguard.interface_name], 'bring up the WireGuard interface')
      this.logger.info('WireGuard interface brought up successfully')
    } else {
      const unit = `wg-quick@${wireguard.interface_name}.service`
      const active = await this.runCommand(['systemctl', 'is-active', '--quiet', unit])
      if (isConfigChanged) {
        await this.restartSystemdUnit()
        this.logger.info('WireGuard interface restarted successfully via systemctl')
      } else if (active.exitCode === 0) {
        this.logger.info('WireGuard interface is already active with the current configuration')
      } else {
        await this.execute(['systemctl', 'start', unit], 'start the WireGuard systemd unit')
        this.logger.info('WireGuard interface started successfully via systemctl')
      }
    }
  }

  private readonly onDirectoryChanged: DirectoryEventHandler<WireguardDirectory, 'changed'> = async ({ data }) => {
    this.logger.info('WireGuard directory updated')
    return this.applyWgQuick(data)
  }

  private async reloadWgQuick (): Promise<void> {
    const wireguard = this.config.wireguard
    if (!wireguard) {
      throw new Error('WireGuard configuration is missing')
    }

    if (wireguard.output.wgquick.strategy === 'cmd') {
      await this.execute([
        'bash',
        '-c',
        'exec wg syncconf "$1" <(exec wg-quick strip "$1")',
        'hackfedd-wg-reload',
        wireguard.interface_name,
      ], 'reload the WireGuard configuration')
      this.logger.info('WireGuard configuration reloaded successfully')
    } else {
      // wg-quick@.service does not implement ExecReload.
      await this.restartSystemdUnit()
      this.logger.info('WireGuard configuration restarted successfully via systemctl')
    }
  }

  private async renderWgQuick (contents: WireguardDirectory): Promise<RenderedWireGuard> {
    const wireguard = this.config.wireguard
    if (!wireguard) {
      throw new Error('WireGuard configuration is missing')
    }

    const template = wireguard.template_path
      ? await Bun.file(wireguard.template_path).text()
      : defaultTemplate
    const filtered = filterWireguardDirectory(
      contents,
      wireguard.address,
      this.config.general.ignored_orgs
    )
    const resolved = await quarantineUnresolvableWireguardEndpoints(filtered, this.resolveHostname)
    for (const failure of resolved.failures) {
      this.logger.warn('quarantining WireGuard peer with an unavailable endpoint', failure)
    }

    return {
      contents: this.eta.renderString(template, {
        address: wireguard.address,
        listenPort: wireguard.listen_port,
        orgs: resolved.directory.orgs,
        privateKey: wireguard.private_key,
      }),
      failures: resolved.failures,
    }
  }

  private async restartSystemdUnit (): Promise<void> {
    const wireguard = this.config.wireguard
    if (!wireguard) {
      throw new Error('WireGuard configuration is missing')
    }

    await this.execute(
      ['systemctl', 'restart', `wg-quick@${wireguard.interface_name}.service`],
      'restart the WireGuard systemd unit'
    )
  }

  private async writeConfig (contents: string): Promise<boolean> {
    const outputPath = this.config.wireguard?.output.wgquick.path
    if (!outputPath) {
      throw new Error('WireGuard output path is missing')
    }

    const isChanged = await this.writeFile(outputPath, contents)
    if (!isChanged) {
      this.logger.debug('on-disk configuration is up-to-date, skipping write')
    }
    return isChanged
  }
}

export function filterWireguardDirectory (
  contents: WireguardDirectory,
  localAddress: string,
  ignoredOrgs: readonly string[] = []
): WireguardDirectory {
  const ignored = new Set(ignoredOrgs)
  const normalizedLocalAddress = normalizeIpv6Address(localAddress)

  const orgs = contents.orgs
    .filter(org => !ignored.has(org.orgId))
    .map(org => ({
      ...org,
      name: sanitizeWireguardComment(org.name),
      peers: org.peers
        .filter(peer => normalizeIpv6Address(peer.address) !== normalizedLocalAddress)
        .toSorted((left, right) => left.address.localeCompare(right.address)),
    }))
    .filter(org => org.peers.length > 0)
    .toSorted((left, right) => left.orgId.localeCompare(right.orgId))

  return { orgs }
}

export async function quarantineUnresolvableWireguardEndpoints (
  contents: WireguardDirectory,
  resolver: HostnameResolver = resolveHostname
): Promise<{ directory: WireguardDirectory, failures: EndpointFailure[] }> {
  const resolutions = new Map<string, Promise<void>>()
  const results = await Promise.all(contents.orgs.map(org => quarantineOrganization(org, resolver, resolutions)))

  return {
    directory: {
      orgs: results
        .map(result => result.org)
        .filter(org => org.peers.length > 0),
    },
    failures: results.flatMap(result => result.failures),
  }
}

function getErrorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeIpv6Address (address: string): string {
  const addressWithoutPrefix = address.split('/', 1)[0]
  if (!addressWithoutPrefix) {
    throw new Error(`Invalid IPv6 address "${address}"`)
  }

  const hostname = new URL(`http://[${addressWithoutPrefix}]`).hostname
  return hostname.slice(1, -1)
}

function parseEndpointHostname (endpoint: string): string {
  const bracketed = /^\[([^\]]+)]:(\d{1,5})$/.exec(endpoint)
  const hostname = /^([^:]+):(\d{1,5})$/.exec(endpoint)
  const match = bracketed ?? hostname
  const host = match?.[1]
  const port = Number(match?.[2])
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid WireGuard endpoint "${endpoint}"`)
  }
  return host
}

async function quarantineOrganization (
  org: WireguardDirectory['orgs'][number],
  resolver: HostnameResolver,
  resolutions: Map<string, Promise<void>>
): Promise<{ failures: EndpointFailure[], org: WireguardDirectory['orgs'][number] }> {
  const failures: EndpointFailure[] = []
  const peers = []

  for (const peer of org.peers) {
    if (!peer.endpoint) {
      peers.push(peer)
      continue
    }

    try {
      const hostname = parseEndpointHostname(peer.endpoint)
      if (isIP(hostname) === 0) {
        let resolution = resolutions.get(hostname)
        if (!resolution) {
          resolution = resolver(hostname)
          resolutions.set(hostname, resolution)
        }
        await resolution
      }
      peers.push(peer)
    } catch (error) {
      failures.push({
        address: peer.address,
        endpoint: peer.endpoint,
        message: getErrorMessage(error),
        orgId: org.orgId,
      })
    }
  }

  return { failures, org: { ...org, peers } }
}

function sanitizeWireguardComment (value: string): string {
  return value
    .replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim() || 'Unknown organization'
}
