import type { Logger } from 'tslog'

import { type WireguardDirectory, WireguardDirectorySchema } from '@hackfed/schemas/v1'
import { Eta } from 'eta'
import { access, constants, mkdir } from 'node:fs/promises'
import path from 'node:path'

import type { Config } from '@/lib/config/config.schema'

import type { ConfigWireguard } from './config.schema'

import { writeFileAtomic } from '../common/atomic-file'
import { Directory, type DirectoryEventHandler } from '../common/directory'
import {
  type EndpointFailure,
  filterWireguardDirectory,
  type HostnameResolver,
  quarantineUnresolvableWireguardEndpoints,
  resolveHostname,
} from './peers'
import defaultTemplate from './templates/wg-quick.eta' with { type: 'text' }

export { filterWireguardDirectory, quarantineUnresolvableWireguardEndpoints } from './peers'
export type { HostnameResolver } from './peers'

export interface CommandResult {
  exitCode: number
  stderr: string
  stdout: string
}

export type CommandRunner = (command: readonly string[]) => Promise<CommandResult>
export interface WireGuardDependencies {
  directory?: Directory<WireguardDirectory>
  resolveHostname?: HostnameResolver
  runCommand?: CommandRunner
  writeFile?: AtomicWriter
}

type AtomicWriter = (targetPath: string, contents: string) => Promise<boolean>
interface RenderedWireGuard {
  contents: string
  failures: EndpointFailure[]
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
  // A failed reload is retried even if the next render produces the same file.
  private pendingReload = false
  private readonly resolveHostname: HostnameResolver
  private readonly runCommand: CommandRunner
  private started = false
  private readonly wgConfig: ConfigWireguard
  private readonly writeFile: AtomicWriter

  private get systemdUnit (): string {
    return `wg-quick@${this.wgConfig.interface_name}.service`
  }

  constructor (
    parentLogger: Logger<unknown>,
    private readonly config: Config,
    dependencies: WireGuardDependencies = {}
  ) {
    this.logger = parentLogger.getSubLogger({ name: 'WireGuard' })

    if (!config.wireguard) {
      throw new Error('WireGuard configuration is missing')
    }
    this.wgConfig = config.wireguard

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

    try {
      if (this.wgConfig.output.wgquick.strategy === 'cmd') {
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
          ['systemctl', 'cat', this.systemdUnit],
          'locate the wg-quick systemd unit'
        )
      }

      const outputPath = this.wgConfig.output.wgquick.path
      const outputDirectory = path.dirname(outputPath)
      await mkdir(outputDirectory, { recursive: true })
      await access(outputDirectory, constants.W_OK)
      if (await Bun.file(outputPath).exists()) {
        await access(outputPath, constants.W_OK)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Error during wg-quick pre-flight check: ${message}`)
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
    if (this.wgConfig.output.wgquick.strategy === 'cmd') {
      const down = await this.runCommand(['wg-quick', 'down', this.wgConfig.interface_name])
      if (down.exitCode === 0) {
        this.logger.info('WireGuard interface brought down successfully')
      } else {
        this.logger.warn('failed to bring down WireGuard interface; it might not have been up', down)
      }

      await this.execute(['wg-quick', 'up', this.wgConfig.interface_name], 'bring up the WireGuard interface')
      this.logger.info('WireGuard interface brought up successfully')
    } else {
      const active = await this.runCommand(['systemctl', 'is-active', '--quiet', this.systemdUnit])
      if (isConfigChanged) {
        await this.restartSystemdUnit()
        this.logger.info('WireGuard interface restarted successfully via systemctl')
      } else if (active.exitCode === 0) {
        this.logger.info('WireGuard interface is already active with the current configuration')
      } else {
        await this.execute(['systemctl', 'start', this.systemdUnit], 'start the WireGuard systemd unit')
        this.logger.info('WireGuard interface started successfully via systemctl')
      }
    }
  }

  private readonly onDirectoryChanged: DirectoryEventHandler<WireguardDirectory> = async ({ data }) => {
    this.logger.info('WireGuard directory updated')
    return this.applyWgQuick(data)
  }

  private async reloadWgQuick (): Promise<void> {
    if (this.wgConfig.output.wgquick.strategy === 'cmd') {
      await this.execute([
        'bash',
        '-c',
        'exec wg syncconf "$1" <(exec wg-quick strip "$1")',
        'hackfedd-wg-reload',
        this.wgConfig.interface_name,
      ], 'reload the WireGuard configuration')
      this.logger.info('WireGuard configuration reloaded successfully')
    } else {
      // wg-quick@.service does not implement ExecReload.
      await this.restartSystemdUnit()
      this.logger.info('WireGuard configuration restarted successfully via systemctl')
    }
  }

  private async renderWgQuick (contents: WireguardDirectory): Promise<RenderedWireGuard> {
    const template = this.wgConfig.template_path
      ? await Bun.file(this.wgConfig.template_path).text()
      : defaultTemplate
    const filtered = filterWireguardDirectory(
      contents,
      this.wgConfig.address,
      this.config.general.ignored_orgs
    )
    const resolved = await quarantineUnresolvableWireguardEndpoints(filtered, this.resolveHostname)
    for (const failure of resolved.failures) {
      this.logger.warn('quarantining WireGuard peer with an unavailable endpoint', failure)
    }

    return {
      contents: this.eta.renderString(template, {
        address: this.wgConfig.address,
        listenPort: this.wgConfig.listen_port,
        orgs: resolved.directory.orgs,
        privateKey: this.wgConfig.private_key,
      }),
      failures: resolved.failures,
    }
  }

  private async restartSystemdUnit (): Promise<void> {
    await this.execute(
      ['systemctl', 'restart', this.systemdUnit],
      'restart the WireGuard systemd unit'
    )
  }

  private async writeConfig (contents: string): Promise<boolean> {
    const isChanged = await this.writeFile(this.wgConfig.output.wgquick.path, contents)
    if (!isChanged) {
      this.logger.debug('on-disk configuration is up-to-date, skipping write')
    }
    return isChanged
  }
}
