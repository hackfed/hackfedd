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

/** A handler returns false when it applied healthy data but needs this document retried. */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- normal handlers may return nothing.
export type DirectoryEventHandler<T> = (event: { data: T }) => boolean | Promise<boolean | void> | void

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
  private readonly handlers = new Set<DirectoryEventHandler<T>>()
  private readonly logger: Logger<unknown>
  private meta: DirectoryMeta = {}
  private polling = false
  private timerId: ReturnType<typeof setTimeout> | undefined
  // Concurrent callers share one fetch and one application of the document.
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
    handler: DirectoryEventHandler<T>
  ): void {
    this.handlers.delete(handler)
  }

  public on (
    _event: 'changed',
    handler: DirectoryEventHandler<T>
  ): void {
    this.handlers.add(handler)
  }

  /** Force the current document to be fetched again without discarding its data. */
  public retryCurrent (): void {
    this.meta.lastEtag = undefined
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

    // An ETag is acknowledged only after every consumer applies the document.
    // Returning false lets one consumer retry without blocking the others.
    let didAllApply = true
    for (const handler of this.handlers) {
      if (await handler({ data: candidate }) === false) {
        didAllApply = false
      }
    }

    this.data = candidate
    this.meta.lastFetched = Date.now()
    if (didAllApply) {
      this.meta.lastEtag = response.headers.get('etag') ?? undefined
    }

    if (didAllApply) {
      this.logger.debug('directory data updated. New etag:', this.meta.lastEtag)
    } else {
      this.logger.warn('directory data applied partially; leaving ETag pending for retry')
    }
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
