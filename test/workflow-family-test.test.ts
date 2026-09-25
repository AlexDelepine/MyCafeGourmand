import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertEnvironment } from "../scripts/workflow-release";
import { assertFamilyWorkflowContext } from "../scripts/workflow-family-test";

const protectedEnvironment = {
  protection_rules: [{
    type: "required_reviewers", prevent_self_review: true, reviewers: [{ id: 7 }]
  }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
};
const mainPolicy = { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] };

function familyWorkflowSteps() {
  const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/family-test.yml"), "utf8");
  const job = workflow.split("\n  family-test:\n")[1];
  assert.ok(job);
  return { workflow, steps: job.split(/^      - /mu).slice(1) };
}

test("family diagnostic retention is gated by fresh checks, build and commit/origin validation", () => {
  const { workflow, steps } = familyWorkflowSteps();
  const check = steps.findIndex((step) => step.startsWith("run: npm run check\n"));
  const bootstrap = steps.findIndex((step) => step.includes("run: npm run family-test:bootstrap\n"));
  const site = steps.findIndex((step) => step.includes("run: npm run build:family-test\n"));
  const validation = steps.findIndex((step) => step.includes("id: validate\n"));
  const upload = steps.findIndex((step) => step.includes("id: upload\n"));
  const destination = steps.findIndex((step) => step.startsWith("name: Require the actual dedicated test origin\n"));
  const verification = steps.findIndex((step) => step.includes("run: npm run family-test:verify -- . --anonymous-only\n"));
  const retention = steps.findIndex((step) => step.includes("uses: actions/upload-artifact@"));
  assert.ok(check >= 0 && check < bootstrap && bootstrap < site && site < validation
    && validation < upload && upload < destination && destination < verification && verification < retention);
  assert.match(steps[bootstrap], /if: inputs.operation == 'bootstrap'\n/u);
  assert.match(steps[site], /if: inputs.operation == 'site'\n/u);
  for (const index of [check, validation, upload, destination, verification]) {
    assert.doesNotMatch(steps[index], /^\s*if:/mu, "These steps must retain GitHub's default success() gate.");
  }
  assert.match(steps[validation],
    /run: npx --no-install tsx scripts\/family-test-artifact.ts validate \. "\$GITHUB_SHA" "\$FAMILY_TEST_SITE_ORIGIN"\n/u);
  assert.doesNotMatch(workflow, /continue-on-error:|always\(\)|accepted-production|production-acceptance|staging-acceptance/u);
  assert.match(steps[retention], /name: family-test-NONPROMOTABLE\n/u);
  assert.match(steps[retention],
    /path: \|\n\s+out\/\n\s+\.deployment\/family-test-artifact\.json\n\s+\.deployment\/redirect-manifest\.json\n/u);
  assert.match(steps[retention], /include-hidden-files: true\n/u);
  assert.match(steps[retention], /if-no-files-found: error\n/u);
});

test("family retention condition retains validated failures but skips unvalidated or cancelled runs", () => {
  const { steps } = familyWorkflowSteps();
  const retention = steps.find((step) => step.includes("uses: actions/upload-artifact@"));
  assert.ok(retention);
  const condition = retention.match(/^\s+if: (.+)$/mu)?.[1];
  assert.equal(condition, "${{ !cancelled() && steps.validate.outcome == 'success' }}");
  // Pin the exact status-function expression above; model its GitHub truth table below.
  const scenarios = [
    { name: "checks failed", checks: "failure", build: "skipped", validation: "skipped", later: "skipped", cancelled: false, retain: false },
    { name: "bootstrap failed", checks: "success", build: "failure", validation: "skipped", later: "skipped", cancelled: false, retain: false },
    { name: "site build failed", checks: "success", build: "failure", validation: "skipped", later: "skipped", cancelled: false, retain: false },
    { name: "validation failed", checks: "success", build: "success", validation: "failure", later: "skipped", cancelled: false, retain: false },
    { name: "validation skipped", checks: "success", build: "success", validation: "skipped", later: "skipped", cancelled: false, retain: false },
    { name: "upload failed", checks: "success", build: "success", validation: "success", later: "failure", cancelled: false, retain: true },
    { name: "origin mismatch", checks: "success", build: "success", validation: "success", later: "failure", cancelled: false, retain: true },
    { name: "verifier failed", checks: "success", build: "success", validation: "success", later: "failure", cancelled: false, retain: true },
    { name: "anonymous probes passed", checks: "success", build: "success", validation: "success", later: "success", cancelled: false, retain: true },
    { name: "cancelled during validation", checks: "success", build: "success", validation: "cancelled", later: "skipped", cancelled: true, retain: false },
    { name: "cancelled after validation", checks: "success", build: "success", validation: "success", later: "cancelled", cancelled: true, retain: false }
  ];
  for (const scenario of scenarios) {
    if (scenario.checks !== "success" || scenario.build !== "success") {
      assert.equal(scenario.validation, "skipped", scenario.name);
    }
    assert.equal(!scenario.cancelled && scenario.validation === "success", scenario.retain, scenario.name);
  }
});

