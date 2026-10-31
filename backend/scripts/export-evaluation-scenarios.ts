import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scenarios, SCENARIO_CATALOG_VERSION, validateScenarios } from '../evaluation/catalog.js';

validateScenarios(scenarios);
const destination = resolve(process.argv[2] ?? 'backend/evaluation/scenarios/catalog.v3.json');
await mkdir(resolve(destination, '..'), { recursive: true });
const conversations = scenarios.reduce((total, scenario) => total + scenario.conversations.length, 0);
const turns = scenarios.reduce((total, scenario) => total + scenario.conversations.reduce((count, conversation) => count + conversation.turns.length, 0), 0);
await writeFile(destination, `${JSON.stringify({
  version: SCENARIO_CATALOG_VERSION, synthetic: true,
  purpose: 'test_inputs_and_acceptance_criteria', execution_status: 'not_run', character_memory_quality_evidence: false,
  totals: { scenarios: scenarios.length, conversations, turns }, scenarios,
}, null, 2)}\n`);
console.log(`Exported ${scenarios.length} scenarios, ${conversations} conversations and ${turns} test turns to ${destination}`);
