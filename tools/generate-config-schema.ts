import { kebabCase } from 'change-case'
import { z } from 'zod'

import { ConfigSchema } from '@/lib/config/config.schema'

const version = 'v1'

const registry = z.registry()
registry.add(ConfigSchema, { id: 'Configuration' })

const jsonSchema = ConfigSchema.toJSONSchema({
  // @ts-expect-error ts(2353) -- something is wrong with Zod's type inference.
  external: {
    registry,
    uri: (referenceId: string) => `https://hfd.hackfed.org/${version}/${kebabCase(referenceId)}.json`
  },
  target: 'draft-2020-12'
})

console.log(JSON.stringify(jsonSchema, null, 2))
