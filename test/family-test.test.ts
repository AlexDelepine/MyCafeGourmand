import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { familyTestPublicPages } from "../src/lib/family-test-routes";
import { assertRecipeMediaBuildEnvironment } from "../src/lib/recipe-media";
import {
  familyTestConfig, validateFamilyTestArtifact, writeFamilyTestArtifact, familyMetadataPath
} from "../scripts/family-test-artifact";
import { createFamilyTestBuildEnvironment, createReleaseBuildEnvironment } from "../scripts/build-static";
import { renderLegacyPage } from "../scripts/legacy-navigation";
import { inventoryOutput, prepareStagingArtifact, validateReleaseArtifact, writeReleaseArtifactMetadata } from "../scripts/release-artifact";
import { validateAcceptanceReceipt, wirePath, type SiteResponse, type SiteTransport } from "../scripts/verify-deployed-site";
import { familySessionTransport, readFamilyCookie, verifyFamilyTest } from "../scripts/verify-family-test";
import { buildFamilyBootstrap } from "../scripts/build-family-test";
import { releaseFixture } from "./release-artifact-fixture";

const origin = "https://family-test-fixture.azurestaticapps.net";
const media = "https://fixture.blob.core.windows.net/media";

function fixture() {
  const result = releaseFixture(false);
  writeFamilyTestArtifact(result.root, origin, media);
  return result;
}

function bootstrapRoot() {
  const root = mkdtempSync(path.join(process.cwd(), ".family-bootstrap-test-"));
  mkdirSync(path.join(root, "config"));
  writeFileSync(path.join(root, "config/staticwebapp.config.json"),
    readFileSync(path.join(process.cwd(), "config/staticwebapp.config.json")));
  return root;
}

function fakeTransport(
  root: string, context: "anonymous" | "nonmember" | "member",
  mutate?: (target: string, response: SiteResponse) => SiteResponse,
  normalizePublic = false
): SiteTransport {
  const configuredHeaders = z.object({ globalHeaders: z.record(z.string(), z.string()) }).parse(
    JSON.parse(readFileSync(path.join(root, "out/staticwebapp.config.json"), "utf8"))
  ).globalHeaders;
  const headers = Object.fromEntries(Object.entries(configuredHeaders).map(([key, value]) => [key.toLowerCase(), value]));
  return async (requestedOrigin, target) => {
    assert.equal(requestedOrigin, origin);
    const publicPage = familyTestPublicPages.find((route) => route === target
      || (normalizePublic && `${route.slice(0, -".html".length)}/` === target));
    let response: SiteResponse;
    if (target === "/.auth/me") {
      response = { status: 200, headers: {}, body: Buffer.from(JSON.stringify({
        clientPrincipal: context === "anonymous" ? null : {
          userId: `sanitized-${context}`, identityProvider: "aad",
          userRoles: context === "member" ? ["anonymous", "authenticated", "family"] : ["anonymous", "authenticated"]
        }
      })) };
    } else if (normalizePublic && publicPage === target) {
      response = {
        status: 301, headers: { ...headers, location: `${origin}${target.slice(0, -".html".length)}/` },
        body: Buffer.alloc(0)
      };
    } else if (!publicPage && context !== "member") {
      response = {
        status: context === "anonymous" ? 302 : 403,
        headers: context === "anonymous" ? { ...headers, location: familyTestPublicPages[0] } : headers,
        body: context === "anonymous" ? Buffer.alloc(0) : readFileSync(path.join(root, "out", familyTestPublicPages[1]))
      };
    } else {
      const file = decodeURIComponent(publicPage ?? target).slice(1);
      const relative = !file || file.endsWith("/") ? `${file}index.html`
        : path.extname(file) ? file : `${file}/index.html`;
      response = {
        status: 200, body: readFileSync(path.join(root, "out", relative)),
        headers: {
          ...headers,
          "content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html"
        }
      };
    }
    return mutate ? mutate(target, response) : response;
  };
}

