import winston from "winston";

let logger: winston.Logger;

export function initLogger(level: string, logFile: string): winston.Logger {
  logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
        return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}`;
      })
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: "HH:mm:ss" }),
          winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level} ${message}`;
          })
        ),
      }),
      new winston.transports.File({ filename: logFile, maxsize: 10_000_000, maxFiles: 5 }),
    ],
  });
  return logger;
}

export function getLogger(): winston.Logger {
  if (!logger) {
    // Fallback if called before init
    return initLogger("info", "bot.log");
  }
  return logger;
}
