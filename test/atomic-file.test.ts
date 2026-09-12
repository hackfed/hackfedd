import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
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
})
