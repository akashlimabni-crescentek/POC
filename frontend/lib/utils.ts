import type { ProviderRef } from './types';

export function pickRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export function pickProvider(value: ProviderRef | ProviderRef[] | null | undefined): ProviderRef | null {
  return pickRelation(value);
}
