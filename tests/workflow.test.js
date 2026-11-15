// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LICENSE_LINE, NODE, serializeWorkflow, WORKFLOW_PATH } from '../scripts/build-workflow.js';
import { runWorkflow } from './n8n-simulator.js';
import { createDemoPortal, createMockDestinations, createMockHubSpot, createMockLlmApi, DEMO_NOW } from '../src/core/mocks.js';
import { loadAggregatorConfig } from '../src/core/config.js';
import { processRun, runDemo } from '../src/core/pipeline.js';

const workflow = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf8'));
const ACCOUNT = { portalId: 12345678, accountType: 'SANDBOX', uiDomain: 'app.hubspot.com' };
const BASE = { HUBSPOT_PRIVATE_APP_TOKEN: 'test-hubspot-token', AGGREGATOR_NOW: DEMO_NOW, ALERT_WEBHOOK_URL: 'https://alerts.example.com/hook' };
const LINEAR = { ...BASE, DRY_RUN: 'false', FEEDBACK_DESTINATION: 'linear', LINEAR_API_KEY: 'test-linear-key', LINEAR_SANDBOX_TEAM_ID: 'team-sandbox', ARR_SOURCE: 'closed_won_deals' };

function services(env, options = {}) {
  const portal = createDemoPortal();
  const hubspot = createMockHubSpot({ portal, account: options.account || ACCOUNT });
  const llm = createMockLlmApi({ config: loadAggregatorConfig(env), failTickets: options.failTickets || [] });
  const destinations = createMockDestinations(options.destinations);
  const posted = [];
  const http = async (request) => {
    if (request.url.startsWith('https://api.hubapi.com/')) {
      assert.equal(request.headers.Authorization, 'Bearer test-hubspot-token');
      return hubspot.request(request);
    }
    if (request.url.includes('openai.com') || request.url.includes('anthropic.com')) return llm.request(request);
    if (request.url.includes('linear.app') || request.url.includes('atlassian.net') || request.url.includes('api.notion.com')) return destinations.request(request);
    posted.push(request);
    return { status: 200, body: { ok: true } };
  };
  return { portal, hubspot, llm, destinations, posted, http };
}

async function mirror(env, options = {}, state = {}) {
  const svc = services(env, options);
  const result = await processRun({ config: loadAggregatorConfig(env), state, hubspotHttp: svc.hubspot.request, llmHttp: svc.llm.request, destinationHttp: svc.destinations.request, now: Date.parse(DEMO_NOW) });
  return { svc, result };
}

test('workflow JSON is exactly what the build script produces', () => {
  assert.equal(readFileSync(WORKFLOW_PATH, 'utf8'), serializeWorkflow());
});

test('structure: inactive, required stages present, valid connections, everything reachable', () => {
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  const names = new Set(workflow.nodes.map((node) => node.name));
  for (const name of [NODE.schedule, NODE.search, NODE.companies, NODE.deals, NODE.llmOpenAi, NODE.llmAnthropic, NODE.cluster, NODE.planSync, NODE.sync]) assert.ok(names.has(name), name);
  for (const [source, { main }] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source));
    for (const branch of main) for (const connection of branch) assert.ok(names.has(connection.node), connection.node);
  }
  const reachable = new Set();
  const visit = (name) => { if (reachable.has(name)) return; reachable.add(name); for (const branch of (workflow.connections[name] || { main: [] }).main) for (const c of branch) visit(c.node); };
  [NODE.schedule, NODE.manual, NODE.errorTrigger].forEach(visit);
  assert.deepEqual(workflow.nodes.map((node) => node.name).filter((name) => !reachable.has(name)), [NODE.note]);
});

test('no credentials, no hardcoded URLs, secrets only from $env, license line in every Code node', () => {
  const text = JSON.stringify(workflow);
  assert.ok(!/pat-(?:na|eu)\d-/.test(text));
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(text));
  assert.ok(!/lin_api_[A-Za-z0-9]{10,}/.test(text));
  assert.ok(!/secret_[A-Za-z0-9]{20,}/.test(text));
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.httpRequest') {
      assert.ok(!/https?:\/\//.test(node.parameters.url), `${node.name} has no hardcoded URL`);
      const auth = node.parameters.headerParameters && node.parameters.headerParameters.parameters.find((header) => /authorization|x-api-key/i.test(header.name));
      if (auth) assert.match(auth.value, /\$env\./, node.name);
      assert.equal(node.credentials, undefined);
    }
    if (node.type === 'n8n-nodes-base.code') assert.ok(node.parameters.jsCode.startsWith(`// ${LICENSE_LINE}`), node.name);
  }
});