test("family access uses one final all-method custom-role gate and no fallback", () => {
  const config = JSON.parse(familyTestConfig(JSON.stringify({
    trailingSlash: "always", routes: [], globalHeaders: { "X-Content-Type-Options": "nosniff" }
  })));
  assert.deepEqual(config.routes, [
    ...familyTestPublicPages.map((route) => ({ route, allowedRoles: ["anonymous"] })),
    { route: "/.auth/*", allowedRoles: ["anonymous"] },
    { route: "/*", allowedRoles: ["family"] }
  ]);
  assert.equal(config.navigationFallback, undefined);
  assert.deepEqual(config.responseOverrides["401"], { statusCode: 302, redirect: familyTestPublicPages[0] });
  assert.deepEqual(config.responseOverrides["403"], { rewrite: familyTestPublicPages[1] });
  assert.equal(config.globalHeaders["Cache-Control"], "private, no-store");
  assert.equal(config.globalHeaders["X-Robots-Tag"], "noindex");
  for (const patch of [
    { routes: [{ route: "/*", allowedRoles: ["authenticated"] }] },
    { navigationFallback: { rewrite: "/index.html" } },
    { auth: { rolesSource: "/api/roles" } },
    { globalHeaders: { "Cache-Control": "public" } }
  ]) {
    assert.throws(() => familyTestConfig(JSON.stringify({ trailingSlash: "always", globalHeaders: {}, ...patch })));
  }
});

test("family build flags cannot be used in release/local and canonical stays production", () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    npm_lifecycle_event: "build:family-test", FAMILY_TEST_SITE_ORIGIN: origin,
    NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL: media
  };
  const build = createFamilyTestBuildEnvironment(env);
  assert.equal(build.NEXT_PUBLIC_SITE_URL, "https://mycafegourmand.com");
  assert.doesNotThrow(() => assertRecipeMediaBuildEnvironment("family-test", build));
  assert.throws(() => assertRecipeMediaBuildEnvironment("release", build));
  assert.throws(() => assertRecipeMediaBuildEnvironment("non-release", build));
  assert.throws(() => createReleaseBuildEnvironment(env));
  assert.throws(() => createFamilyTestBuildEnvironment({ ...env, NEXT_PUBLIC_SITE_URL: origin }));
  assert.throws(() => createFamilyTestBuildEnvironment({ ...env, npm_lifecycle_event: "build:release" }));
  assert.throws(() => createFamilyTestBuildEnvironment({ ...env, MY_CAFE_GOURMAND_RELEASE_BUILD: "1" }));
});

test("family artifact keeps canonical but test navigation stays local and production rejects it", () => {
  const data = fixture();
  try {
    const result = validateFamilyTestArtifact(data.root);
    assert.equal(result.metadata.promotion, "NONPROMOTABLE");
    assert.equal(result.manifest.redirects.length, data.manifest.redirects.length);
    assert.throws(() => validateFamilyTestArtifact(data.root, "f".repeat(40)));
    assert.throws(() => validateFamilyTestArtifact(data.root, undefined, "https://wrong.azurestaticapps.net"));
    const redirect = data.manifest.redirects[0];
    const production = renderLegacyPage(redirect);
    assert.equal(production, renderLegacyPage(redirect, "production"));
    assert.match(production, /content="0;url=https:\/\/mycafegourmand.com\/recipes\/new\/"/u);
    const family = renderLegacyPage(redirect, "family-test");
    assert.match(family, /content="0;url=\/recipes\/new\/"/u);
    assert.match(family, /rel="canonical" href="https:\/\/mycafegourmand.com\/recipes\/new\/"/u);
    assert.match(family, /<a href="\/recipes\/new\/">/u);
    assert.throws(() => validateReleaseArtifact(data.root, "production"), /NONPROMOTABLE/u);
    assert.throws(() => writeReleaseArtifactMetadata(data.root), /NONPROMOTABLE/u);
    assert.throws(() => prepareStagingArtifact(data.root, path.join(data.base, "stage")), /NONPROMOTABLE/u);
    assert.throws(() => validateAcceptanceReceipt(data.root, ".deployment/family-report.json", "production",
      "https://mycafegourmand.com"), /NONPROMOTABLE/u);
    const login = readFileSync(path.join(data.root, "out/_family-test/login.html"), "utf8");
    for (const locale of ["en", "fr", "ru"]) assert.ok(login.includes(`lang="${locale}"`));
    assert.match(login, /\/.auth\/login\/aad/u);
    assert.match(login, /\/.auth\/login\/github/u);
    assert.ok(!login.includes("<script"));
    writeFileSync(path.join(data.root, "out/app.js"), "changed");
    assert.throws(() => validateFamilyTestArtifact(data.root), /inventory/u);
  } finally { data.cleanup(); }
});

