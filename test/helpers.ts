import type { TelephonyDirectory } from '@hackfed/schemas/v1'

import { TelephonyDirectorySchema } from '@hackfed/schemas/v1'
import { randomInt } from 'node:crypto'
import { Logger } from 'tslog'

export const testLogger = new Logger({ type: 'hidden' })

export async function getRejectedError (promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('Expected promise to reject')
}

export function getTestPort (): number {
  return randomInt(20_000, 60_000)
}

export const telephonyDirectory: TelephonyDirectory = TelephonyDirectorySchema.parse({
  orgs: [
    {
      exchanges: [{
        codecs: ['opus', 'g722', 'ulaw'],
        endpoint: '[fd79:7636:1f08:883d::101]:4569',
        id: 'primary',
        prefix: '+7509101',
        protocol: 'iax2',
      }],
      name: 'Hacker Embassy',
      orgId: 'xkem',
    },
    {
      exchanges: [{
        codecs: ['ulaw', 'g722'],
        endpoint: '[fd79:7636:1f08:883d::8]:4569',
        id: 'primary',
        prefix: '+7509008',
        protocol: 'iax2',
      }],
      name: 'B4CKSP4CE',
      orgId: 'bksp',
    },
    {
      exchanges: [{
        codecs: ['opus'],
        endpoint: '192.0.2.9:4570',
        id: 'primary',
        prefix: '+12025550123',
        protocol: 'iax2',
      }],
      // eslint-disable-next-line no-template-curly-in-string
      name: 'FAB20"]\n#include evil;${SHELL(id)}',
      orgId: 'fab20',
    },
    {
      exchanges: [{
        codecs: ['opus'],
        endpoint: '192.0.2.66:4569',
        id: 'primary',
        prefix: '+9990000',
        protocol: 'iax2',
      }],
      name: 'Ignored Org',
      orgId: 'skip',
    },
  ],
})