test('manual run in demo mode matches the Node.js demo without any HTTP', async () => {
  const run = await runWorkflow(workflow, { env: {}, http: async () => { throw new Error('demo must not call HTTP'); } });
  const demo = await runDemo({ config: loadAggregatorConfig({}) });
  const summary = run.output(NODE.finalize)[0];
  assert.equal(summary.source, 'demo');
  assert.deepEqual(summary.clusters, demo.clusters);
  assert.deepEqual(summary.totals, demo.totals);
  assert.equal(summary.totals.clustersTouched, 4);
  assert.equal(summary.totals.recordsCreated, 0);
});

test('sandbox run to Linear with deal-based ARR matches the Node.js mirror', async () => {
  const n8n = services(LINEAR);
  const staticData = {};
  const run = await runWorkflow(workflow, { env: LINEAR, http: n8n.http, staticData });
  const { svc, result } = await mirror(LINEAR);
  const summary = run.output(NODE.finalize)[0];
  assert.deepEqual(summary.clusters, result.clusters);
  assert.deepEqual(summary.totals, result.totals);
  assert.deepEqual(n8n.destinations.records, svc.destinations.records);
  assert.equal(summary.totals.recordsCreated, 4);
  assert.ok(n8n.destinations.calls.every((call) => call.headers.Authorization === 'test-linear-key'));
  assert.ok(n8n.destinations.calls.every((call) => call.body.variables.input.teamId === 'team-sandbox'));
  const pricing = summary.clusters.find((cluster) => cluster.category === 'churn_friction');
  assert.equal(pricing.arrAtRisk, 200000);
  assert.equal(staticData.feedbackClusters[pricing.clusterId].destination.key, pricing.destination);
  assert.deepEqual(staticData.feedbackClusters[pricing.clusterId].destination, result.state.feedbackClusters[pricing.clusterId].destination);
  assert.equal(staticData.ticketWatermark, result.state.ticketWatermark);
});

test('the OpenAI path sends PII-redacted text and the key from $env', async () => {
  const env = { ...BASE, LLM_PROVIDER: 'openai', LLM_API_KEY: 'test-llm-key', LLM_MODEL: 'test-model' };
  const n8n = services(env);
  const run = await runWorkflow(workflow, { env, http: n8n.http });
  assert.equal(n8n.llm.calls.length, 8);
  assert.ok(n8n.llm.calls.every((call) => call.headers.Authorization === 'Bearer test-llm-key'));
  const sent = JSON.stringify(n8n.llm.calls.map((call) => call.body));
  assert.ok(!sent.includes('pat.example@example.com'));
  assert.ok(!sent.includes('555-0123'));
  assert.ok(!sent.includes('4111 1111'));
  const { result } = await mirror(env);
  assert.deepEqual(run.output(NODE.finalize)[0].clusters, result.clusters);
});

test('the Anthropic path uses x-api-key and the Messages shape', async () => {
  const env = { ...BASE, LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'test-llm-key', LLM_MODEL: 'test-model' };
  const n8n = services(env);
  const run = await runWorkflow(workflow, { env, http: n8n.http });
  assert.ok(run.executed.includes(NODE.llmAnthropic));
  assert.ok(!run.executed.includes(NODE.llmOpenAi));
  assert.ok(n8n.llm.calls.every((call) => call.headers['x-api-key'] === 'test-llm-key' && call.headers['anthropic-version'] === '2023-06-01'));
  assert.equal(run.output(NODE.finalize)[0].totals.extractionsOk, 8);
});

test('Jira and Notion destinations build the right requests in the sandbox container', async () => {
  const jiraEnv = { ...BASE, DRY_RUN: 'false', FEEDBACK_DESTINATION: 'jira', JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_EMAIL: 'bot@example.com', JIRA_API_TOKEN: 'test-jira-token', JIRA_SANDBOX_PROJECT_KEY: 'SBX' };
  const jira = services(jiraEnv);
  await runWorkflow(workflow, { env: jiraEnv, http: jira.http });
  assert.equal(jira.destinations.calls.length, 4);
  assert.ok(jira.destinations.calls.every((call) => call.method === 'POST' && call.body.fields.project.key === 'SBX'));
  assert.ok(jira.destinations.calls.every((call) => call.headers.Authorization === `Basic ${Buffer.from('bot@example.com:test-jira-token').toString('base64')}`));

  const notionEnv = { ...BASE, DRY_RUN: 'false', FEEDBACK_DESTINATION: 'notion', NOTION_API_KEY: 'test-notion-key', NOTION_SANDBOX_DATABASE_ID: 'db-sandbox' };
  const notion = services(notionEnv);
  await runWorkflow(workflow, { env: notionEnv, http: notion.http });
  assert.equal(notion.destinations.calls.length, 4);
  assert.ok(notion.destinations.calls.every((call) => call.body.parent.database_id === 'db-sandbox' && call.headers.Authorization === 'Bearer test-notion-key' && call.headers['Notion-Version'] === '2022-06-28'));
});

