import { YAML } from 'bun'
import { describe, expect, test } from 'bun:test'

import { checkConfig } from '@/cmds/check-config'
import { ConfigSchema } from '@/lib/config/config.schema'

describe('configuration schema', () => {
  test('applies documented telephony and AMI defaults', () => {
    const config = ConfigSchema.parse({
      general: { org_id: 'xkem' },
      telephony: {
        output: {
          asterisk: {
            reload: {
              ami: { secret: 'secret' },
              type: 'ami+http',
            },
          },
          type: 'asterisk',
        },
      },
    })

    expect(config.general.directory).toBe('https://directory.hackfed.org')
    expect(config.general.ignored_orgs).toEqual([])
    expect(config.telephony?.org_exchange_id).toBe('primary')
    expect(config.telephony?.output?.asterisk.directory).toBe('/data/asterisk-configs')
    expect(config.telephony?.output?.asterisk.reload?.ami).toEqual({
      secret: 'secret',
      uri: 'http://asterisk:8088/manager',
      username: 'hackfedd',
    })
  })

  test('requires ami.secret and rejects the old password fallback', () => {
    const base = {
      general: { org_id: 'xkem' },
      telephony: {
        output: {
          asterisk: {
            reload: {
              ami: {},
              type: 'ami+http',
            },
          },
          type: 'asterisk',
        },
      },
    }

    expect(ConfigSchema.safeParse(base).success).toBeFalse()
    expect(ConfigSchema.safeParse({
      ...base,
      telephony: {
        output: {
          asterisk: {
            reload: {
              ami: { password: 'legacy', secret: 'valid' },
              type: 'ami+http',
            },
          },
          type: 'asterisk',
        },
      },
    }).success).toBeFalse()
  })

  test('keeps the example YAML valid under strict parsing', async () => {
    const contents = await Bun.file(new URL('../examples/config.example.yaml', import.meta.url)).text()
    const config = ConfigSchema.parse(YAML.parse(contents))

    expect(config.wireguard?.output.wgquick.strategy).toBe('cmd')
    expect(config.telephony?.output?.asterisk.reload?.ami.username).toBe('hackfedd')
  })

  test('does not log secrets while checking a valid configuration', async () => {
    const entries: unknown[][] = []
    const debug = (...arguments_: unknown[]) => { entries.push(arguments_) }
    const logger = {
      debug,
      getSubLogger: () => ({ debug }),
      info: (...arguments_: unknown[]) => { entries.push(arguments_) },
    }

    await checkConfig({ config: 'examples/config.example.yaml' }, logger as never)

    const output = JSON.stringify(entries)
    expect(output).not.toContain('PrivateKeyHere==')
    expect(output).not.toContain('replace-with-a-strong-generated-secret')
  })
})
