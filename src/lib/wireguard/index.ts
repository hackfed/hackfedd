import type { Logger } from 'tslog'

import { type WireguardDirectory, WireguardDirectorySchema } from '@hackfed/schemas/v1'
import { Eta } from 'eta'

import type { Config } from '@/lib/config/config.schema'

import type { ConfigWireguard } from './config.schema'

import { Directory } from '../common/directory'
import defaultTemplate from './templates/wg-quick.eta' with { type: 'text' }

export class WireGuard {
  private readonly directory: Directory<WireguardDirectory>
  private readonly eta = new Eta()
  private readonly logger: Logger<unknown>
  private readonly wgConfig: ConfigWireguard

  constructor (
    parentLogger: Logger<unknown>,
    private readonly config: Config
  ) {
    this.logger = parentLogger.getSubLogger({ name: 'WireGuard' })

    this.directory = new Directory({
      directory: {
        refreshIntervalSeconds: this.config.general.directory_refresh_interval,
        root: this.config.general.directory,
      },
      kind: 'wireguard',
      parentLogger: this.logger,
      schema: WireguardDirectorySchema,
    })

    if (!this.config.wireguard) {
      throw new Error('WireGuard configuration is missing')
    }

    this.wgConfig = this.config.wireguard as ConfigWireguard
  }

  /**
   * Starts directory polling and sets proper event handlers
   */
  async start () {
    if (this.wgConfig.output.type === 'wgquick') {
      await this.assertWgQuick()
    }

    this.directory.on('changed', ({ data }) => this.onUpdate(data))
    await this.directory.update()
    this.directory.startPolling()
  }

  /**
   * Applies the WG configuration with wg-quick strategy
   * @param contents WireGuard directory contents
   */
  private async applyWgQuick (contents: WireguardDirectory): Promise<void> {
    const rendered = await this.renderWgQuick(contents)
    await this.writeConfig(rendered)

    // Trigger reload/conf-sync no matter if the file was written or not,
    // as it might help on the configuration mismatch on start-up, and costs basically nothing
    // if the configuration is already up-to-date.
    await this.reloadWgQuickCmd()
  }

  /**
   * Pre-flight check to ensure that all CLI tools required are available, and configuration file is writable.
   */
  private async assertWgQuick (): Promise<void> {
    if (process.env.HFD_SKIP_PREFLIGHT_CHECKS) {
      this.logger.warn('skipping pre-flight checks due to HFD_SKIP_PREFLIGHT_CHECKS env is set')
      return
    }

    // Check if wg & wg-quick are available
    try {
      // Unfortunately, not all distributions contain the wg-quick capable of reporting its version,
      // so we limit this check to verifying its presence in the PATH only
      const wgQuick = await Bun.$`which wg-quick`
      if (wgQuick.exitCode !== 0) {
        throw new Error(`wg-quick not found in PATH: ${wgQuick.stderr}`)
      }

      const wg = await Bun.$`wg --version`
      this.logger.debug('using wg version', wg.stdout.toString().trim())

      // Bash is required due to its capability of creating a virtual pipe file.
      // @todo elaborate on this, check whether there is a better way to do this
      const bash = await Bun.$`bash -c 'echo $BASH_VERSION'`
      if (bash.exitCode !== 0) {
        throw new Error(`bash not found in PATH: ${bash.stderr}`)
      }

      this.logger.debug('using bash version', bash.stdout.toString().trim())
    } catch (error: unknown) {
      throw new Error(`Error during wg-quick pre-flight check: ${error}`)
    }

    // Check if the output file is writable
    const outputFile = Bun.file(this.wgConfig.output.wgquick.path)
    try {
      await Bun.write(outputFile, await outputFile.text())
    } catch (error: unknown) {
      throw new Error(`Error during wg-quick pre-flight check: cannot write to ${this.wgConfig.output.wgquick.path}: ${error}`)
    }
  }

  /**
   * Event handler triggered when the WireGuard directory is updated.
   * @param contents Updated directory contents
   */
  private async onUpdate (contents: WireguardDirectory): Promise<void> {
    this.logger.info('directory updated')

    if (this.wgConfig.output.type === 'wgquick') {
      return this.applyWgQuick(contents)
    }
  }

  /**
   * Reloads the WireGuard configuration using the `wg-quick strip` and `wg syncconf` command.
   */
  private async reloadWgQuickCmd (): Promise<void> {
    const exec = await Bun.$`bash -c 'wg syncconf ${this.wgConfig.interface_name} <(wg-quick strip ${this.wgConfig.interface_name})'`
    if (exec.exitCode === 0) {
      this.logger.info('WireGuard configuration reloaded successfully')
    } else {
      this.logger.error('failed to reload WireGuard configuration', { exitCode: exec.exitCode, stderr: exec.stderr })
    }
  }

  /**
   * Renders the wg-quick configuration file using the provided template and directory contents.
   * If no template path is specified in the configuration, a default template is used.
   * @param contents WireGuard directory to render
   * @returns Rendered wg-quick configuration as a string
   */
  private async renderWgQuick (contents: WireguardDirectory): Promise<string> {
    const template = this.wgConfig.template_path
      ? await Bun.file(this.wgConfig.template_path).text()
      : defaultTemplate

    return this.eta.renderString(template, {
      address: this.wgConfig.address,
      listenPort: this.wgConfig.listen_port,
      orgs: contents.orgs,
      privateKey: this.wgConfig.private_key,
    })
  }

  /**
   * Gently writes the rendered configuration to disk, only if it has changed.
   * @param contents Content to write
   * @returns True, if the file was overwritten, false if it was skipped due to no changes
   */
  private async writeConfig (contents: string): Promise<boolean> {
    const target = Bun.file(this.wgConfig.output.wgquick.path)
    const currentDigest = await target.exists()
      ? Bun.hash(await target.arrayBuffer())
      : null

    const newDigest = Bun.hash(contents)
    if (newDigest === currentDigest) {
      this.logger.debug('on-disk configuration is up-to-date, skipping write')
      return false
    }

    await Bun.write(target, contents)
    return true
  }
}
