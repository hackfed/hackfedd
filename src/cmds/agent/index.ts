import type { Command } from 'commander'
import type { Logger } from 'tslog'

import type { Config } from '@/lib/config/config.schema'

import { Asterisk } from '@/lib/asterisk'
import { ConfigLoader } from '@/lib/config'
import { WireGuard } from '@/lib/wireguard'

export interface AgentService {
  start: () => Promise<void>
  stop: () => Promise<void> | void
}

export interface AgentServiceFactories {
  asterisk: (logger: Logger<unknown>, config: Config) => AgentService
  wireguard: (logger: Logger<unknown>, config: Config) => AgentService
}

interface CommandOptions {
  config: string
}

const defaultFactories: AgentServiceFactories = {
  asterisk: (logger, config) => new Asterisk(logger, config),
  wireguard: (logger, config) => new WireGuard(logger, config),
}

export async function agent (options: CommandOptions, logger: Logger<unknown>) {
  const configService = new ConfigLoader(logger, options.config)
  const config = await configService.load()
  const services = await startConfiguredServices(config, logger)

  if (services.length === 0) {
    logger.warn('no services are enabled')
    return
  }

  listenForShutdown(services, logger)
}

export default function register (program: Command, rootLogger: Logger<unknown>) {
  program.command('agent')
    .description('Starts the Hackfed agent')
    .option('-c, --config <file>', 'Path to the configuration file', 'config.yaml')
    .action((options: CommandOptions) => agent(options, rootLogger))
}

export async function startConfiguredServices (
  config: Config,
  logger: Logger<unknown>,
  factories: AgentServiceFactories = defaultFactories
): Promise<AgentService[]> {
  const services: AgentService[] = []

  if (config.wireguard) {
    logger.debug('enabling WireGuard')
    services.push(factories.wireguard(logger, config))
  }
  if (config.telephony?.output?.type === 'asterisk') {
    logger.debug('enabling Asterisk')
    services.push(factories.asterisk(logger, config))
  }

  const started: AgentService[] = []
  try {
    for (const service of services) {
      await service.start()
      started.push(service)
    }
  } catch (error) {
    await stopServices(started)
    throw error
  }

  return started
}

function listenForShutdown (services: AgentService[], logger: Logger<unknown>): void {
  let isStopping = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isStopping) {
      return
    }

    isStopping = true
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    logger.info(`received ${signal}; stopping directory pollers`)
    try {
      await stopServices(services)
    } catch (error: unknown) {
      logger.error('failed to stop services cleanly', error)
      process.exitCode = 1
    }
  }
  const onSigint = () => {
    void shutdown('SIGINT')
  }
  const onSigterm = () => {
    void shutdown('SIGTERM')
  }

  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
}

async function stopServices (services: readonly AgentService[]): Promise<void> {
  let firstFailure: unknown
  for (const service of services.toReversed()) {
    try {
      await service.stop()
    } catch (error) {
      firstFailure ??= error
    }
  }

  if (firstFailure instanceof Error) {
    throw firstFailure
  }
  if (firstFailure) {
    throw new Error('Failed to stop one or more services', { cause: firstFailure })
  }
}
