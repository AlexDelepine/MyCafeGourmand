import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertEnvironment, isSoloOwnerFamilyTest } from "./workflow-release";

export function assertFamilyWorkflowContext(environment: Readonly<Record<string, string | undefined>>) {
  if (environment.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || environment.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Family test deployments require manual dispatch from protected main.");
  }
  if (isSoloOwnerFamilyTest(environment.GITHUB_REPOSITORY)
    && (environment.GITHUB_ACTOR !== "AlexDelepine" || environment.GITHUB_TRIGGERING_ACTOR !== "AlexDelepine")) {
    throw new Error("The solo dev/test fork requires the owner to dispatch and rerun deployments.");
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  void (async () => {
    if (process.argv.length !== 2) throw new Error("Family authorization takes no arguments.");
    assertFamilyWorkflowContext(process.env);
    await assertEnvironment("family-test");
  })().catch(() => {
    console.error("Family deployment blocked: manual-main actor policy, protected main and the repository-specific family-test environment policy are required.");
    process.exitCode = 1;
  });
}
