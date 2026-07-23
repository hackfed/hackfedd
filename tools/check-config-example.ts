import { YAML } from 'bun'
import path from 'node:path'

import { ConfigSchema } from '@/lib/config/config.schema'

const raw = await Bun
  .file(path.resolve(import.meta.dir, '../examples/config.example.yaml'))
  .text()

const contents = YAML.parse(raw)
const parsed = ConfigSchema.strict().parse(contents)

console.dir(
  parsed,
  {
    colors: true,
    depth: null,
  }
)
