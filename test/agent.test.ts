import { describe, expect, test } from 'bun:test'

import type { AgentService } from '@/cmds/agent'

import { startConfiguredServices } from '@/cmds/agent'
import { ConfigSchema } from '@/lib/config/config.schema'

import { getRejectedError, testLogger } from './helpers'

describe('agent service lifecycle', () => {
  test('awaits startup failures and stops services that already started', async () => {
    const events: string[] = []
    const wireguard: AgentService = {
      start: () => {
        events.push('wireguard:start')
        return Promise.resolve()
      },
      stop: () => { events.push('wireguard:stop') },
    }
    const asterisk: AgentService = {
      start: () => {
        events.push('asterisk:start')
        return Promise.reject(new Error('asterisk failed'))
      },
      stop: () => { events.push('asterisk:stop') },
    }
    const config = ConfigSchema.parse({
      general: { org_id: 'xkem' },
      telephony: {
        output: {
          asterisk: {},
          type: 'asterisk',
        },
      },
      wireguard: {
        address: 'fd79:7636:1f08:883d::101',
        output: {
          type: 'wgquick',
          wgquick: {},
        },
        private_key: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      },
    })

    const error = await getRejectedError(startConfiguredServices(config, testLogger, {
      asterisk: () => asterisk,
      wireguard: () => wireguard,
    }))
    expect(error.message).toContain('asterisk failed')
    expect(events).toEqual(['wireguard:start', 'asterisk:start', 'wireguard:stop'])
  })
})