test("production cannot be relabeled family and mixed receipt metadata is rejected", () => {
  const production = releaseFixture();
  const family = fixture();
  try {
    assert.throws(() => writeFamilyTestArtifact(production.root, origin, media), /production artifacts/u);
    assert.throws(() => validateFamilyTestArtifact(production.root));
    for (const file of ["release-artifact.json", "staging-acceptance.json", "production-acceptance.json"]) {
      writeFileSync(path.join(family.root, ".deployment", file), "{}");
      assert.throws(() => validateFamilyTestArtifact(family.root), /production artifacts/u);
      rmSync(path.join(family.root, ".deployment", file));
    }
    const metadata = JSON.parse(readFileSync(path.join(family.root, familyMetadataPath), "utf8"));
    writeFileSync(path.join(family.root, familyMetadataPath), JSON.stringify({ ...metadata, promotion: "production" }));
    assert.throws(() => validateFamilyTestArtifact(family.root));
  } finally { production.cleanup(); family.cleanup(); }
});

test("family namespace collisions and stale regenerated output fail closed", () => {
  for (const directory of ["_family-test", ".auth", "_FAMILY-TEST"]) {
    const data = releaseFixture(false);
    try {
      mkdirSync(path.join(data.root, "out", directory));
      writeFileSync(path.join(data.root, "out", directory, "data.json"), "{}");
      assert.throws(() => writeFamilyTestArtifact(data.root, origin, media), /reserved/u);
    } finally { data.cleanup(); }
  }
  const data = fixture();
  try {
    assert.throws(() => writeFamilyTestArtifact(data.root, origin, media));
  } finally { data.cleanup(); }
});

test("family verifier covers original encoding and index aliases in three simulated role contexts", async () => {
  const data = fixture();
  try {
    const requested = new Map<string, Set<string>>();
    const make = (context: "anonymous" | "nonmember" | "member") =>
      fakeTransport(data.root, context, (target, response) => {
        if (!requested.has(context)) requested.set(context, new Set());
        requested.get(context)!.add(target);
        return response;
      });
    const evidence = await verifyFamilyTest(data.root, {
      anonymous: make("anonymous"), nonmember: make("nonmember"), member: make("member")
    });
    assert.equal(evidence.kind, "family-test-access-evidence");
    assert.equal(evidence.promotion, "NONPROMOTABLE");
    assert.equal(evidence.checkedLegacySources, 3);
    for (const context of ["anonymous", "nonmember", "member"]) {
      for (const target of ["/app.js", "/recipes/new/index.html", "/recipes/new/", "/recipes/new",
        "/ru/%d0%ba%d0%be%d1%82/", wirePath("/fr/café/")]) {
        assert.ok(requested.get(context)!.has(target), `${context} missing ${target}`);
      }
    }
  } finally { data.cleanup(); }
});

