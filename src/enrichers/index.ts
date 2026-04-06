/**
 * Framework enricher registry.
 *
 * All enrichers are registered here and executed in order by the orchestrator
 * after core parsing and graph building is complete.
 */

export { FrameworkEnricher, EnrichedFrameworkData } from './enricher.interface';
export { DjangoEnricher } from './django-enricher';
export { FastAPIEnricher } from './fastapi-enricher';
export { NuxtEnricher } from './nuxt-enricher';
export { ExpressEnricher } from './express-enricher';
export { NextjsEnricher } from './nextjs-enricher';

import { FrameworkEnricher } from './enricher.interface';
import { DjangoEnricher } from './django-enricher';
import { FastAPIEnricher } from './fastapi-enricher';
import { NuxtEnricher } from './nuxt-enricher';
import { ExpressEnricher } from './express-enricher';
import { NextjsEnricher } from './nextjs-enricher';

/**
 * Get all registered framework enrichers.
 * Order matters: enrichers run in registration order.
 */
export function getAllEnrichers(): FrameworkEnricher[] {
  return [
    new DjangoEnricher(),
    new FastAPIEnricher(),
    new NuxtEnricher(),
    new ExpressEnricher(),
    new NextjsEnricher(),
  ];
}
