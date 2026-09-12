import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Atomically replaces a file when its contents have changed.
 */
export async function writeFileAtomic (targetPath: string, contents: string): Promise<boolean> {
  const target = Bun.file(targetPath)
  if (await target.exists() && await target.text() === contents) {
    return false
  }

  const directory = path.dirname(targetPath)
  await mkdir(directory, { recursive: true })

  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${randomUUID()}.tmp`)
  try {
    let existingMode = 0o600
    try {
      const existingStats = await stat(targetPath)
      existingMode = existingStats.mode & 0o777
    } catch {
      // New generated configuration defaults to owner-only permissions.
    }
    await writeFile(temporaryPath, contents, { mode: existingMode })
    await chmod(temporaryPath, existingMode)
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
