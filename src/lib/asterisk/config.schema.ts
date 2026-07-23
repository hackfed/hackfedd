import { z } from 'zod'

export const AsteriskConfigAmiHttpReloadSchema = z
  .object({
    ami: z.object({
      secret: z
        .string()
        .min(1)
        .default('password')
        .meta({
          description: 'The secret/password for AMI authentication.',
          title: 'AMI Secret',
        }),
      uri: z
        .url()
        .default('http://asterisk:8088/manager')
        .meta({
          description: 'The AMI HTTP endpoint URI.',
          title: 'AMI HTTP URI',
        }),
      username: z
        .string()
        .min(1)
        .default('admin')
        .meta({
          description: 'The username for AMI authentication.',
          title: 'AMI Username',
        }),
    }),
    type: z.literal('ami+http'),
  }).meta({
    description: 'Configuration for reloading Asterisk via AMI over HTTP.',
    title: 'Asterisk AMI HTTP Reload Configuration',
  })

export type AsteriskConfigAmiHttpReload = z.infer<typeof AsteriskConfigAmiHttpReloadSchema>

export const AsteriskConfigReloadSchema = z.discriminatedUnion('type', [
  AsteriskConfigAmiHttpReloadSchema,
]).meta({
  description: 'Configuration for reloading Asterisk.',
  title: 'Asterisk Reload Configuration',
})

export type AsteriskConfigReload = z.infer<typeof AsteriskConfigReloadSchema>

export const AsteriskOutputConfigSchema = z
  .object({
    directory: z
      .string()
      .min(1)
      .default('/data/asterisk-configs')
      .meta({
        description: 'Filesystem directory to store generated Asterisk configuration files.',
        title: 'Asterisk Configuration Directory',
      }),
    reload: AsteriskConfigReloadSchema.optional(),
  }).meta({
    description: 'Configuration options for Asterisk telephony integration.',
    title: 'Asterisk Configuration',
  })

export type AsteriskOutputConfig = z.infer<typeof AsteriskOutputConfigSchema>

export const ConfigTelephonyOutputSchema = z.object({
  asterisk: AsteriskOutputConfigSchema,
  type: z.literal('asterisk'),
})

export const ConfigTelephonySchema = z
  .object({
    org_exchange_id: z
      .string()
      .min(1)
      .default('primary')
      .optional()
      .meta({
        description: 'Exchange ID of this Hackfed instance within the organization.',
        name: 'Organization Exchange ID',
      }),
    output: ConfigTelephonyOutputSchema
      .optional()
      .meta({
        description: 'Configuration for telephony output integration.',
        name: 'Telephony Output Configuration',
      }),
  }).meta({
    description: 'Telephony service configuration.',
    title: 'Telephony Configuration',
  })
export type ConfigTelephony = z.infer<typeof ConfigTelephonySchema>
