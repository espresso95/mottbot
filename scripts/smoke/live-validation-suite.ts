#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { listCliFlagNames } from "./cli-args.js";
import {
  buildLiveValidationPlan,
  parseLiveValidationOptions,
  type LiveValidationPlan,
  type LiveValidationScenario,
} from "./live-validation-suite-helpers.js";

/** Result for one live validation scenario script. */
export type ScenarioResult = {
  kind: LiveValidationScenario["kind"];
  name: string;
  script: LiveValidationScenario["script"];
  status: "passed" | "failed";
  exitCode: number | null;
  output?: unknown;
  stdout?: string;
  stderr?: string;
};

/** Aggregate report and exit code returned by the live validation suite. */
export type LiveValidationSuiteResult = {
  report: unknown;
  exitCode: number;
};

/** Injectable runner used to execute or test live validation scenarios. */
export type ScenarioRunner = (item: LiveValidationScenario) => Promise<ScenarioResult>;

/** Builds the pnpm command argv for one smoke scenario. */
export function buildScenarioCommandArgs(item: LiveValidationScenario): string[] {
  return ["pnpm", "--silent", item.script, ...item.args];
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function boundedText(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 4_000 ? trimmed.slice(-4_000) : trimmed;
}

function parseJsonOutput(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/* v8 ignore start */
async function runScenario(item: LiveValidationScenario): Promise<ScenarioResult> {
  const child = spawn("corepack", buildScenarioCommandArgs(item), {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  const stderrText = Buffer.concat(stderr).toString("utf8");
  const output = parseJsonOutput(stdoutText);
  return {
    kind: item.kind,
    name: item.name,
    script: item.script,
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    ...(output ? { output } : { stdout: boundedText(stdoutText) }),
    ...(boundedText(stderrText) ? { stderr: boundedText(stderrText) } : {}),
  };
}
/* v8 ignore stop */

/** Executes a live validation plan or renders its dry-run report. */
export async function createLiveValidationSuiteResult(params: {
  plan: LiveValidationPlan;
  argv?: string[];
  run?: ScenarioRunner;
}): Promise<LiveValidationSuiteResult> {
  const plan = params.plan;
  if (plan.issues.length > 0) {
    return {
      exitCode: 1,
      report: {
        status: "blocked",
        issues: plan.issues,
        skipped: plan.skipped,
        scenarios: plan.scenarios.map(({ kind, name, script }) => ({ kind, name, script })),
      },
    };
  }
  if (plan.dryRun || (params.argv ?? []).includes("--dry-run")) {
    return {
      exitCode: 0,
      report: {
        status: "dry-run",
        skipped: plan.skipped,
        scenarios: plan.scenarios.map(({ kind, name, script, args }) => ({
          kind,
          name,
          script,
          argKeys: listCliFlagNames(args),
        })),
      },
    };
  }

  const results: ScenarioResult[] = [];
  const run = params.run ?? runScenario;
  for (const item of plan.scenarios) {
    results.push(await run(item));
  }
  const failed = results.filter((result) => result.status === "failed");
  return {
    exitCode: failed.length > 0 ? 1 : 0,
    report: {
      status: failed.length > 0 ? "failed" : "passed",
      skipped: plan.skipped,
      scenarios: results,
    },
  };
}

async function main(): Promise<void> {
  const options = parseLiveValidationOptions(process.argv.slice(2));
  const result = await createLiveValidationSuiteResult({
    plan: buildLiveValidationPlan(options),
    argv: process.argv,
  });
  printJson(result.report);
  process.exitCode = result.exitCode;
}

/* v8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printJson({ status: "failed", error: message });
    process.exitCode = 1;
  }
}
/* v8 ignore stop */
