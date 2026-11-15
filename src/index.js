#!/usr/bin/env node
// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Command-line runner (the Node.js mirror of workflows/support_feedback_aggregator.json).
 *
 *   node src/index.js demo [--json]    fictional tickets, mock LLM, mock destinations, no network
 *   node src/index.js run [--json]     one aggregation run against the configured environment
 *
 * Variables come from the shell, then .env. The watermark, processed tickets and the cluster
 * registry persist in data/state.json (only when DRY_RUN=false).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSafety, loadAggregatorConfig, validateAggregatorConfig } from './core/config.js';
import { runAggregator, runDemo } from './core/pipeline.js';

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

export function loadContext({ cwd = process.cwd(), baseEnv = process.env } = {}) {
  const dotEnvPath = resolve(cwd, '.env');
  const env = { ...(existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, 'utf8')) : {}), ...baseEnv };
  return { env, config: loadAggregatorConfig(env), statePath: resolve(cwd, 'data', 'state.json') };
}

function loadState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

const usd = (value) => `$${Math.round(value).toLocaleString('en-US')}`;

function print(result, config, log) {
  log(describeSafety(config));
  log(`Window since ${new Date(result.since).toISOString()}: ${result.tickets.length} new ticket(s), ${result.search.alreadyProcessed} already processed${result.search.hasMore ? ', more waiting for the next run' : ''}.\n`);
  for (const cluster of result.clusters) {
    const ref = cluster.destination ? ` → ${cluster.destination.target} ${cluster.destination.ref}` : '';
    log(`P${cluster.priority} [${cluster.category}] ${cluster.title}${cluster.isNew ? ' (new)' : ''}${ref}`);
    log(`   ${cluster.ticketCount} ticket(s), ${cluster.companyCount} compan${cluster.companyCount === 1 ? 'y' : 'ies'}, ARR impact ${usd(cluster.arrImpact)}, ARR at risk ${usd(cluster.arrAtRisk)}, max churn risk ${cluster.maxChurnRisk}`);
  }
  for (const failure of result.extractionResults.filter((entry) => !entry.ok)) log(`extraction failed for ticket ${failure.ticketId}: ${failure.error}`);
  const t = result.totals;
  log(`\n${t.ticketsScanned} ticket(s), ${t.feedbackItems} feedback item(s), ${t.clustersTouched} cluster(s) (${t.clustersNew} new), ARR impact ${usd(t.arrImpactTouched)}.`);
  log(`Destination: ${t.recordsCreated} created, ${t.recordsUpdated} updated, ${t.syncFailures} failed. Tickets stamped: ${t.ticketsStamped}.`);
}

export async function main(argv = process.argv.slice(2), { log = console.log, errorLog = console.error } = {}) {
  const [command = 'demo'] = argv;
  const json = argv.includes('--json');
  try {
    const context = loadContext();
    let config = context.config;
    let result;
    if (command === 'demo') {
      config = loadAggregatorConfig({ ...context.env, HUBSPOT_PRIVATE_APP_TOKEN: '' }, { forceMode: 'demo' });
      result = await runDemo({ config, state: {} });
    } else if (command === 'run') {
      for (const warning of validateAggregatorConfig(config).warnings) errorLog(`warning: ${warning}`);
      const state = loadState(context.statePath);
      result = await runAggregator({ config, state });
      if (!config.dryRun && config.mode !== 'demo') {
        mkdirSync(dirname(context.statePath), { recursive: true });
        writeFileSync(context.statePath, `${JSON.stringify(state, null, 2)}\n`);
      }
    } else {
      throw new Error(`Unknown command "${command}". Use demo or run.`);
    }
    if (json) log(JSON.stringify({ totals: result.totals, clusters: result.clusters }, null, 2));
    else print(result, config, log);
    return result.totals.syncFailures || result.totals.stampFailures ? 1 : 0;
  } catch (error) {
    errorLog(`error: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; });
}
