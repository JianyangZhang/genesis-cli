#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dirname, "..");

const PACKAGE_PATHS = [
  "packages/pi-ai/package.json",
  "packages/app-tools/package.json",
  "packages/app-config/package.json",
  "packages/kernel/package.json",
  "packages/app-runtime/package.json",
  "packages/app-tui-core/package.json",
  "packages/app-ui/package.json",
  "packages/app-extensions/package.json",
  "packages/app-evaluation/package.json",
  "packages/app-cli/package.json",
];

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const RELEASE_TYPES = new Set(["patch", "minor", "major", "prerelease"]);

function usage() {
  process.stderr.write(`Usage: node ./scripts/bump-version.mjs <patch|minor|major|prerelease> [--preid <id>] [--dry-run]\n`);
}

function parseArgs(argv) {
  const releaseType = argv[0];
  if (!RELEASE_TYPES.has(releaseType)) {
    usage();
    process.exit(1);
  }

  let preid = "alpha";
  let dryRun = false;

  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (value === "--preid") {
      preid = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    process.stderr.write(`Unknown argument: ${value}\n`);
    usage();
    process.exit(1);
  }

  if (!/^[0-9A-Za-z-]+$/.test(preid)) {
    process.stderr.write(`Invalid prerelease identifier: ${preid}\n`);
    process.exit(1);
  }

  return { releaseType, preid, dryRun };
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?$/);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prereleaseId: match[4] ?? null,
    prereleaseNumber: match[5] ? Number(match[5]) : null,
  };
}

function formatVersion(parts) {
  const base = `${parts.major}.${parts.minor}.${parts.patch}`;
  if (parts.prereleaseId === null || parts.prereleaseNumber === null) {
    return base;
  }
  return `${base}-${parts.prereleaseId}.${parts.prereleaseNumber}`;
}

function bumpVersion(version, releaseType, preid) {
  const next = parseVersion(version);

  switch (releaseType) {
    case "patch":
      next.patch += 1;
      next.prereleaseId = null;
      next.prereleaseNumber = null;
      break;
    case "minor":
      next.minor += 1;
      next.patch = 0;
      next.prereleaseId = null;
      next.prereleaseNumber = null;
      break;
    case "major":
      next.major += 1;
      next.minor = 0;
      next.patch = 0;
      next.prereleaseId = null;
      next.prereleaseNumber = null;
      break;
    case "prerelease":
      if (next.prereleaseId === preid && next.prereleaseNumber !== null) {
        next.prereleaseNumber += 1;
      } else {
        next.patch += 1;
        next.prereleaseId = preid;
        next.prereleaseNumber = 0;
      }
      break;
    default:
      throw new Error(`Unhandled release type: ${releaseType}`);
  }

  return formatVersion(next);
}

function readPackage(filePath) {
  const absolutePath = resolve(ROOT_DIR, filePath);
  const content = readFileSync(absolutePath, "utf8");
  return {
    absolutePath,
    filePath,
    json: JSON.parse(content),
  };
}

function writePackage(pkg, dryRun) {
  const content = `${JSON.stringify(pkg.json, null, 2)}\n`;
  if (!dryRun) {
    writeFileSync(pkg.absolutePath, content);
  }
}

function main() {
  const { releaseType, preid, dryRun } = parseArgs(process.argv.slice(2));
  const packages = PACKAGE_PATHS.map(readPackage);
  const targetVersions = new Map(
    packages.map((pkg) => [pkg.json.name, bumpVersion(pkg.json.version, releaseType, preid)]),
  );

  for (const pkg of packages) {
    const currentVersion = pkg.json.version;
    const nextVersion = targetVersions.get(pkg.json.name);
    pkg.json.version = nextVersion;

    for (const field of DEPENDENCY_FIELDS) {
      const deps = pkg.json[field];
      if (!deps) {
        continue;
      }
      for (const dependencyName of Object.keys(deps)) {
        const dependencyVersion = targetVersions.get(dependencyName);
        if (dependencyVersion) {
          deps[dependencyName] = dependencyVersion;
        }
      }
    }

    writePackage(pkg, dryRun);
    process.stdout.write(`${pkg.json.name}: ${currentVersion} -> ${nextVersion}${dryRun ? " (dry-run)" : ""}\n`);
  }
}

main();
