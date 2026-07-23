import type { Logger } from 'tslog'

import { YAML } from 'bun'
import path from 'node:path'

import { type Config, ConfigSchema } from './config.schema'
export class Configuration {
  private configPath: string
  private logger: Logger<unknown>

  constructor (
    parentLogger: Logger<unknown>,
    configPath: string
  ) {
    this.configPath = path.resolve(process.cwd(), configPath)
    this.logger = parentLogger.getSubLogger({ name: 'Configuration' })
  }

  async load (): Promise<Config> {
    this.logger.debug('Using configuration: %s', this.configPath)
    const file = await Bun.file(this.configPath).text()
    const config = ConfigSchema.parse(YAML.parse(file))
    this.logger.debug('Successfully loaded configuration for: %s', config.general.org_id)
    return config
  }
}
