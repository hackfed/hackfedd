import { z } from 'zod'

export const WgQuickOutputConfigSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .default('/etc/wireguard/hackfed0.conf')
      .meta({
        description: 'Path to which hackfedd will render the WireGuard configuration file.',
        title: 'wg-quick Configuration Path',
      }),
    reload: z.enum(['cmd'])
      .default('cmd')
      .meta({
        description: 'Reload strategy for WireGuard configuration after rendering the template.',
        title: 'wg-quick Reload Strategy',
      }),
  }).meta({
    description: 'Configuration options for wg-quick WireGuard output integration.',
    title: 'wg-quick Configuration',
  })

export type WgQuickOutputConfig = z.infer<typeof WgQuickOutputConfigSchema>

export const ConfigWireguardOutputSchema = z.object({
  type: z
    .enum(['wgquick'])
    .meta({
      description: 'The type of WireGuard output integration.',
      title: 'WireGuard Output Type',
    }),
  wgquick: WgQuickOutputConfigSchema,
}).meta({
  description: 'Output configuration for WireGuard service.',
  title: 'WireGuard Output Strategy',
})

export type ConfigWireguardOutput = z.infer<typeof ConfigWireguardOutputSchema>

export const ConfigWireguardSchema = z
  .object({
    address: z.ipv6().meta({
      description: 'The IPv6 address assigned to this node.',
      title: 'WireGuard in-tunnel IP Address',
    }),
    interface_name: z.string().min(1).default('hackfed0').meta({
      description: 'The name of the WireGuard network interface.',
      title: 'WireGuard Interface Name',
    }),
    listen_port: z.number().int().min(1).max(65_535).nullable().default(null).meta({
      description: 'The port on which the WireGuard interface listens. Null to disable listening.',
      title: 'WireGuard Listen Port',
    }),
    output: ConfigWireguardOutputSchema,
    private_key: z.base64().meta({
      description: 'The private key for the WireGuard interface.',
      title: 'WireGuard Private Key',
    }),
    template_path: z
      .string()
      .min(1)
      .optional()
      .meta({
        description: 'Path to a custom Eta template for the WireGuard configuration file. Uses a default template if not present.',
        title: 'WireGuard Template Path',
      }),
  }).meta({
    description: 'Configuration for the WireGuard interface.',
    title: 'WireGuard Configuration',
  })

export type ConfigWireguard = z.infer<typeof ConfigWireguardSchema>
