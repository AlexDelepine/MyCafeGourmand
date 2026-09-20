import assert from "node:assert/strict";
import test from "node:test";
import { assertEnvironment } from "../scripts/workflow-release";

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
  const requests: string[] = [];
  context.mock.method(globalThis, "fetch", async (url: string) => {
    const prefix = `https://api.github.com/repos/${repository}/`;
    assert.ok(url.startsWith(prefix), "Authorization must not inspect another repository.");
    requests.push(url.slice(prefix.length));
    const endpoint = url.slice(prefix.length);
    const value = endpoint === "branches/main" ? { protected: protectedMain }
      : endpoint === "environments/family-test" ? environment
      : endpoint === "environments/family-test/deployment-branch-policies?per_page=100" ? policies
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
  } finally {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  }
});
