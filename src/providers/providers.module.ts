import { Module } from '@nestjs/common';
import { PROVIDER_ADAPTERS, ProviderRegistry } from './provider-registry';
import { xbyteAdapter } from './xbyte/xbyte.adapter';

// Onboarding a provider = adding its adapter to this list.
@Module({
  providers: [
    { provide: PROVIDER_ADAPTERS, useValue: [xbyteAdapter] },
    ProviderRegistry,
  ],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}
