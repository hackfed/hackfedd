import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface AtomicFileOptions {
  mode?: number
}

/**
 * Atomically replaces a file when its contents have changed.
 */
export async function writeFileAtomic (
  targetPath: string,
  contents: string,
  options: AtomicFileOptions = {}
): Promise<boolean> {
  const target = Bun.file(targetPath)
  let existingMode: number | undefined
  if (await target.exists()) {
    const existingStats = await stat(targetPath)
    existingMode = existingStats.mode & 0o777
  }

  if (existingMode !== undefined && await target.text() === contents) {
    if (options.mode !== undefined && existingMode !== options.mode) {
      await chmod(targetPath, options.mode)
    }
    return false
  }

  const directory = path.dirname(targetPath)
  await mkdir(directory, { recursive: true })

  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${randomUUID()}.tmp`)
  try {
    const targetMode = options.mode ?? existingMode ?? 0o600
    await writeFile(temporaryPath, contents, { mode: targetMode })
    await chmod(temporaryPath, targetMode)
    await rename(temporaryPath, targetPath)
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch {
      // Nothing to clean up if the temporary file was never created.
    }
    throw error
  }

  return true
}
