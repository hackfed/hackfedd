import type { Logger } from 'tslog'
import type z from 'zod'

import ky, { type KyInstance } from 'ky'

export interface DirectoryConfig<T> {
  apiClient?: KyInstance

  directory: {
    refreshIntervalSeconds: number
    root: string
  }
  kind: string
  parentLogger: Logger<unknown>
  schema: z.ZodType<T>
}

export type DirectoryEventHandler<T, K extends keyof DirectoryEvents<T>> =
  (event: DirectoryEvents<T>[K]) => Promise<void> | void

export type DirectoryEvents<T> = {
  changed: {
    data: T
  }
}

export interface DirectoryMeta {
  lastEtag?: string | undefined
  lastFetched?: number
}

/**
 * Validated, retry-safe local replica of one Hackfed directory document.
 */
export class Directory<T> {
  private readonly apiClient: KyInstance
  private data: null | T = null
  private readonly handlers = new Set<DirectoryEventHandler<T, 'changed'>>()
  private readonly logger: Logger<unknown>
  private meta: DirectoryMeta = {}
  private polling = false
  private timerId: ReturnType<typeof setTimeout> | undefined
  private updatePromise: Promise<boolean> | undefined

  private get isExpired (): boolean {
    if (!this.meta.lastFetched) {
      return true
    }

    const elapsed = Date.now() - this.meta.lastFetched
    return elapsed > this.config.directory.refreshIntervalSeconds * 1000
  }

  constructor (private readonly config: DirectoryConfig<T>) {
    this.apiClient = config.apiClient ?? ky.create({
      prefix: this.config.directory.root,
    })

    this.logger = this.config.parentLogger.getSubLogger({ name: 'Directory' })
  }

  public async get (): Promise<T> {
    if (this.isExpired) {
      await this.update()
    }

    if (this.data === null) {
      throw new Error(`${this.config.kind} directory returned no data`)
    }

    return this.data
  }

  public off (
    _event: 'changed',
    handler: DirectoryEventHandler<T, 'changed'>
  ): void {
    this.handlers.delete(handler)
  }

  public on (
    _event: 'changed',
    handler: DirectoryEventHandler<T, 'changed'>
  ): void {
    this.handlers.add(handler)
  }

  public startPolling (): void {
    if (this.polling) {
      return
    }

    this.polling = true
    this.scheduleNextPoll()
  }

  public stopPolling (): void {
    this.polling = false
    if (this.timerId) {
      clearTimeout(this.timerId)
      this.timerId = undefined
    }
  }

  public async update (): Promise<boolean> {
    if (this.updatePromise) {
      return this.updatePromise
    }

    const updatePromise = this.performUpdate()
    this.updatePromise = updatePromise

    try {
      return await updatePromise
    } finally {
      if (this.updatePromise === updatePromise) {
        this.updatePromise = undefined
      }
    }
  }

  private async performUpdate (): Promise<boolean> {
    this.logger.debug('updating...')

    const headers: Record<string, string> = {}
    if (this.meta.lastEtag) {
      headers['If-None-Match'] = this.meta.lastEtag
    }

    const response = await this.apiClient.get(`${this.config.kind}.json`, {
      headers,
      throwHttpErrors (status) {
        return status !== 304
      },
    })

    if (response.status === 304) {
      this.meta.lastFetched = Date.now()
      this.logger.debug('directory data is up-to-date')
      return false
    }

    const candidate = this.config.schema.parse(await response.json())

    // Applying the candidate is part of acknowledging it. If a handler fails,
    // preserve the previous ETag so the same document is fetched and retried.
    for (const handler of this.handlers) {
      await handler({ data: candidate })
    }

    this.data = candidate
    this.meta = {
      lastEtag: response.headers.get('etag') ?? undefined,
      lastFetched: Date.now(),
    }

    this.logger.debug('directory data updated. New etag:', this.meta.lastEtag)
    return true
  }

  private async pollOnce (): Promise<void> {
    try {
      await this.update()
    } catch (error) {
      this.logger.error('failed to update directory data:', error)
    } finally {
      this.timerId = undefined
      this.scheduleNextPoll()
    }
  }

  private scheduleNextPoll (): void {
    if (!this.polling) {
      return
    }

    this.timerId = setTimeout(() => {
      void this.pollOnce()
    }, this.config.directory.refreshIntervalSeconds * 1000)
  }
}
