import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { writeFileAtomic } from '@/lib/common/atomic-file'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { force: true, recursive: true })
  }
  temporaryDirectories.length = 0
})

describe('atomic file output', () => {
  test('creates parents, replaces changed contents, and skips unchanged files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hackfedd-atomic-'))
    temporaryDirectories.push(directory)
    const target = path.join(directory, 'nested', 'config.conf')

    expect(await writeFileAtomic(target, 'first\n')).toBeTrue()
    expect(await writeFileAtomic(target, 'first\n')).toBeFalse()
    expect(await writeFileAtomic(target, 'second\n')).toBeTrue()
    expect(await Bun.file(target).text()).toBe('second\n')
    expect(await readdir(path.dirname(target))).toEqual(['config.conf'])
  })

  test('enforces an explicit mode even when contents are unchanged', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hackfedd-atomic-'))
    temporaryDirectories.push(directory)
    const target = path.join(directory, 'config.conf')

    await writeFileAtomic(target, 'contents\n')
    const initialStats = await stat(target)
    expect(initialStats.mode & 0o777).toBe(0o600)

    await chmod(target, 0o600)
    expect(await writeFileAtomic(target, 'contents\n', { mode: 0o644 })).toBeFalse()
    const repairedStats = await stat(target)
    expect(repairedStats.mode & 0o777).toBe(0o644)
  })
})
