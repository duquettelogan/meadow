import { handleDnsQuery } from '../dns/handler';

/**
 * DoH endpoint adapter.
 *
 * Thin wrapper around the unified DNS handler. The DoH protocol just
 * carries DNS message bytes inside HTTP — once the body is unwrapped,
 * it's the same query/response cycle as UDP.
 */
export async function handleDoH(body: Buffer): Promise<Buffer> {
  return handleDnsQuery(body);
}
