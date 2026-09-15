import type { Logger } from 'tslog'

import { JSDOM } from 'jsdom'
import { parse as parseSetCookie } from 'set-cookie-parser'

import type { AsteriskConfigAmiHttpReload } from './config.schema'
import type { AsteriskModule } from './render'

export interface AmiResponse {
  fields: Map<string, string>
  response: Response
}

export interface AsteriskReloader {
  reload: (modules: readonly AsteriskModule[]) => Promise<void>
}

type Fetch = typeof globalThis.fetch

/** AMI-over-HTTP client for both Asterisk /manager and /rawman endpoints. */
export class AmiHttpClient implements AsteriskReloader {
  private readonly logger: Logger<unknown>

  constructor (
    parentLogger: Logger<unknown>,
    private readonly config: AsteriskConfigAmiHttpReload['ami'],
    private readonly fetchImplementation: Fetch = fetch
  ) {
    this.logger = parentLogger.getSubLogger({ name: 'AMI' })
  }

  public async reload (modules: readonly AsteriskModule[]): Promise<void> {
    if (modules.length === 0) {
      return
    }

    const sessionCookie = await this.login()
    let failure: unknown

    try {
      for (const module of modules) {
        await this.request({
          Action: 'Reload',
          Module: module,
        }, sessionCookie)
        this.logger.info('reloaded Asterisk module', module)
      }
    } catch (error) {
      failure = error
    } finally {
      // Keep a reload error as the primary failure if logoff also fails.
      try {
        await this.request({ Action: 'Logoff' }, sessionCookie)
      } catch (error) {
        if (failure) {
          this.logger.warn('failed to log off AMI session after another AMI failure', error)
        } else {
          failure = error
        }
      }
    }

    if (failure) {
      if (failure instanceof Error) {
        throw failure
      }
      throw new Error('AMI reload failed', { cause: failure })
    }
  }

  private async login (): Promise<string> {
    const { response } = await this.request({
      Action: 'Login',
      Secret: this.config.secret,
      Username: this.config.username,
    })

    const cookieHeader = response.headers.get('set-cookie') ?? ''
    const session = parseSetCookie(cookieHeader)
      .find(cookie => cookie.name === 'mansession_id')

    if (!session?.value) {
      throw new Error('AMI login succeeded but no mansession_id cookie was returned')
    }

    return `mansession_id=${session.value}`
  }

  private async request (
    fields: Record<string, string>,
    sessionCookie?: string
  ): Promise<AmiResponse> {
    const body = new URLSearchParams(fields)

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    if (sessionCookie) {
      headers.Cookie = sessionCookie
    }

    const response = await this.fetchImplementation(this.config.uri, {
      body,
      headers,
      method: 'POST',
    })
    if (!response.ok) {
      throw new Error(`AMI HTTP request failed with status ${response.status}`)
    }

    const parsed = parseAmiResponse(await response.text())
    if (parsed.get('Response') !== 'Success' && parsed.get('Response') !== 'Goodbye') {
      const message = parsed.get('Message') ?? 'response did not contain a success status'
      throw new Error(`AMI ${fields.Action ?? 'request'} failed: ${message}`)
    }

    return { fields: parsed, response }
  }
}

export function parseAmiResponse (body: string): Map<string, string> {
  const parsed = /<(?:html|table|tr|td)\b/i.test(body)
    ? parseHtmlAmiResponse(body)
    : parseRawAmiResponse(body)

  if (parsed.size === 0) {
    throw new Error('AMI response parsing failed: no response fields found')
  }

  return parsed
}

function parseHtmlAmiResponse (body: string): Map<string, string> {
  const parsed = new Map<string, string>()
  const { document } = new JSDOM(body).window
  for (const row of document.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('th, td')
    if (cells.length < 2) {
      continue
    }

    const name = cells.item(0).textContent.trim()
    const value = cells.item(1).textContent.trim()
    if (name && value) {
      parsed.set(name.replace(/:$/, ''), value)
    }
  }
  return parsed
}

function parseRawAmiResponse (body: string): Map<string, string> {
  const parsed = new Map<string, string>()
  for (const line of body.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator > 0) {
      parsed.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
    }
  }
  return parsed
}
