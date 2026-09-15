import type { WireguardDirectory } from '@hackfed/schemas/v1'

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface EndpointFailure {
  address: string
  endpoint: string
  message: string
  orgId: string
}

export type HostnameResolver = (hostname: string) => Promise<void>

export function filterWireguardDirectory (
  contents: WireguardDirectory,
  localAddress: string,
  ignoredOrgs: readonly string[] = []
): WireguardDirectory {
  const ignored = new Set(ignoredOrgs)
  const normalizedLocalAddress = normalizeIpv6Address(localAddress)
  const orgs: WireguardDirectory['orgs'] = []

  for (const org of contents.orgs) {
    if (ignored.has(org.orgId)) {
      continue
    }

    const peers = org.peers
      .filter(peer => normalizeIpv6Address(peer.address) !== normalizedLocalAddress)
      .toSorted((left, right) => left.address.localeCompare(right.address))
    if (peers.length > 0) {
      orgs.push({ ...org, name: sanitizeWireguardComment(org.name), peers })
    }
  }

  return { orgs: orgs.toSorted((left, right) => left.orgId.localeCompare(right.orgId)) }
}

export async function quarantineUnresolvableWireguardEndpoints (
  contents: WireguardDirectory,
  resolver: HostnameResolver = resolveHostname
): Promise<{ directory: WireguardDirectory, failures: EndpointFailure[] }> {
  const resolutions = new Map<string, Promise<void>>()
  const checkedOrgs = await Promise.all(contents.orgs.map(org =>
    quarantineOrganizationEndpoints(org, resolver, resolutions)))
  const orgs: WireguardDirectory['orgs'] = []
  const failures: EndpointFailure[] = []

  for (const checked of checkedOrgs) {
    failures.push(...checked.failures)
    if (checked.org.peers.length > 0) {
      orgs.push(checked.org)
    }
  }

  return { directory: { orgs }, failures }
}

export async function resolveHostname (hostname: string): Promise<void> {
  await lookup(hostname)
}

function getErrorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeIpv6Address (address: string): string {
  const addressWithoutPrefix = address.split('/', 1)[0]
  if (!addressWithoutPrefix) {
    throw new Error(`Invalid IPv6 address "${address}"`)
  }

  const hostname = new URL(`http://[${addressWithoutPrefix}]`).hostname
  return hostname.slice(1, -1)
}

function parseEndpointHostname (endpoint: string): string {
  const bracketed = /^\[([^\]]+)]:(\d{1,5})$/.exec(endpoint)
  const hostname = /^([^:]+):(\d{1,5})$/.exec(endpoint)
  const match = bracketed ?? hostname
  const host = match?.[1]
  const port = Number(match?.[2])
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid WireGuard endpoint "${endpoint}"`)
  }
  return host
}

async function quarantineOrganizationEndpoints (
  org: WireguardDirectory['orgs'][number],
  resolver: HostnameResolver,
  resolutions: Map<string, Promise<void>>
): Promise<{ failures: EndpointFailure[], org: WireguardDirectory['orgs'][number] }> {
  const peers: typeof org.peers = []
  const failures: EndpointFailure[] = []

  for (const peer of org.peers) {
    if (peer.endpoint) {
      try {
        await verifyEndpoint(peer.endpoint, resolver, resolutions)
        peers.push(peer)
      } catch (error) {
        failures.push({
          address: peer.address,
          endpoint: peer.endpoint,
          message: getErrorMessage(error),
          orgId: org.orgId,
        })
      }
    } else {
      peers.push(peer)
    }
  }

  return { failures, org: { ...org, peers } }
}

function sanitizeWireguardComment (value: string): string {
  return value
    .replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim() || 'Unknown organization'
}

async function verifyEndpoint (
  endpoint: string,
  resolver: HostnameResolver,
  resolutions: Map<string, Promise<void>>
): Promise<void> {
  const hostname = parseEndpointHostname(endpoint)
  if (isIP(hostname) !== 0) {
    return
  }

  let resolution = resolutions.get(hostname)
  if (!resolution) {
    resolution = resolver(hostname)
    resolutions.set(hostname, resolution)
  }
  await resolution
}
