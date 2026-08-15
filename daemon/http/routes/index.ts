import type { HttpRoute } from '../router.js'
import { createGenerationPreflightRoute } from './generationPreflight.js'
import { createHealthRoute } from './health.js'
import { createProjectionPlanReadRoute } from './projectionPlans.js'
import { createRuntimeRoute } from './runtime.js'

/** Ordered bounded-context routes mounted before legacy delegation. */
export function createBoundedHttpRoutes(): HttpRoute[] {
  return [
    createHealthRoute(),
    createRuntimeRoute(),
    createGenerationPreflightRoute(),
    createProjectionPlanReadRoute(),
  ]
}