test('a second run updates nothing new and a later ticket updates the existing record', async () => {
  const n8n = services(LINEAR);
  const staticData = {};
  await runWorkflow(workflow, { env: LINEAR, http: n8n.http, staticData });
  const second = await runWorkflow(workflow, { env: LINEAR, http: n8n.http, staticData });
  assert.equal(second.output(NODE.finalize)[0].totals.ticketsScanned, 0);
  n8n.portal.tickets[810] = { subject: 'Export again', content: 'CSV export fails with error 500 on our big monthly report.', hs_ticket_priority: 'MEDIUM', closed_date: '2026-11-16T05:00:00.000Z', hs_lastmodifieddate: '2026-11-16T05:00:00.000Z', hs_pipeline: '0' };
  n8n.portal.associations['tickets/companies'][810] = ['604'];
  const third = await runWorkflow(workflow, { env: LINEAR, http: n8n.http, staticData });
  const totals = third.output(NODE.finalize)[0].totals;
  assert.equal(totals.ticketsScanned, 1);
  assert.equal(totals.recordsCreated, 0);
  assert.equal(totals.recordsUpdated, 1);
});

test('DRY_RUN reads and extracts but never writes or commits state', async () => {
  const env = { ...LINEAR, DRY_RUN: 'true' };
  const n8n = services(env);
  const staticData = {};
  const run = await runWorkflow(workflow, { env, http: n8n.http, staticData });
  assert.ok(!run.executed.includes(NODE.sync));
  assert.ok(!run.executed.includes(NODE.stamp));
  assert.equal(n8n.destinations.calls.length, 0);
  assert.equal(staticData.ticketWatermark, undefined);
  assert.equal(staticData.feedbackClusters, undefined);
  assert.equal(run.output(NODE.finalize)[0].totals.clustersTouched, 4);
});

test('a production portal is refused while SANDBOX_MODE=true', async () => {
  const n8n = services(LINEAR, { account: { portalId: 87654321, accountType: 'STANDARD', uiDomain: 'app.hubspot.com' } });
  await assert.rejects(runWorkflow(workflow, { env: LINEAR, http: n8n.http }), /sandbox/i);
  assert.equal(n8n.destinations.calls.length, 0);
});

test('failed LLM calls hold the watermark back and are retried next run', async () => {
  const env = { ...LINEAR, LLM_PROVIDER: 'openai', LLM_API_KEY: 'test-llm-key', LLM_MODEL: 'test-model' };
  const n8n = services(env, { failTickets: ['803'] });
  const staticData = {};
  const run = await runWorkflow(workflow, { env, http: n8n.http, staticData });
  const summary = run.output(NODE.finalize)[0];
  assert.equal(summary.totals.extractionFailures, 1);
  assert.deepEqual(summary.extractionFailures.map((failure) => failure.ticketId), ['803']);
  assert.equal(staticData.processedTickets['803'], undefined);
  assert.ok(staticData.ticketWatermark <= Date.parse(n8n.portal.tickets[803].hs_lastmodifieddate));
});

test('destination failures fail the execution and the alert is redacted', async () => {
  const n8n = services(LINEAR, { destinations: { fail: true } });
  await assert.rejects(runWorkflow(workflow, { env: LINEAR, http: n8n.http }), /destination sync/);
  const alert = await runWorkflow(workflow, {
    env: LINEAR,
    http: n8n.http,
    startNode: NODE.errorTrigger,
    triggerItems: [{ json: { execution: { id: '42', lastNodeExecuted: NODE.finalize, error: { message: 'failed with token test-linear-key for ops@example.com' } }, workflow: { name: 'aggregator' } } }],
  });
  assert.ok(alert.executed.includes(NODE.sendFailure));
  const body = JSON.stringify(n8n.posted[0].body);
  assert.ok(!body.includes('test-linear-key'));
  assert.ok(!body.includes('ops@example.com'));
});
