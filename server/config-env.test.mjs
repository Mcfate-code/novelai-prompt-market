import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const NODE = process.execPath;
const PROVIDER_PATH = fileURLToPath(new URL("./novelai-provider.mjs", import.meta.url));

async function writeSettings(dir, obj) {
  if (obj) await writeFile(path.join(dir, "tags-market-settings.json"), JSON.stringify(obj));
}

// 在受控环境里重新导入 provider（WORKBUDDY_HOME / NAI_PROXY_URL 均在模块加载或调用时读取）。
async function probeProviderEnv({ workbuddyHome, proxyUrl, apiKey }) {
  const script = `
    import { NovelAIProvider, readNovelAIBatchLimit } from ${JSON.stringify(PROVIDER_PATH)};
    const provider = new NovelAIProvider();
    console.log(JSON.stringify({ network: provider.network, configured: provider.configured, batchLimit: readNovelAIBatchLimit() }));
  `;
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    NOVELAI_API_KEY: apiKey ?? "",
    NAI_PROXY_URL: proxyUrl ?? "",
    WORKBUDDY_HOME: workbuddyHome,
  };
  const { stdout } = await execFileAsync(NODE, ["--input-type=module", "-e", script], { env });
  return JSON.parse(stdout.trim());
}

test("honors WORKBUDDY_HOME for token, batch limit and settings-file proxy", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "tags-market-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeSettings(dir, {
    novelai_api_token: "file-token-abc",
    novelai_batch_max_count: 6,
    proxy_enabled: true,
    proxy_url: "http://file-proxy:1234",
  });

  const result = await probeProviderEnv({ workbuddyHome: dir });
  assert.equal(result.configured, true, "token 应从 $WORKBUDDY_HOME/tags-market-settings.json 读取");
  assert.equal(result.batchLimit, 6, "batch limit 应从 $WORKBUDDY_HOME 读取");
  assert.equal(result.network, "http://file-proxy:1234", "无 NAI_PROXY_URL 时使用设置文件里的代理");
});

test("clamps settings-file batch limit above 6 down to the hard cap", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "tags-market-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeSettings(dir, {
    novelai_api_token: "file-token-abc",
    novelai_batch_max_count: 42, // 历史值可能超过 6，读取时钳制到硬上限
  });

  const result = await probeProviderEnv({ workbuddyHome: dir });
  assert.equal(result.batchLimit, 6, ">6 的 batch limit 应被钳制到 6");
});

test("NAI_PROXY_URL environment variable takes priority over the settings-file proxy", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "tags-market-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeSettings(dir, {
    novelai_api_token: "file-token-abc",
    proxy_enabled: false, // 即使文件里关闭了代理
    proxy_url: "http://file-proxy:1234",
  });

  const result = await probeProviderEnv({ workbuddyHome: dir, proxyUrl: "http://env-proxy:8888" });
  assert.equal(result.network, "http://env-proxy:8888", "环境变量 NAI_PROXY_URL 必须优先");
  assert.equal(result.configured, true, "token 仍从设置文件读取，不受代理覆盖影响");
});

test("empty WORKBUDDY_HOME defaults to direct network and unconfigured state", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "tags-market-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 不写任何设置文件

  const result = await probeProviderEnv({ workbuddyHome: dir });
  assert.equal(result.network, "direct");
  assert.equal(result.configured, false);
  assert.equal(result.batchLimit, 6, "无设置文件时回退默认 batch limit 6");
});
