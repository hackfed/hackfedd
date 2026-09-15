import type { TelephonyDirectory } from '@hackfed/schemas/v1'
import type { Logger } from 'tslog'

import { TelephonyDirectorySchema } from '@hackfed/schemas/v1'
import { chmod, mkdir } from 'node:fs/promises'
import path from 'node:path'

import type { Config } from '@/lib/config/config.schema'

import { writeFileAtomic } from '../common/atomic-file'
import { Directory, type DirectoryEventHandler } from '../common/directory'
import { AmiHttpClient, type AsteriskReloader } from './ami'
import {
  type AsteriskArtifacts,
  type AsteriskModule,
  buildAsteriskModel,
  renderAsteriskArtifacts,
} from './render'

export interface AsteriskDependencies {
  directory?: Directory<TelephonyDirectory>
  reloader?: AsteriskReloader
  writeFile?: AtomicWriter
}

type AtomicWriter = (targetPath: string, contents: string) => Promise<boolean>

const MODULE_ORDER: readonly AsteriskModule[] = ['chan_iax2.so', 'pbx_config.so']
const ASTERISK_CONFIG_DIRECTORY_MODE = 0o755
const ASTERISK_CONFIG_MODE = 0o644
const ARTIFACTS: readonly { module: AsteriskModule; name: keyof AsteriskArtifacts, }[] = [
  { module: 'pbx_config.so', name: 'extensions-inbound.conf' },
  { module: 'pbx_config.so', name: 'extensions-outbound.conf' },
  { module: 'chan_iax2.so', name: 'iax.conf' },
]

export class Asterisk {
  private readonly directory: Directory<TelephonyDirectory>
  private readonly logger: Logger<unknown>
  private readonly outputDirectory: string
  // A failed AMI reload is retried even when the generated files are unchanged.
  private readonly pendingReloads = new Set<AsteriskModule>()
  private readonly reloader: AsteriskReloader | undefined
  private started = false
  private readonly writeFile: AtomicWriter

  constructor (
    parentLogger: Logger<unknown>,
    private readonly config: Config,
    dependencies: AsteriskDependencies = {}
  ) {
    this.logger = parentLogger.getSubLogger({ name: 'Asterisk' })

    const asteriskConfig = config.telephony?.output?.asterisk
    if (!asteriskConfig) {
      throw new Error('Asterisk telephony output configuration is missing')
    }

    this.outputDirectory = asteriskConfig.directory
    this.directory = dependencies.directory ?? new Directory({
      directory: {
        refreshIntervalSeconds: config.general.directory_refresh_interval,
        root: config.general.directory,
      },
      kind: 'telephony',
      parentLogger: this.logger,
      schema: TelephonyDirectorySchema,
    })
    this.reloader = dependencies.reloader ?? (asteriskConfig.reload
      ? new AmiHttpClient(this.logger, asteriskConfig.reload.ami)
      : undefined)
    this.writeFile = dependencies.writeFile ?? ((targetPath, contents) =>
      writeFileAtomic(targetPath, contents, { mode: ASTERISK_CONFIG_MODE }))
  }

  public async start (): Promise<void> {
    if (this.started) {
      return
    }

    await mkdir(this.outputDirectory, { mode: ASTERISK_CONFIG_DIRECTORY_MODE, recursive: true })
    await chmod(this.outputDirectory, ASTERISK_CONFIG_DIRECTORY_MODE)
    const directory = await this.directory.get()
    await this.apply(directory, true)

    this.directory.on('changed', this.onDirectoryChanged)
    this.directory.startPolling()
    this.started = true
  }

  public stop (): void {
    this.directory.off('changed', this.onDirectoryChanged)
    this.directory.stopPolling()
    this.started = false
  }

  private async apply (directory: TelephonyDirectory, isStartup: boolean): Promise<void> {
    const model = buildAsteriskModel(directory, {
      exchangeId: this.config.telephony?.org_exchange_id ?? 'primary',
      ignoredOrgs: this.config.general.ignored_orgs,
      orgId: this.config.general.org_id,
    })
    const artifacts = renderAsteriskArtifacts(model)

    if (isStartup && this.reloader) {
      for (const module of MODULE_ORDER) {
        this.pendingReloads.add(module)
      }
    }

    await this.writeArtifacts(artifacts)
    await this.reloadPendingModules(isStartup)
  }

  private readonly onDirectoryChanged: DirectoryEventHandler<TelephonyDirectory> = async ({ data }) => {
    this.logger.info('telephony directory updated')
    await this.apply(data, false)
  }

  private async reloadPendingModules (isStartup: boolean): Promise<void> {
    if (!this.reloader) {
      if (isStartup) {
        this.logger.warn('Asterisk reload is not configured; generated files must be reloaded by the operator')
      }
      return
    }

    const modules = MODULE_ORDER.filter(module => this.pendingReloads.has(module))
    if (modules.length === 0) {
      return
    }

    await this.reloader.reload(modules)
    for (const module of modules) {
      this.pendingReloads.delete(module)
    }
  }

  private async writeArtifacts (artifacts: AsteriskArtifacts): Promise<void> {
    for (const { module, name } of ARTIFACTS) {
      const targetPath = path.join(this.outputDirectory, name)
      if (await this.writeFile(targetPath, artifacts[name])) {
        this.logger.info('wrote generated Asterisk configuration', targetPath)
        if (this.reloader) {
          this.pendingReloads.add(module)
        }
      } else {
        this.logger.debug('generated Asterisk configuration is unchanged', targetPath)
      }
    }
  }
}
