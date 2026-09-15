import type { TelephonyDirectory } from '@hackfed/schemas/v1'

import { describe, expect, test } from 'bun:test'

import {
  buildAsteriskModel,
  makePeerName,
  parseEndpoint,
  renderAsteriskArtifacts,
} from '@/lib/asterisk/render'

import { telephonyDirectory } from './helpers'

/* eslint-disable no-template-curly-in-string -- these are literal Asterisk variable expressions. */

const options = {
  exchangeId: 'primary',
  ignoredOrgs: ['skip'],
  orgId: 'xkem',
}

describe('Asterisk rendering', () => {
  test('renders stable peers and safe, prefix-independent dialplans', async () => {
    const model = buildAsteriskModel(telephonyDirectory, options)
    const artifacts = renderAsteriskArtifacts(model)
    const localPeer = makePeerName('xkem', 'primary')
    const bkspPeer = makePeerName('bksp', 'primary')
    const fabPeer = makePeerName('fab20', 'primary')

    expect(model.localPrefix).toBe('7509101')
    expect(model.localPeerName).toBe(localPeer)
    expect(model.localShortName).toBe('xkem')
    expect(model.peers.map(peer => peer.peerName)).toEqual([bkspPeer, fabPeer])
    expect(model.peers[0]).toMatchObject({
      codecs: ['g722', 'ulaw'],
      host: 'fd79:7636:1f08:883d::8',
      port: 4569,
      prefix: '7509008',
      shortName: 'bksp',
    })
    expect(model.peers[1]).toMatchObject({
      codecs: ['opus'],
      host: '192.0.2.9',
      port: 4570,
      prefix: '12025550123',
      shortName: 'fab20',
    })

    for (const name of ['iax.conf', 'extensions-inbound.conf', 'extensions-outbound.conf'] as const) {
      const expected = await Bun.file(new URL(`fixtures/asterisk/${name}`, import.meta.url)).text()
      expect(artifacts[name]).toBe(expected)
    }

    expect(artifacts['iax.conf']).not.toContain('skip')
    expect(artifacts['extensions-inbound.conf']).not.toContain('#include evil')
    expect(artifacts['extensions-inbound.conf']).not.toContain('${SHELL(id)}')
  })

  test('uses a wildcard that permits exact-prefix and subscriber calls', () => {
    const inbound = renderAsteriskArtifacts(buildAsteriskModel(telephonyDirectory, options))['extensions-inbound.conf']

    expect(inbound).toContain('exten => _7509101!,1,')
    expect(inbound).toContain('${HF_DESTINATION:7}')
    expect(inbound).toContain('FILTER(0-9,${EXTEN})')
    expect(inbound).toContain('${LEN(${HF_DESTINATION})} = ${LEN(${EXTEN})}')
  })

  test('uses the local exchange identity as the IAX username on reciprocal peers', () => {
    const xkemArtifacts = renderAsteriskArtifacts(buildAsteriskModel(telephonyDirectory, options))
    const bkspArtifacts = renderAsteriskArtifacts(buildAsteriskModel(telephonyDirectory, {
      ...options,
      ignoredOrgs: ['fab20', 'skip'],
      orgId: 'bksp',
    }))

    expect(xkemArtifacts['iax.conf']).toContain(`username = ${makePeerName('xkem', 'primary')}`)
    expect(bkspArtifacts['iax.conf']).toContain(
      `[${makePeerName('xkem', 'primary')}]\ntype = friend\nusername = ${makePeerName('bksp', 'primary')}`
    )
  })

  test('uses short organization ids for caller and connected-line name prefixes', () => {
    const inbound = renderAsteriskArtifacts(buildAsteriskModel(telephonyDirectory, options))['extensions-inbound.conf']

    expect(inbound).toContain('Set(CALLERID(name)=bksp)')
    expect(inbound).toContain('Set(CALLERID(name)=fab20)')
    expect(inbound).toContain('Set(CONNECTEDLINE(name,i)=xkem: ${HF_CONNECTED_NAME})')
    expect(inbound).not.toContain('Set(CALLERID(name)=B4CKSP4CE)')
    expect(inbound).not.toContain('Set(CALLERID(name)=Hacker Embassy)')
  })

  test('creates distinct names for the same exchange id in different organizations', () => {
    expect(makePeerName('bksp', 'primary')).not.toBe(makePeerName('fab20', 'primary'))
    expect(makePeerName('bksp', 'bad]\nname')).toMatch(/^hf-bksp-bad-name-[a-f0-9]{12}$/)
  })

  test('parses IPv4 and bracketed IPv6 endpoints', () => {
    expect(parseEndpoint('192.0.2.1:4569')).toEqual({ host: '192.0.2.1', port: 4569 })
    expect(parseEndpoint('[2001:db8::1]:1234')).toEqual({ host: '2001:db8::1', port: 1234 })
  })

  test.each([
    'host.example:4569',
    '2001:db8::1:4569',
    '[2001:db8::1]:0',
    '192.0.2.999:4569',
  ])('rejects invalid endpoint %s', (endpoint) => {
    expect(() => parseEndpoint(endpoint)).toThrow()
  })

  test('fails clearly when the local exchange is absent', () => {
    expect(() => buildAsteriskModel(telephonyDirectory, {
      ...options,
      exchangeId: 'missing',
    })).toThrow('xkem/missing')
  })

  test('fails when a remote exchange has no common codec', () => {
    const directory: TelephonyDirectory = structuredClone(telephonyDirectory)
    const remote = directory.orgs.find(org => org.orgId === 'bksp')?.exchanges[0]
    if (!remote) {
      throw new Error('test fixture is missing bksp')
    }
    remote.codecs = ['g722']
    const local = directory.orgs.find(org => org.orgId === 'xkem')?.exchanges[0]
    if (!local) {
      throw new Error('test fixture is missing xkem')
    }
    local.codecs = ['opus']

    expect(() => buildAsteriskModel(directory, options)).toThrow('No common codec')
  })
})
