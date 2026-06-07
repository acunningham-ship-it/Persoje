import * as readline from "node:readline/promises";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_PATH, type PersojeConfig } from "../config/config.ts";

interface ModelInfo {
  id: string;
  name?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  supported_parameters?: string[];
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/armani/persoje",
        "X-Title": "Persoje",
      },
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function fetchModels(apiKey: string): Promise<ModelInfo[]> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/armani/persoje",
        "X-Title": "Persoje",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return [];

    const data = (await response.json()) as { data?: ModelInfo[] };
    return data.data ?? [];
  } catch {
    return [];
  }
}

function isToolCapable(model: ModelInfo): boolean {
  const params = model.supported_parameters ?? [];
  return params.includes("tools");
}

function isFree(model: ModelInfo): boolean {
  const pricing = model.pricing ?? {};
  const prompt = pricing.prompt ?? "";
  const completion = pricing.completion ?? "";
  return prompt === "0" || completion === "0" || model.id.endsWith(":free");
}

export async function runSetupWizard(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n🔧 Persoje First-Time Setup\n");

    // Step 1: API Key
    let apiKey = process.env.OPENROUTER_API_KEY ?? "";
    if (apiKey) {
      const confirm = await rl.question(`Use OPENROUTER_API_KEY from environment? (y/n) `);
      if (confirm.toLowerCase() !== "y") apiKey = "";
    }

    if (!apiKey) {
      let retries = 0;
      while (retries < 2) {
        apiKey = await rl.question("OpenRouter API Key: ");
        const valid = await validateApiKey(apiKey);
        if (valid) break;
        console.log("  ✗ Invalid key. Please try again.");
        retries++;
      }
      if (retries >= 2) {
        console.log("  ⚠ Setup skipped (could not validate API key).");
        return false;
      }
    }

    // Step 2: Model selection
    console.log("\nFetching available models...");
    const models = await fetchModels(apiKey);
    const toolModels = models.filter(isToolCapable);
    const freeToolModels = toolModels.filter(isFree).slice(0, 5);

    const options: Array<{ label: string; id: string }> = [];
    for (const m of freeToolModels) {
      options.push({ label: m.id, id: m.id });
    }
    options.push({ label: "Enter a model ID manually", id: "manual" });
    options.push({ label: "openrouter/auto", id: "openrouter/auto" });

    console.log("\nAvailable models:");
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      console.log(`  ${i + 1}. ${opt!.label}`);
    }

    const choiceStr = await rl.question("Choose a model (1-" + options.length + "): ");
    const choiceIdx = parseInt(choiceStr, 10) - 1;
    if (choiceIdx < 0 || choiceIdx >= options.length) {
      console.log("  ✗ Invalid choice.");
      return false;
    }

    const chosen = options[choiceIdx];
    if (!chosen) {
      console.log("  ✗ Invalid choice.");
      return false;
    }

    let modelId = chosen.id;
    if (modelId === "manual") {
      modelId = await rl.question("Model ID: ");
    }

    // Step 3: Write config
    await mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
    const existing = await readJsonIfExists(GLOBAL_CONFIG_PATH);
    const config: Record<string, unknown> = existing ?? {};

    if (typeof config.model !== "object" || config.model === null) config.model = {};
    const modelCfg = config.model as Record<string, unknown>;
    modelCfg.primary = modelId;

    if (typeof config.openrouter !== "object" || config.openrouter === null) config.openrouter = {};
    const orCfg = config.openrouter as Record<string, unknown>;
    if (!orCfg.apiKey && apiKey !== process.env.OPENROUTER_API_KEY) {
      orCfg.apiKey = apiKey;
    }

    await writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));

    // Step 4: Create memory dirs
    await mkdir(`${GLOBAL_CONFIG_DIR}/memory`, { recursive: true });
    await mkdir(`${GLOBAL_CONFIG_DIR}/skills`, { recursive: true });

    console.log(`\n✓ Setup complete!`);
    console.log(`  Config: ${GLOBAL_CONFIG_PATH}`);
    console.log(`  Model: ${modelId}\n`);

    return true;
  } finally {
    rl.close();
  }
}
