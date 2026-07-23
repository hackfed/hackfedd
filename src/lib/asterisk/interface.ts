import type { KyResponse } from 'ky'

/**
 * Represents the response from an AMI-over-HTTP request.
 */
export interface AmiResponse<T = unknown> {
  /**
   * Key-value map of the AMI response table.
   */
  amiResponseTable: Map<string, string>,

  /**
   * DOM document parsed from the AMI response.
   */
  document: Document,

  /**
   * Network response from HTTP client.
   */
  response: KyResponse<T>,
}
