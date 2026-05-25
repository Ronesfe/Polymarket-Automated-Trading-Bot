import { loadConfig, validateConfig } from "./config";
import { initLogger, getLogger } from "./utils/logger";
import { Bot } from "./services/bot"; 

async function main() {
  try {
    const config = loadConfig();

    initLogger(config.logLevel, config.logFile);
    const log = getLogger();

    validateConfig(config);

    const bot = new Bot(config);
    await bot.start();
  } catch (err) {
    console.error("Fatal error:", err);
    process.exitCode = 1;

    setInterval(() => {}, 60_000);
  }
}

main();