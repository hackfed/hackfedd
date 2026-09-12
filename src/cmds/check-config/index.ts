import type { Command } from 'commander'
import type { Logger } from 'tslog'

import { ConfigLoader } from '@/lib/config'

interface CommandOptions {
  config: string
}

export async function checkConfig (options: CommandOptions, logger: Logger<unknown>) {
  const configService = new ConfigLoader(logger, options.config)
  await configService.load()

  logger.info('Configuration is valid.')
}

export default function register (program: Command, rootLogger: Logger<unknown>) {
  const logger = rootLogger.getSubLogger({ name: 'CheckConfig' })
  program.command('check-config')
    .description('Check the configuration of the registry')
    .option('-c, --config <file>', 'Path to the configuration file', 'config.yaml')
    .action((options: CommandOptions) => checkConfig(options, logger))
}
