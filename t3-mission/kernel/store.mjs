import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  DEFAULT_MODEL_SETTINGS,
  MissionKernelError,
  normalizeFeature,
  normalizeModelSettings,
} from "./schema.mjs";

export function resolveMissionBaseDir(missionDir) {
  if (!missionDir || typeof missionDir !== "string") {
    throw new MissionKernelError(
      "INVALID_MISSION_DIR",
      "missionDir must be a non-empty string path"
    );
  }
  const abs = path.resolve(missionDir);
  if (path.basename(abs) === ".mission") {
    return abs;
  }
  const hasDirectFiles =
    fs.existsSync(path.join(abs, "state.json")) ||
    fs.existsSync(path.join(abs, "features.json")) ||
    fs.existsSync(path.join(abs, "model-settings.json")) ||
    fs.existsSync(path.join(abs, "progress_log.jsonl"));
  const dotMissionDir = path.join(abs, ".mission");
  if (fs.existsSync(dotMissionDir)) {
    return dotMissionDir;
  }
  if (hasDirectFiles) {
    return abs;
  }
  return dotMissionDir;
}

export function getMissionPaths(missionDir) {
  const baseDir = resolveMissionBaseDir(missionDir);
  return {
    baseDir,
    statePath: path.join(baseDir, "state.json"),
    featuresPath: path.join(baseDir, "features.json"),
    modelSettingsPath: path.join(baseDir, "model-settings.json"),
    progressLogPath: path.join(baseDir, "progress_log.jsonl"),
  };
}

