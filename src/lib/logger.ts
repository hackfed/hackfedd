import { Logger } from 'tslog'

export function getLogger (name: string) {
  return new Logger({
    name,
    pretty: {
      enabled: true,
      template: '{{rawIsoStr}} {{logLevelName}}\t{{nameWithDelimiterSuffix}}'
    }
  })
}