test("live verification rejects self-signup/default-role bypass, login HTTP200, missing noindex and unavailable sessions", async () => {
  const data = fixture();
  try {
    const anonymous = fakeTransport(data.root, "anonymous");
    const nonmember = fakeTransport(data.root, "nonmember");
    const member = fakeTransport(data.root, "member");
    await assert.rejects(verifyFamilyTest(data.root, { anonymous, member }), /Real member/u);
    await assert.rejects(verifyFamilyTest(data.root, { anonymous, nonmember: member, member }), /role context/u);
    await assert.rejects(verifyFamilyTest(data.root, {
      anonymous: fakeTransport(data.root, "anonymous", (target, response) =>
        target === "/app.js" ? { ...response, status: 200 } : response), nonmember, member
    }), /validation failed/u);
    await assert.rejects(verifyFamilyTest(data.root, {
      anonymous, nonmember: fakeTransport(data.root, "nonmember", (target, response) =>
        target === "/app.js" ? { ...response, status: 200 } : response), member
    }), /validation failed/u);
    await assert.rejects(verifyFamilyTest(data.root, {
      anonymous, nonmember: fakeTransport(data.root, "nonmember", (target, response) =>
        target === "/app.js" ? { ...response, body: Buffer.from("application data with a 403 status") } : response), member
    }), /validation failed/u);
    await assert.rejects(verifyFamilyTest(data.root, {
      anonymous, nonmember, member: fakeTransport(data.root, "member", (target, response) =>
        target === "/app.js" ? { ...response, headers: { "content-type": "text/javascript" } } : response)
    }), /validation failed/u);
    const probe = await verifyFamilyTest(data.root, { anonymous }, true);
    assert.equal(probe.kind, "family-test-anonymous-probe");
    assert.deepEqual(probe.contexts, ["anonymous"]);
  } finally { data.cleanup(); }
});

