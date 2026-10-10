import { Inject, Injectable } from '@nestjs/common';
import {
  ProviderAdapter,
  SourceDefinition,
} from '../core/provider/provider-adapter';

export const PROVIDER_ADAPTERS = Symbol('ProviderAdapters');

@Injectable()
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(@Inject(PROVIDER_ADAPTERS) adapters: ProviderAdapter[]) {
    for (const adapter of adapters) {
      // Two adapters with one name would make runs ambiguous: refuse to boot.
      if (this.adapters.has(adapter.name)) {
        throw new Error(`Duplicate provider adapter "${adapter.name}"`);
      }
      this.adapters.set(adapter.name, adapter);
    }
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  get(name: string): ProviderAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`Unknown provider "${name}"`);
    return adapter;
  }

  source(name: string, collection: string): SourceDefinition<unknown> {
    const source = this.get(name).sources.find(
      (s) => s.collection === collection,
    );
    if (!source)
      throw new Error(`Provider "${name}" has no source "${collection}"`);
    return source;
  }
}