export function ensureMissionDir(missionDir) {
  const paths = getMissionPaths(missionDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  return paths;
}

export function writeFileAtomicSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpName = `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto
    .randomBytes(4)
    .toString("hex")}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function writeJsonAtomicSync(filePath, data) {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  writeFileAtomicSync(filePath, serialized);
}

export function readJsonSync(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

export function loadState(missionDir) {
  const { statePath } = getMissionPaths(missionDir);
  const state = readJsonSync(statePath, null);
  if (!state) {
    throw new MissionKernelError(
      "MISSION_NOT_FOUND",
      `Mission state not found at ${statePath}`
    );
  }
  return state;
}

export function tryLoadState(missionDir) {
  const { statePath } = getMissionPaths(missionDir);
  return readJsonSync(statePath, null);
}

export function saveState(missionDir, state) {
  const { statePath } = ensureMissionDir(missionDir);
  writeJsonAtomicSync(statePath, state);
  return state;
}

export function loadFeaturesDoc(missionDir) {
  const { featuresPath } = getMissionPaths(missionDir);
  const doc = readJsonSync(featuresPath, null);
  if (!doc) {
    return {
      features: [],
      updatedAt: new Date().toISOString(),
    };
  }
  const features = Array.isArray(doc.features)
    ? doc.features.map((f, i) => normalizeFeature(f, i))
    : [];
  return {
    ...doc,
    features,
    updatedAt: doc.updatedAt || new Date().toISOString(),
  };
}

export function saveFeaturesDoc(missionDir, featuresOrDoc) {
  const { featuresPath } = ensureMissionDir(missionDir);
  const rawFeatures = Array.isArray(featuresOrDoc)
    ? featuresOrDoc
    : Array.isArray(featuresOrDoc?.features)
      ? featuresOrDoc.features
      : [];
  const doc = {
    ...(Array.isArray(featuresOrDoc) ? {} : featuresOrDoc),
    features: rawFeatures.map((f, i) => normalizeFeature(f, i)),
    updatedAt:
      (!Array.isArray(featuresOrDoc) && featuresOrDoc?.updatedAt) ||
      new Date().toISOString(),
  };
  writeJsonAtomicSync(featuresPath, doc);
  return doc;
}

export function loadModelSettings(missionDir) {
  const { modelSettingsPath } = getMissionPaths(missionDir);
  const raw = readJsonSync(modelSettingsPath, null);
  if (!raw) {
    return normalizeModelSettings(DEFAULT_MODEL_SETTINGS);
  }
  return normalizeModelSettings(raw);
}

export function saveModelSettings(missionDir, settings) {
  const { modelSettingsPath } = ensureMissionDir(missionDir);
  const normalized = normalizeModelSettings(settings);
  writeJsonAtomicSync(modelSettingsPath, normalized);
  return normalized;
}

export function readProgressLog(missionDir) {
  const { progressLogPath } = getMissionPaths(missionDir);
  if (!fs.existsSync(progressLogPath)) {
    return [];
  }
  const raw = fs.readFileSync(progressLogPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function appendProgressLog(missionDir, entryInput) {
  const { progressLogPath } = ensureMissionDir(missionDir);
  const entries = readProgressLog(missionDir);
  const nextSeq =
    entries.length > 0
      ? Math.max(...entries.map((e) => (typeof e.seq === "number" ? e.seq : 0))) + 1
      : 1;

  const entry = {
    seq: nextSeq,
    timestamp: entryInput.timestamp || new Date().toISOString(),
    type: String(entryInput.type || "info"),
    message: String(entryInput.message || ""),
  };
  if (entryInput.featureId !== undefined) {
    entry.featureId = entryInput.featureId;
  }
  if (entryInput.workerNumber !== undefined) {
    entry.workerNumber = entryInput.workerNumber;
  }
  if (entryInput.milestoneId !== undefined) {
    entry.milestoneId = entryInput.milestoneId;
  }
  if (entryInput.details !== undefined) {
    entry.details = entryInput.details;
  }

  const nextLines = [...entries, entry]
    .map((item) => JSON.stringify(item))
    .join("\n")
    .concat("\n");
  writeFileAtomicSync(progressLogPath, nextLines);
  return entry;
}

export function reconcileMissionOnLoad(missionDir, options = {}) {
  const state = tryLoadState(missionDir);
  if (!state) {
    return null;
  }

  const nowMs =
    typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const activeStatuses = new Set([
    "running",
    "initializing",
    "orchestrator_turn",
  ]);

  if (activeStatuses.has(state.status)) {
    if (state.lastStartedAt) {
      const startedMs = Date.parse(state.lastStartedAt);
      if (!Number.isNaN(startedMs) && nowMs > startedMs) {
        state.elapsedMs = (state.elapsedMs || 0) + (nowMs - startedMs);
      }
    }
    state.lastStartedAt = null;
    state.status = "paused";
    state.revision = (state.revision || 1) + 1;

    let pausedWorker = null;
    if (state.activeWorker && state.activeWorker.status === "running") {
      state.activeWorker = {
        ...state.activeWorker,
        status: "paused",
        pausedAt: nowIso,
      };
      pausedWorker = state.activeWorker;

      if (Array.isArray(state.sessions)) {
        state.sessions = state.sessions.map((session) =>
          session.runId === pausedWorker.runId ||
          (pausedWorker.sessionId && session.sessionId === pausedWorker.sessionId)
            ? { ...session, status: "paused", pausedAt: nowIso }
            : session
        );
      }
    }

    saveState(missionDir, state);

    if (pausedWorker) {
      const workerNumber = pausedWorker.workerNumber ?? 1;
      const featureTitle =
        pausedWorker.featureTitle ||
        pausedWorker.title ||
        pausedWorker.featureId ||
        "feature";
      appendProgressLog(missionDir, {
        timestamp: nowIso,
        type: "worker_paused",
        message: `Worker #${workerNumber} paused ${featureTitle}`,
        featureId: pausedWorker.featureId ?? null,
        workerNumber,
      });
    }

    appendProgressLog(missionDir, {
      timestamp: nowIso,
      type: "mission_paused",
      message: "Mission paused",
      featureId: pausedWorker ? pausedWorker.featureId ?? null : null,
      workerNumber: pausedWorker ? pausedWorker.workerNumber ?? 1 : null,
    });
  }

  return state;
}
