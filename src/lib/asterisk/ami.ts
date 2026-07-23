import { JSDOM } from 'jsdom'
import ky from 'ky'
import { parse as parseSetCookie } from 'set-cookie-parser'

import type { AmiResponse } from './interface'

const api = ky.create({
  prefix: 'http://ninetails:8088/manager',
})

/**
 * Retrieves an authenticated session cookie.
 * @returns Session cookie string.
 */
export async function getAuthenticatedSessionCookie (): Promise<string> {
  const authPayload = new URLSearchParams()
  authPayload.set('action', 'login')
  authPayload.set('username', 'hackfedd')
  authPayload.set('secret', 'your_generated_password_here')

  const { response } = await makeAmiRequest(authPayload)
  const authCookies = parseSetCookie(response.headers.getAll('set-cookie'))
  const session = authCookies.find(cookie => cookie.name === 'mansession_id')?.value
  if (!session) {
    throw new Error('Failed to retrieve session cookie from Asterisk AMI')
  }

  return `mansession_id=${session}`
}

/**
 * Makes a POST request to AMI via the HTTP interface.
 * @param data Data to send in the request body.
 * @param options Additional request options.
 * @returns Response from the AMI.
 */
export async function makeAmiRequest<T = unknown> (
  data: URLSearchParams,
  options: RequestInit = {}
): Promise<AmiResponse<T>> {
  const response = await api.post<T>('.', {
    ...options,
    body: data.toString(),
    headers: {
      ...options.headers,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
  })

  const { window } = new JSDOM(await response.text())
  const rows = window.document.querySelector('tbody')?.childNodes
  if (!rows) {
    throw new Error('AMI response parsing failed: No table body found')
  }

  const result = new Map(
    [...rows]
      .filter(node => node.nodeName === 'TR')
      .map(row => {
        const [name, value] = [...row.childNodes].map(cell => cell.textContent)
        if (!name || !value) {
          return null
        }
        return [name, value]
      })
      .filter((row): row is [string, string] => row !== null)
  )

  if (result.get('Response') !== 'Success') {
    throw new Error(`AMI request returned non-success response: ${result.get('Message') ?? [...result.values()]}`)
  }

  return {
    amiResponseTable: result,
    document: window.document,
    response,
  }
}

/**
 * Reloads the IAX2 and dialplan configuration via AMI.
 */
export async function reload (): Promise<void> {
  const sessionCookie = await getAuthenticatedSessionCookie()
  const options: RequestInit = {
    headers: {
      Cookie: sessionCookie,
    }
  }

  const iaxReloadPayload = new URLSearchParams()
  iaxReloadPayload.set('action', 'command')
  iaxReloadPayload.set('command', 'iax2 reload')

  const dialplanReloadPayload = new URLSearchParams()
  dialplanReloadPayload.set('action', 'command')
  dialplanReloadPayload.set('command', 'dialplan reload')

  await makeAmiRequest(iaxReloadPayload, options)
  await makeAmiRequest(dialplanReloadPayload, options)
}
