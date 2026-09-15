import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { test, before, after } from "node:test";
import { promisify } from "node:util";

const execFile = promisify((file, args, options, callback) => {
  const child = spawn(file, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => callback(error));
  child.on("close", (code, signal) => callback(null, { stdout, stderr, code, signal }));
});

const packageRoot = new URL("../../", import.meta.url);
const packagePath = packageRoot.pathname;
const port = 4179;
const baseUrl = `http://127.0.0.1:${port}`;
let vite;

function probeServer() {
  return new Promise((resolve, reject) => {
    const probe = request(`${baseUrl}/test/browser/delivery-tab.html`, { method: "HEAD" }, (response) => {
      response.resume();
      resolve(response.statusCode && response.statusCode < 500);
    });
    probe.once("error", reject);
    probe.end();
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (await probeServer()) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the local Vite browser harness server");
}

before(async () => {
  vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
    cwd: packagePath,
    env: { ...process.env, BASE_PATH: "/", PORT: String(port), NODE_ENV: "production", REPL_ID: "" },
    stdio: "ignore",
  });
  await waitForServer();
});

after(async () => {
  if (!vite || vite.exitCode !== null) return;
  vite.kill("SIGTERM");
  await Promise.race([
    once(vite, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (vite.exitCode === null) vite.kill("SIGKILL");
});

async function runBrowserScenario(name) {
  const chromium = process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium";
  const url = `${baseUrl}/test/browser/delivery-tab.html?scenario=${encodeURIComponent(name)}`;
  const result = await execFile(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=AsyncDns,DnsOverHttps",
    "--host-resolver-rules=MAP * 127.0.0.1,EXCLUDE 127.0.0.1",
    "--no-first-run",
    "--virtual-time-budget=6000",
    "--dump-dom",
    url,
  ], { cwd: packagePath, maxBuffer: 2 * 1024 * 1024 });

  assert.equal(result.code, 0, `${name}: Chromium exited unsuccessfully: ${result.stderr}`);
  const match = result.stdout.match(/<pre id="harness-result">([\s\S]*?)<\/pre>/);
  assert.ok(
    match,
    `${name}: browser harness did not publish a result. DOM tail: ${result.stdout.slice(-4000)}`,
  );
  const report = JSON.parse(match[1]);
  assert.equal(report.pass, true, `${name}: browser assertions failed: ${JSON.stringify(report)}`);
  assert.deepEqual(
    { pass: report.pass, scenario: report.scenario, failures: report.failures },
    { pass: true, scenario: name, failures: [] },
  );
}

for (const scenario of ["owner", "admin", "viewer", "nonmanager", "cross-studio"]) {
  test(`DeliveryTab browser harness: ${scenario}`, async () => {
    await runBrowserScenario(scenario);
  });
}
