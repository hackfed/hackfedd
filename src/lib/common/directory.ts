import type { Logger } from 'tslog'
import type z from 'zod'

import ky, { type KyInstance } from 'ky'
import mitt from 'mitt'

export interface DirectoryConfig<T> {
  directory: {
    refreshIntervalSeconds: number
    root: string
  }

  kind: string;
  parentLogger: Logger<unknown>
  schema: z.ZodType<T>
}

export type DirectoryEvents<T> = {
  changed: {
    data: T
  }
}

export interface DirectoryMeta {
  lastEtag?: string | undefined
  lastFetched?: number
}

export class Directory<T> {
  /**
   * HTTP client for interacting with the directory API
   */
  private apiClient: KyInstance

  /**
   * Local replica of the directory data
   */
  private data: null | T = null

  /**
   * Local event bus
   */
  private events = mitt<DirectoryEvents<T>>()

  /**
   * Named logger instance
   */
  private logger: Logger<unknown>

  /**
   * Last-known metadata about the directory
   */
  private meta: DirectoryMeta = {}

  /**
   * Timer ID for the polling interval
   */
  private timerId: NodeJS.Timeout | undefined

  /**
   * Check if the directory data is expired based on the cache interval.
   * @returns True if the data is expired, false otherwise.
   */
  private get isExpired (): boolean {
    if (!this.meta.lastFetched) {
      return true
    }

    if (!this.config.directory.refreshIntervalSeconds) {
      return true
    }

    const elapsed = Date.now() - this.meta.lastFetched
    return elapsed > this.config.directory.refreshIntervalSeconds * 1000
  }

  constructor (
    private config: DirectoryConfig<T>
  ) {
    this.apiClient = ky.create({
      prefix: this.config.directory.root,
    })

    this.logger = this.config.parentLogger.getSubLogger({
      name: 'Directory'
    })
  }

  /**
   * Get the current data of the directory, validated against the schema.
   * @returns The current data of the directory.
   */
  public async get (): Promise<T> {
    if (this.isExpired) {
      await this.update()
    }

    return this.config.schema.parse(this.data)
  }

  /**
   * Unsubscribe from events emitted by the directory controller.
   * @param event Event name
   * @param handler Event handler function
   */
  public off<K extends keyof DirectoryEvents<T>> (
    event: K,
    handler: (event: DirectoryEvents<T>[K]) => void
  ): void {
    this.events.off(event, handler)
  }

  /**
   * Subscribe to events emitted by the directory controller.
   * @param event Event name
   * @param handler Event handler function
   */
  public on<K extends keyof DirectoryEvents<T>> (
    event: K,
    handler: (event: DirectoryEvents<T>[K]) => void
  ): void {
    this.events.on(event, handler)
  }

  /**
   * Enable polling of the directory data.
   */
  public startPolling (): void {
    this.timerId = setInterval(async () => {
      try {
        await this.update()
      } catch (error) {
        this.logger.error('failed to update directory data:', error)
      }
    }, this.config.directory.refreshIntervalSeconds * 1000)
  }

  /**
   * Disable polling of the directory data.
   */
  public stopPolling (): void {
    if (this.timerId) {
      clearInterval(this.timerId)
      this.timerId = undefined
    }
  }

  /**
   * Update the directory data and emit a "changed" event if the data has changed.
   * @returns True if the data has changed, false otherwise.
   */
  public async update (): Promise<boolean> {
    this.logger.debug('updating...')

    const request = await this.apiClient.get(`${this.config.kind}.json`, {
      headers: {
        'If-None-Match': this.meta.lastEtag,
      },
      throwHttpErrors (status) {
        return status !== 304
      },
    })

    // Etag match, so 304 Not Modified. No need to update the data.
    if (request.status === 304) {
      this.meta.lastFetched = Date.now()

      this.logger.debug('directory data is up-to-date')
      return false
    }

    const data = await request.json()
    this.data = this.config.schema.parse(data)

    this.meta.lastEtag = request.headers.get('etag') ?? undefined
    this.meta.lastFetched = Date.now()

    this.events.emit('changed', { data: this.data })
    this.logger.debug('directory data updated. New etag:', this.meta.lastEtag)
    return true
  }
}
