import type { EndpointConfig } from './types';

export function endpointName(endpoint: EndpointConfig, fallback = endpoint.model.trim() || endpoint.id): string {
  return endpoint.alias?.trim() || fallback;
}
