import { z } from 'zod'

import { ConfigTelephonySchema } from '../asterisk/config.schema'
import { ConfigWireguardSchema } from '../wireguard/config.schema'

export const ConfigGeneralSchema = z
  .object({
    directory: z
      .url()
      .default('https://directory.hackfed.org')
      .meta({
        description: 'Root URL of the HackFed Directory service.',
        title: 'Directory URL',
      }),
    directory_refresh_interval: z
      .int()
      .min(1)
      .default(900)
      .meta({
        description: 'Interval in seconds to refresh data from the HackFed Directory.',
        name: 'Directory Refresh Interval',
      }),
    ignored_orgs: z
      .array(z.string().min(1))
      .default([])
      .meta({
        description: 'List of organization IDs to avoid peering with.',
        name: 'Ignored Organizations',
      }),
    org_id: z
      .string()
      .min(1)
      .meta({
        description: 'ID of the organization associated with this instance.',
        title: 'Organization ID',
      }),
  }).strict().meta({
    description: 'Common configuration options.',
    title: 'General Configuration',
  })
export type ConfigGeneral = z.infer<typeof ConfigGeneralSchema>

export const ConfigSchema = z
  .object({
    general: ConfigGeneralSchema,
    telephony: ConfigTelephonySchema.optional(),
    wireguard: ConfigWireguardSchema.optional(),
  }).strict().meta({
    description: 'Configuration schema for Hackfed Daemon (hackfedd).',
    id: 'Configuration',
    title: 'HackFed Configuration',
  })

export type Config = z.infer<typeof ConfigSchema>
