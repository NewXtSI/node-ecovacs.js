import { readFile, writeFile } from "node:fs/promises";

async function readJsonFile(filePath) {
  let raw;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        `Missing required file: ${filePath}. Create it before starting the app.`
      );
    }

    throw error;
  }

  return JSON.parse(raw);
}

export async function writeTopicsFile(filePath, topics) {
  const json = JSON.stringify(topics, null, 2) + "\n";
  await writeFile(filePath, json, "utf8");
}

export async function loadConfig() {
  const [settings, credentials, topics] = await Promise.all([
    readJsonFile("settings.json"),
    readJsonFile("credentials.json"),
    readJsonFile("topics.json")
  ]);

  return {
    settings,
    credentials,
    topics
  };
}