test("family authorization inspects only the running repository, including a fork", async (context) => {
  const previousRepository = process.env.GITHUB_REPOSITORY;
  const previousToken = process.env.GH_TOKEN;
  let repository = "";
  let environment: unknown = protectedEnvironment;
  let policies: unknown = mainPolicy;
  let protectedMain = true;
  let environmentName = "family-test";
  const requests: string[] = [];
  context.mock.method(globalThis, "fetch", async (url: string) => {
    const prefix = `https://api.github.com/repos/${repository}/`;
    assert.ok(url.startsWith(prefix), "Authorization must not inspect another repository.");
    requests.push(url.slice(prefix.length));
    const endpoint = url.slice(prefix.length);
    const value = endpoint === "branches/main" ? { protected: protectedMain }
      : endpoint === `environments/${environmentName}` ? environment
      : endpoint === `environments/${environmentName}/deployment-branch-policies?per_page=100` ? policies
      : undefined;
    assert.notEqual(value, undefined, "Unexpected authorization endpoint.");
    return new Response(JSON.stringify(value));
  });
  process.env.GH_TOKEN = "sanitized-test-token";
  try {
    for (repository of ["upstream-owner/site", "fork-owner/site"]) {
      process.env.GITHUB_REPOSITORY = repository;
      requests.length = 0;
      await assertEnvironment("family-test");
      assert.deepEqual(requests, [
        "branches/main", "environments/family-test",
        "environments/family-test/deployment-branch-policies?per_page=100"
      ]);
    }
    for (const changed of [
      { protection_rules: [] },
      { protection_rules: [{ type: "required_reviewers", prevent_self_review: false, reviewers: [{ id: 7 }] }] },
      { protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [] }] },
      { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } },
      { deployment_branch_policy: null }
    ]) {
      environment = { ...protectedEnvironment, ...changed };
      await assert.rejects(assertEnvironment("family-test"));
    }
    environment = protectedEnvironment;
    for (policies of [
      { total_count: 0, branch_policies: [] },
      { total_count: 1, branch_policies: [{ name: "*", type: "branch" }] },
      { total_count: 1, branch_policies: [{ name: "main", type: "tag" }] },
      { total_count: 2, branch_policies: [...mainPolicy.branch_policies, { name: "test", type: "branch" }] }
    ]) await assert.rejects(assertEnvironment("family-test"));
    policies = mainPolicy;
    protectedMain = false;
    await assert.rejects(assertEnvironment("family-test"));
    protectedMain = true;
    repository = "AlexDelepine/MyCafeGourmand";
    process.env.GITHUB_REPOSITORY = repository;
    environment = { ...protectedEnvironment, protection_rules: [] };
    await assertEnvironment("family-test");
    for (const name of ["staging", "production"] as const) {
      environmentName = name;
      await assert.rejects(assertEnvironment(name), /independent reviewers/u);
      environment = protectedEnvironment;
      await assertEnvironment(name);
      environment = { ...protectedEnvironment, protection_rules: [] };
    }
    environmentName = "family-test";
    for (policies of [
      { total_count: 0, branch_policies: [] },
      { total_count: 1, branch_policies: [{ name: "*", type: "branch" }] },
      { total_count: 1, branch_policies: [{ name: "main", type: "tag" }] }
    ]) await assert.rejects(assertEnvironment("family-test"));
    policies = mainPolicy;
    environment = {
      protection_rules: [],
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }
    };
    await assert.rejects(assertEnvironment("family-test"));
    environment = { ...protectedEnvironment, protection_rules: [] };
    protectedMain = false;
    await assert.rejects(assertEnvironment("family-test"));
    protectedMain = true;
    for (repository of ["cndelepine/MyCafeGourmand", "another-owner/MyCafeGourmand"]) {
      process.env.GITHUB_REPOSITORY = repository;
      await assert.rejects(assertEnvironment("family-test"), /independent reviewers/u);
    }
  } finally {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  }
});

test("solo family dispatch and reruns require the owner and manual main context", () => {
  const environment = {
    GITHUB_REPOSITORY: "AlexDelepine/MyCafeGourmand",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_ACTOR: "AlexDelepine",
    GITHUB_TRIGGERING_ACTOR: "AlexDelepine"
  };
  assert.doesNotThrow(() => assertFamilyWorkflowContext(environment));
  for (const changed of [
    { GITHUB_EVENT_NAME: "push" }, { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_REF: "refs/tags/main" },
    { GITHUB_ACTOR: "another-user" }, { GITHUB_TRIGGERING_ACTOR: "another-user" },
    { GITHUB_ACTOR: undefined }, { GITHUB_TRIGGERING_ACTOR: undefined }
  ]) assert.throws(() => assertFamilyWorkflowContext({ ...environment, ...changed }));
  assert.doesNotThrow(() => assertFamilyWorkflowContext({
    ...environment, GITHUB_REPOSITORY: "cndelepine/MyCafeGourmand",
    GITHUB_ACTOR: "upstream-operator", GITHUB_TRIGGERING_ACTOR: "upstream-operator"
  }));
});
