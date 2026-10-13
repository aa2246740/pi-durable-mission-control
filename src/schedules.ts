import { CronExpressionParser } from "cron-parser";
import type { ScheduleSpec } from "./contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseOnceAt(value: unknown, nowMs: number): string {
  if (typeof value !== "string") throw new Error("once.at must be an ISO8601 timestamp with an explicit timezone");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("once.at must be an ISO8601 timestamp with an explicit timezone");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    throw new Error("once.at is not a valid calendar timestamp");
  }
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone!.slice(1).split(":").map(Number);
    if (offsetHour! > 23 || offsetMinute! > 59) throw new Error("once.at has an invalid timezone offset");
  }
  const atMs = Date.parse(value);
  if (!Number.isFinite(atMs)) throw new Error("once.at is not a valid calendar timestamp");
  if (atMs <= nowMs) throw new Error("once.at must be in the future");
  return new Date(atMs).toISOString();
}

export function parseScheduleSpec(value: unknown, nowMs = Date.now()): { schedule: ScheduleSpec; nextRunAt: string } {
  if (!isRecord(value)) throw new Error("schedule must be an object");
  if (value.kind === "once") {
    if (Object.keys(value).some((key) => !["kind", "at"].includes(key))) throw new Error("Unexpected once schedule fields");
    const at = parseOnceAt(value.at, nowMs);
    return { schedule: { kind: "once", at }, nextRunAt: at };
  }
  if (value.kind === "cron") {
    if (Object.keys(value).some((key) => !["kind", "expression", "timeZone"].includes(key))) throw new Error("Unexpected cron schedule fields");
    if (typeof value.expression !== "string" || value.expression.trim().split(/\s+/).length !== 5) {
      throw new Error("Cron expression must contain exactly five fields");
    }
    if (/\bH\b/i.test(value.expression)) {
      throw new Error("Randomized H cron fields are not supported for durable schedules");
    }
    if (typeof value.timeZone !== "string" || !value.timeZone.trim()) throw new Error("timeZone must be an IANA timezone");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }).format(nowMs);
    } catch {
      throw new Error("timeZone must be a valid IANA timezone");
    }
    try {
      const nextRunAt = CronExpressionParser.parse(value.expression, {
        currentDate: new Date(nowMs).toISOString(),
        tz: value.timeZone
      }).next().toISOString();
      if (nextRunAt === null || !Number.isFinite(Date.parse(nextRunAt)) || Date.parse(nextRunAt) <= nowMs) throw new Error("Cron has no future occurrence");
      return { schedule: { kind: "cron", expression: value.expression.trim(), timeZone: value.timeZone }, nextRunAt };
    } catch {
      throw new Error("Cron expression has no valid future occurrence in the selected timezone");
    }
  }
  throw new Error("schedule.kind must be once or cron");
}
