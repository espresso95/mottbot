import { spawnSync } from "node:child_process";

type VerifyMode = "quick" | "full";

type VerifyTask = {
  label: string;
  args: string[];
};

const quickTasks: VerifyTask[] = [
  { label: "TypeScript", args: ["check"] },
  { label: "ESLint", args: ["lint"] },
  { label: "Prettier", args: ["format:check"] },
  { label: "TSDoc", args: ["tsdoc:audit", "--", "--strict"] },
  { label: "Docs", args: ["docs:check"] },
  { label: "Dependency cycles", args: ["deps:cycles"] },
  { label: "Knip", args: ["knip"] },
];

const fullTasks: VerifyTask[] = [
  ...quickTasks,
  { label: "Build", args: ["build"] },
  { label: "Coverage", args: ["test:coverage"] },
];

function parseMode(argv: string[]): VerifyMode {
  if (argv.includes("--quick")) {
    return "quick";
  }
  if (argv.includes("--full") || argv.length === 0) {
    return "full";
  }
  throw new Error(`Unknown verify arguments: ${argv.join(" ")}`);
}

function runTask(task: VerifyTask): boolean {
  console.log(`\n==> ${task.label}`);
  const result = spawnSync("corepack", ["pnpm", ...task.args], { stdio: "inherit" });
  if (result.error) {
    console.error(`Failed to run ${task.label}: ${result.error.message}`);
    return false;
  }
  if (result.signal) {
    console.error(`${task.label} terminated by signal ${result.signal}.`);
    return false;
  }
  return result.status === 0;
}

try {
  const mode = parseMode(process.argv.slice(2));
  const tasks = mode === "quick" ? quickTasks : fullTasks;
  for (const task of tasks) {
    if (!runTask(task)) {
      process.exit(1);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
