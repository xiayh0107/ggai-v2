const CHECK_KINDS = new Set([
  'selector-count',
  'selector-visible',
  'text-present',
  'text-absent',
])

export function parseUiRenderCatalog(value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('UI render catalog must be an object')
  }
  if (value.schemaVersion !== 2) {
    throw new TypeError('ui-render/scenarios.json must use schemaVersion 2')
  }
  if (!Array.isArray(value.principles) || value.principles.length === 0) {
    throw new TypeError('UI render catalog requires design principles')
  }
  if (!Array.isArray(value.journeys) || value.journeys.length === 0) {
    throw new TypeError('UI render catalog requires journeys')
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    throw new TypeError('UI render catalog requires scenarios')
  }

  assertUniqueIds(value.principles, 'principle')
  assertUniqueIds(value.journeys, 'journey')
  assertUniqueIds(value.scenarios, 'scenario')

  const journeyIds = new Set(value.journeys.map((journey) => journey.id))
  const principleIds = new Set(value.principles.map((principle) => principle.id))
  const stepsByJourney = new Map()

  for (const scenario of value.scenarios) {
    requiredText(scenario.id, 'scenario id')
    requiredText(scenario.title, `${scenario.id} title`)
    requiredText(scenario.description, `${scenario.id} description`)
    requiredText(scenario.journeyId, `${scenario.id} journeyId`)
    requiredText(scenario.readySelector, `${scenario.id} readySelector`)
    if (!journeyIds.has(scenario.journeyId)) {
      throw new TypeError(`${scenario.id} references unknown journey ${scenario.journeyId}`)
    }
    if (!Number.isSafeInteger(scenario.step) || scenario.step < 1) {
      throw new TypeError(`${scenario.id} step must be a positive integer`)
    }
    const usedSteps = stepsByJourney.get(scenario.journeyId) ?? new Set()
    if (usedSteps.has(scenario.step)) {
      throw new TypeError(`${scenario.journeyId} contains duplicate step ${scenario.step}`)
    }
    usedSteps.add(scenario.step)
    stepsByJourney.set(scenario.journeyId, usedSteps)
    if (!scenario.viewport
      || !Number.isSafeInteger(scenario.viewport.width)
      || !Number.isSafeInteger(scenario.viewport.height)
      || scenario.viewport.width < 320
      || scenario.viewport.height < 320) {
      throw new TypeError(`${scenario.id} viewport is invalid`)
    }
    if (!scenario.state || typeof scenario.state !== 'object') {
      throw new TypeError(`${scenario.id} requires state tracking metadata`)
    }
    for (const field of ['phase', 'selection', 'controlOwner', 'disclosure']) {
      requiredText(scenario.state[field], `${scenario.id} state.${field}`)
    }
    if (!Array.isArray(scenario.principleIds) || scenario.principleIds.length === 0) {
      throw new TypeError(`${scenario.id} requires at least one principleId`)
    }
    for (const principleId of scenario.principleIds) {
      if (!principleIds.has(principleId)) {
        throw new TypeError(`${scenario.id} references unknown principle ${principleId}`)
      }
    }
    if (!Array.isArray(scenario.checkpoints) || scenario.checkpoints.length === 0) {
      throw new TypeError(`${scenario.id} requires human review checkpoints`)
    }
    scenario.checkpoints.forEach((checkpoint, index) => {
      requiredText(checkpoint, `${scenario.id} checkpoint ${index + 1}`)
    })
    if (!Array.isArray(scenario.checks) || scenario.checks.length === 0) {
      throw new TypeError(`${scenario.id} requires executable checks`)
    }
    scenario.checks.forEach((check, index) => validateCheck(scenario.id, check, index))
  }

  for (const journey of value.journeys) {
    requiredText(journey.id, 'journey id')
    requiredText(journey.label, `${journey.id} label`)
    requiredText(journey.description, `${journey.id} description`)
    if (!stepsByJourney.has(journey.id)) {
      throw new TypeError(`${journey.id} has no scenarios`)
    }
  }

  return value
}

function validateCheck(scenarioId, check, index) {
  if (!check || typeof check !== 'object' || !CHECK_KINDS.has(check.kind)) {
    throw new TypeError(`${scenarioId} check ${index + 1} has an unsupported kind`)
  }
  requiredText(check.label, `${scenarioId} check ${index + 1} label`)
  if (check.kind === 'selector-count' || check.kind === 'selector-visible') {
    requiredText(check.selector, `${scenarioId} check ${index + 1} selector`)
  }
  if (check.kind === 'selector-count'
    && (!Number.isSafeInteger(check.count) || check.count < 0)) {
    throw new TypeError(`${scenarioId} check ${index + 1} count must be a non-negative integer`)
  }
  if (check.kind === 'text-present' || check.kind === 'text-absent') {
    requiredText(check.text, `${scenarioId} check ${index + 1} text`)
  }
}

function assertUniqueIds(items, label) {
  const ids = new Set()
  for (const item of items) {
    requiredText(item?.id, `${label} id`)
    if (ids.has(item.id)) throw new TypeError(`Duplicate ${label} id ${item.id}`)
    ids.add(item.id)
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}
