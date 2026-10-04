import type { EndpointConfig } from './types';

export function endpointName(endpoint: EndpointConfig, fallback = endpoint.model.trim() || `端点 ${endpoint.id}`): string {
  return endpoint.alias?.trim() || fallback;
}
