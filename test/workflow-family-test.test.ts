import assert from "node:assert/strict";
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
