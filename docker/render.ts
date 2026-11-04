/**
 * Renders S3 credentials from apps/backend/.env into docker configs.
 *
 * Reads   docker/{thanos,loki,tempo}/*.tpl   (templates, {{VAR}} placeholders)
 * Writes  docker/rendered/<dir>-<name>       (gitignored, real credentials)
 *
 * Derived vars:
 *   AWS_S3_ENDPOINT: AWS_ENDPOINT_URL_S3 with the scheme stripped
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dockerDir = dirname(fileURLToPath(import.meta.url));
const backendEnvPath = resolve(dockerDir, "..", "apps", "backend", ".env");
const renderedDir = join(dockerDir, "rendered");

// --- load env -------------------------------------------------------------
const env: Record<string, string> = {};
for (const line of readFileSync(backendEnvPath, "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  // strip surrounding quotes (single or double)
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  env[key] = value;
}

const required = [
  "AWS_ENDPOINT_URL_S3",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "S3_BUCKET_LOGS",
  "S3_BUCKET_METRICS",
  "S3_BUCKET_TRACES",
] as const;
for (const key of required) {
  if (!env[key]) throw new Error(`${backendEnvPath} is missing ${key}`);
}

const awsEndpoint = env.AWS_ENDPOINT_URL_S3.replace(/^https?:\/\//, "").replace(/\/+$/, "");

const context = {
  ...env,
  AWS_S3_ENDPOINT: awsEndpoint,
  // temp credentials for *this renderer run* only — never write these keys
  // into rendered files themselves except through the explicit placeholders
};

// --- render templates ----------------------------------------------------
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? [] : [full];
  });
}

const templates = [
  ...walk(join(dockerDir, "thanos")),
  ...walk(join(dockerDir, "loki")),
  ...walk(join(dockerDir, "tempo")),
].filter((file) => file.endsWith(".tpl"));

mkdirSync(renderedDir, { recursive: true });

for (const templatePath of templates) {
  let content = readFileSync(templatePath, "utf8");
  for (const [key, value] of Object.entries(context)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  const leftover = content.match(/\{\{[A-Z_0-9]+\}\}/);
  if (leftover) {
    throw new Error(`${templatePath} references unknown var: ${leftover[0]}`);
  }
  const dirName = basename(dirname(templatePath));
  const fileName = basename(templatePath, ".tpl");
  const target = join(renderedDir, `${dirName}-${fileName}`);
  writeFileSync(target, content);
  console.log(`rendered ${target}`);
}
