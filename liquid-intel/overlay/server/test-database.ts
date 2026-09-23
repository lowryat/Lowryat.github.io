import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Pool } from "pg";

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}:\n${output}`));
    });
  });
}

export async function runInTemporaryDatabase(
  testFile: string,
  workerEnvironmentVariable: string,
): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }

  const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const databaseName = `analysis_alert_test_${randomUUID().replaceAll("-", "")}`;
  const testDatabaseUrl = new URL(process.env.DATABASE_URL);
  testDatabaseUrl.pathname = `/${databaseName}`;
  testDatabaseUrl.search = "";

  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    // The worker must not inherit the parent runner's NODE_TEST_CONTEXT: with it
    // set, the child streams results in the parent's private format and exits 0
    // even when its tests fail, so the wrapper test passed on real failures.
    const { NODE_TEST_CONTEXT: _parentContext, ...inherited } = process.env;
    const env = {
      ...inherited,
      DATABASE_URL: testDatabaseUrl.toString(),
    };
    await run("npx", ["drizzle-kit", "push", "--force"], env);
    await run(
      process.execPath,
      ["--import", "tsx", "--test", testFile],
      { ...env, [workerEnvironmentVariable]: "1" },
    );
  } finally {
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
      [databaseName],
    ).catch(() => undefined);
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  }
}