import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseExactRedirectManifest } from "../content/redirect-manifest";
import { validateLegacyNavigationOutput } from "../../scripts/legacy-navigation";

export function assertReleaseDeploymentIntegration(projectRoot: string = process.cwd()) {
  const metadataRoot = path.join(projectRoot, ".deployment");
  const metadataStats = lstatSync(metadataRoot);
  const manifestPath = path.join(metadataRoot, "redirect-manifest.json");
  const stats = lstatSync(manifestPath);
  if (
    metadataStats.isSymbolicLink() || !metadataStats.isDirectory()
    || stats.isSymbolicLink() || !stats.isFile() || stats.size > 4 * 1024 * 1024
  ) {
    throw new Error("Legacy navigation metadata must be a bounded regular file.");
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateLegacyNavigationOutput(
    parseExactRedirectManifest(manifest),
    path.join(projectRoot, "out")
  );
}
