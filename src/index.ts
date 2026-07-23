#!/usr/bin/env bun
import { Command } from 'commander'

import registerAgent from './cmds/agent'
import registerCheckConfig from './cmds/check-config'
import { getLogger } from './lib/logger'

const program = new Command()
const rootLogger = getLogger('HFD')

program
  .name('hackfedd')
  .description('Hackfed Daemon')
  .version(process.env.npm_package_version ?? '0.0.0')

// Register commands
registerCheckConfig(program, rootLogger)
registerAgent(program, rootLogger)

program.parse()