test("private session files bind origin, reject permissions and never allow off-origin transport", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "family-session-test-"));
  const file = path.join(directory, "session.json");
  try {
    writeFileSync(file, JSON.stringify({ origin, cookie: "StaticWebAppsAuthCookie=sanitized-fixture" }), { mode: 0o600 });
    assert.equal(readFamilyCookie(file, origin, process.cwd()), "StaticWebAppsAuthCookie=sanitized-fixture");
    assert.throws(() => readFamilyCookie(file, "https://wrong.azurestaticapps.net", process.cwd()));
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      assert.throws(() => readFamilyCookie(file, origin, process.cwd()), /private/u);
      chmodSync(file, 0o600);
    }
    const transport = familySessionTransport(origin, "StaticWebAppsAuthCookie=sanitized-fixture");
    assert.throws(() => transport("https://evil.example", "/", 100));
    assert.throws(() => transport(origin, "//evil.example/", 100));
    assert.throws(() => familySessionTransport(origin, "cookie=value\r\nInjected: secret"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("public entries allow exactly one absolute or root-relative 301 to their retained clean alias", async () => {
  const data = fixture();
  try {
    for (const relative of [false, true]) {
      const requested: string[] = [];
      const anonymous = fakeTransport(data.root, "anonymous", (target, response) => {
        requested.push(target);
        if (relative && response.status === 301) {
          assert.ok(response.headers.location);
          return { ...response, headers: { ...response.headers, location: response.headers.location.slice(origin.length) } };
        }
        return response;
      }, true);
      const evidence = await verifyFamilyTest(data.root, {
        anonymous, nonmember: fakeTransport(data.root, "nonmember"), member: fakeTransport(data.root, "member")
      });
      assert.equal(evidence.promotion, "NONPROMOTABLE");
      for (const page of familyTestPublicPages) {
        assert.equal(requested.filter((target) => target === page).length, 1);
        assert.equal(requested.filter((target) => target === `${page.slice(0, -".html".length)}/`).length, 1);
      }
    }
  } finally { data.cleanup(); }
});

test("public entry normalization rejects other redirects, unsafe locations and loops without following them", async () => {
  const data = fixture();
  try {
    for (const page of familyTestPublicPages) {
      const alias = `${page.slice(0, -".html".length)}/`;
      const locations = [
        "", "https://[", `https://foreign.example${alias}`, `//foreign.example${alias}`,
        `${origin}/unrelated/`, `${origin}${alias}?changed=1`, `${origin}${alias}#changed`,
        `${origin}${alias}?`, `${origin}${alias}#`, `${origin}/other/../${alias.slice(1)}`,
        `${origin}${alias.replace("/_family-test/", "/%5ffamily-test/")}`,
        `${origin}${alias.slice(0, -1)}`, `${origin}${page}`, `${origin}${page}/`,
        `${origin}${alias}index.html`, `https://user@${new URL(origin).host}${alias}`
      ];
      for (const location of locations) {
        const requested: string[] = [];
        await assert.rejects(verifyFamilyTest(data.root, {
          anonymous: fakeTransport(data.root, "anonymous", (target, response) => {
            requested.push(target);
            return target === page ? { ...response, headers: { ...response.headers, location } } : response;
          }, true)
        }, true), /validation failed/u);
        assert.ok(!requested.includes(alias), `Must not follow rejected location: ${location}`);
      }
      for (const status of [302, 303, 307, 308]) {
        const requested: string[] = [];
        await assert.rejects(verifyFamilyTest(data.root, {
          anonymous: fakeTransport(data.root, "anonymous", (target, response) => {
            requested.push(target);
            return target === page ? { ...response, status } : response;
          }, true)
        }, true), /validation failed/u);
        assert.ok(!requested.includes(alias));
      }
      for (const location of [page, alias, "/another-hop/"]) {
        const requested: string[] = [];
        await assert.rejects(verifyFamilyTest(data.root, {
          anonymous: fakeTransport(data.root, "anonymous", (target, response) => {
            requested.push(target);
            return target === alias ? { ...response, status: 301, headers: { ...response.headers, location } } : response;
          }, true)
        }, true), /validation failed/u);
        assert.equal(requested.filter((target) => target === page).length, 1);
        assert.equal(requested.filter((target) => target === alias).length, 1);
        assert.ok(!requested.includes("/another-hop/"));
      }
    }
  } finally { data.cleanup(); }
});

test("normalized public pages must match retained bytes, HTML MIME and every reviewed header", async () => {
  const root = bootstrapRoot();
  try {
    buildFamilyBootstrap(root, origin);
    const headers = Object.keys(z.object({ globalHeaders: z.record(z.string(), z.string()) }).parse(
      JSON.parse(readFileSync(path.join(root, "out/staticwebapp.config.json"), "utf8"))
    ).globalHeaders).map((key) => key.toLowerCase());
    const mutations: ((response: SiteResponse) => SiteResponse)[] = [
      (response) => ({ ...response, body: Buffer.alloc(response.body.length, "x") }),
      (response) => ({ ...response, body: Buffer.concat([response.body, Buffer.from("extra")]) }),
      (response) => ({ ...response, headers: { ...response.headers, "content-type": "application/json" } }),
      (response) => ({ ...response, headers: { ...response.headers, "content-type": "" } }),
      ...headers.flatMap((header) => [
        (response: SiteResponse) => ({ ...response, headers: { ...response.headers, [header]: "wrong" } }),
        (response: SiteResponse) => ({
          ...response, headers: Object.fromEntries(Object.entries(response.headers).filter(([key]) => key !== header))
        })
      ])
    ];
    for (const page of familyTestPublicPages) {
      const alias = `${page.slice(0, -".html".length)}/`;
      for (const mutate of mutations) {
        await assert.rejects(verifyFamilyTest(root, {
          anonymous: fakeTransport(root, "anonymous", (target, response) =>
            target === alias ? mutate(response) : response, true)
        }, true), /validation failed/u);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("normalized public entries never permit protected bootstrap endpoints to return content or login HTTP200", async () => {
  const root = bootstrapRoot();
  try {
    buildFamilyBootstrap(root, origin);
    for (const target of [
      "/", "/index.html", "/_family-test/probe.html", "/_family-test/probe/", "/fr/", "/ru/",
      "/_family-test/login/index.html", "/_family-test/denied/index.html",
      "/__family_missing__", "/_next/__missing__", "/_search/__missing__.json", "/staticwebapp.config.json"
    ]) {
      for (const file of ["index.html", "_family-test/login.html"]) {
        const body = readFileSync(path.join(root, "out", file));
        await assert.rejects(verifyFamilyTest(root, {
          anonymous: fakeTransport(root, "anonymous", (requested, response) =>
            requested === target ? { ...response, status: 200, body } : response, true)
        }, true), /validation failed|Anonymous access/u);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap is content-free, freshly generated and nonpromotable", () => {
  const root = bootstrapRoot();
  try {
    const result = buildFamilyBootstrap(root, origin);
    assert.equal(result.metadata.purpose, "bootstrap");
    assert.equal(result.metadata.mediaBase, null);
    assert.equal(result.metadata.files.length, 5);
    assert.deepEqual(result.metadata.files.map((file) => file.path).sort(), [
      "_family-test/denied.html", "_family-test/login.html", "_family-test/probe.html",
      "index.html", "staticwebapp.config.json"
    ]);
    const rootPage = readFileSync(path.join(root, "out/index.html"), "utf8");
    assert.equal(rootPage, "<!doctype html><html lang=\"en\"><head><meta name=\"robots\" content=\"noindex\"><title>Family access probe</title></head><body>Invited family access is active. NONPROMOTABLE test.</body></html>\n");
    assert.equal(rootPage, readFileSync(path.join(root, "out/_family-test/probe.html"), "utf8"));
    const config = z.object({
      routes: z.array(z.object({ route: z.string(), allowedRoles: z.array(z.string()) })),
      globalHeaders: z.record(z.string(), z.string())
    }).parse(JSON.parse(readFileSync(path.join(root, "out/staticwebapp.config.json"), "utf8")));
    for (const target of ["/", "/index.html"]) {
      const firstMatch = config.routes.find(({ route }) => route === target
        || (route.endsWith("*") && target.startsWith(route.slice(0, -1))));
      assert.deepEqual(firstMatch, { route: "/*", allowedRoles: ["family"] });
    }
    assert.equal(config.globalHeaders["X-Robots-Tag"], "noindex");
    assert.equal(config.globalHeaders["Cache-Control"], "private, no-store");
    assert.equal(config.globalHeaders["Content-Security-Policy"], "form-action 'none'");
    assert.equal(result.manifest.redirects.length, 0);
    assert.throws(() => buildFamilyBootstrap(root, origin), /fresh checkout/u);
    assert.throws(() => validateReleaseArtifact(root, "production"), /NONPROMOTABLE/u);
    assert.match(readFileSync(path.join(root, "out/_family-test/login.html"), "utf8"), /probe.html/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap rejects a missing root entrypoint even with a matching inventory", () => {
  const root = bootstrapRoot();
  try {
    const { metadata } = buildFamilyBootstrap(root, origin);
    rmSync(path.join(root, "out/index.html"), { force: true });
    writeFileSync(path.join(root, familyMetadataPath), JSON.stringify({
      ...metadata, files: inventoryOutput(path.join(root, "out"))
    }));
    assert.throws(() => validateFamilyTestArtifact(root), /Bootstrap/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap rejects tampered root bytes and replacement paths even with matching inventories", () => {
  for (const replacement of ["index.html", "Index.html", "unexpected.html"]) {
    const root = bootstrapRoot();
    try {
      const { metadata } = buildFamilyBootstrap(root, origin);
      const rootPage = readFileSync(path.join(root, "out/index.html"));
      rmSync(path.join(root, "out/index.html"));
      writeFileSync(path.join(root, "out", replacement),
        replacement === "index.html" ? "<!doctype html><p>Unexpected content</p>" : rootPage);
      assert.throws(() => validateFamilyTestArtifact(root), /inventory/u);
      writeFileSync(path.join(root, familyMetadataPath), JSON.stringify({
        ...metadata, files: inventoryOutput(path.join(root, "out"))
      }));
      assert.throws(() => validateFamilyTestArtifact(root), /Bootstrap/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("bootstrap rejects anonymous root exceptions even with a matching inventory", () => {
  for (const route of ["/", "/index.html"]) {
    const root = bootstrapRoot();
    try {
      const { metadata } = buildFamilyBootstrap(root, origin);
      const configPath = path.join(root, "out/staticwebapp.config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.routes.unshift({ route, allowedRoles: ["anonymous"] });
      writeFileSync(configPath, JSON.stringify(config));
      writeFileSync(path.join(root, familyMetadataPath), JSON.stringify({
        ...metadata, files: inventoryOutput(path.join(root, "out"))
      }));
      assert.throws(() => validateFamilyTestArtifact(root), /access policy mismatch/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("observed bootstrap normalization preserves root denial and all three simulated role contexts", async () => {
  const root = bootstrapRoot();
  try {
    buildFamilyBootstrap(root, origin);
    const requested = new Map<string, Set<string>>();
    const make = (context: "anonymous" | "nonmember" | "member") => {
      const targets = new Set<string>();
      requested.set(context, targets);
      return fakeTransport(root, context, (target, response) => {
        targets.add(target);
        return response;
      }, true);
    };
    const evidence = await verifyFamilyTest(root, {
      anonymous: make("anonymous"), nonmember: make("nonmember"), member: make("member")
    });
    assert.equal(evidence.purpose, "bootstrap");
    assert.equal(evidence.promotion, "NONPROMOTABLE");
    for (const target of ["/_family-test/login/", "/_family-test/denied/"]) {
      assert.ok(requested.get("anonymous")!.has(target));
    }
    for (const [context, targets] of requested) {
      for (const target of ["/", "/index.html", "/_family-test/probe.html"]) {
        assert.ok(targets.has(target), `${context} missing ${target}`);
      }
    }
    for (const context of ["anonymous", "nonmember"]) {
      for (const target of ["/fr/", "/ru/", "/_family-test/probe/",
        "/_family-test/login/index.html", "/_family-test/denied/index.html"]) {
        assert.ok(requested.get(context)!.has(target), `${context} missing ${target}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("family reports cannot substitute for production staging receipts", async () => {
  const family = fixture();
  const production = releaseFixture();
  try {
    const evidence = await verifyFamilyTest(family.root, {
      anonymous: fakeTransport(family.root, "anonymous"),
      nonmember: fakeTransport(family.root, "nonmember"),
      member: fakeTransport(family.root, "member")
    });
    writeFileSync(path.join(production.root, ".deployment/staging-acceptance.json"), JSON.stringify(evidence));
    assert.throws(() => validateAcceptanceReceipt(production.root, ".deployment/staging-acceptance.json", "staging", origin));
  } finally { family.cleanup(); production.cleanup(); }
});

test("CLI does not print invalid cookie contents or issue evidence on a private-input failure", () => {
  const data = fixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), "family-cookie-redaction-"));
  const cookie = path.join(directory, "session.json");
  try {
    writeFileSync(cookie, "sanitized-sensitive-marker invalid json", { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/verify-family-test.ts", data.root,
      "--member-cookie-file", cookie, "--nonmember-cookie-file", cookie,
      "--report", path.join(directory, "report.json")
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /family-test-verification-failed/u);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /sanitized-sensitive-marker/u);
  } finally { data.cleanup(); rmSync(directory, { recursive: true, force: true }); }
});

test("family deployment workflow is manual, protected, isolated and never issues production acceptance", () => {
  const text = readFileSync(path.join(process.cwd(), ".github/workflows/family-test.yml"), "utf8");
  assert.match(text, /workflow_dispatch:/u);
  assert.match(text, /environment: family-test/u);
  assert.match(text, /scripts\/workflow-family-test.ts/u);
  assert.match(text, /family-test-NONPROMOTABLE/u);
  assert.match(text, /--anonymous-only/u);
  assert.match(text, /skip_app_build: true/u);
  assert.match(text, /skip_api_build: true/u);
  assert.match(text, /cancel-in-progress: false/u);
  assert.doesNotMatch(text, /pull_request:|push:|build:release|accepted-production|production-acceptance|staging-acceptance|cookie-file|deployment_environment:/u);
  const actions = [...text.matchAll(/uses: ([^\s]+)/gu)].map((match) => match[1]);
  assert.ok(actions.every((action) => /@[a-f0-9]{40}$/u.test(action)));
});
