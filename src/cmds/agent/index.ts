import type { Command } from 'commander'
import type { Logger } from 'tslog'

import { Configuration } from '@/lib/config'
import { WireGuard } from '@/lib/wireguard'

interface CommandOptions {
  config: string
}

export async function agent (options: CommandOptions, logger: Logger<unknown>) {
  const configService = new Configuration(logger, options.config)
  const config = await configService.load()

  if (config.wireguard) {
    logger.debug('enabling WireGuard')

    const wireguard = new WireGuard(logger, config)
    wireguard.start()
  }
}

export default function register (program: Command, rootLogger: Logger<unknown>) {
  program.command('agent')
    .description('Starts the Hackfed agent')
    .option('-c, --config <file>', 'Path to the configuration file', 'config.yaml')
    .action((options: CommandOptions) => agent(options, rootLogger))
}
