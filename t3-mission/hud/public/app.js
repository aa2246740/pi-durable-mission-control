const hudState = {
  snapshot: null,
  selectedSessionId: "orchestrator",
  copiedThreadUri: null,
  sseConnected: false,
  lastEventId: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDurationHms(totalMs) {
  const safeMs = Math.max(0, Number(totalMs) || 0);
  const totalSec = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return [hours, minutes, seconds]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function formatRelativeTime(isoString, fallback = "now") {
  if (!isoString) return fallback;
  const ts = Date.parse(isoString);
  if (Number.isNaN(ts)) return fallback;
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return "now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

function computeLiveElapsedMs(state) {
  if (!state) return 0;
  let base = typeof state.elapsedMs === "number" ? state.elapsedMs : 0;
  const isRunning =
    state.status === "running" ||
    state.status === "orchestrator_turn" ||
    state.status === "initializing";
  if (isRunning && state.lastStartedAt) {
    const started = Date.parse(state.lastStartedAt);
    if (!Number.isNaN(started) && Date.now() > started) {
      base += Date.now() - started;
    }
  }
  return base;
}

function getStatusBannerText(state) {
  if (!state) return "PLANNING";
  const st = String(state.status || "planning").toLowerCase();
  if (st === "awaiting_input") {
    return "AWAITING INPUT";
  }
  if (st === "orchestrator_turn") return "ORCHESTRATOR TURN";
  if (st === "running") return "RUNNING";
  if (st === "paused") return "PAUSED";
  if (st === "completed") return "COMPLETED";
  if (st === "initializing") return "INITIALIZING";
  return st.toUpperCase();
}

function inferSessionRole(item, matchedFeature = null) {
  const roleRaw = String(item?.role || matchedFeature?.role || "")
    .trim()
    .toLowerCase();
  if (roleRaw === "validator") return "Validator";
  if (roleRaw === "explorer") return "Explorer";
  if (roleRaw === "worker") return "Worker";

  const slotRaw = String(item?.slot || matchedFeature?.slot || "")
    .trim()
    .toLowerCase();
  if (slotRaw === "validator") return "Validator";

  const kindRaw = String(item?.kind || matchedFeature?.kind || "")
    .trim()
    .toLowerCase();
  if (["scrutiny", "user-testing", "user_testing", "validator"].includes(kindRaw)) {
    return "Validator";
  }
  if (kindRaw === "explorer") {
    return "Explorer";
  }

  const combinedText = [
    item?.featureId,
    item?.id,
    item?.title,
    item?.featureTitle,
    matchedFeature?.id,
    matchedFeature?.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    combinedText.includes("validator") ||
    combinedText.includes("scrutiny") ||
    combinedText.includes("user-testing") ||
    combinedText.includes("user_testing")
  ) {
    return "Validator";
  }
  if (combinedText.includes("explorer")) {
    return "Explorer";
  }

  return "Worker";
}

function synthesizeSessions(state, features) {
  const explicitSessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const featuresList = Array.isArray(features) ? features : [];
  const byId = new Map();

  for (const [idx, s] of explicitSessions.entries()) {
    const id = s.sessionId || s.runId || s.id || `session-${idx + 1}`;
    const matchedFeature =
      featuresList.find((f) => f.id && f.id === s.featureId) || null;
    const role = inferSessionRole(s, matchedFeature);
    const number = s.workerNumber ?? idx + 1;
    const title =
      s.title || s.featureTitle || matchedFeature?.title || s.featureId || `${role} #${number}`;
    const status = s.status || "completed";

    const sameFeatureSessionCount = s.featureId
      ? explicitSessions.filter((item) => item.featureId === s.featureId).length
      : 1;

    const featureHandoffMatchesRun = Boolean(
      matchedFeature?.lastHandoff &&
        ((s.runId &&
          matchedFeature.lastHandoff.runId &&
          matchedFeature.lastHandoff.runId === s.runId) ||
          (!s.runId &&
            !matchedFeature.lastHandoff.runId &&
            status !== "running" &&
            status !== "paused" &&
            status !== "pending" &&
            sameFeatureSessionCount === 1))
    );

    const matchingFeatureHandoff = featureHandoffMatchesRun
      ? matchedFeature.lastHandoff
      : null;

    const h = s.handoff || matchingFeatureHandoff || {};
    const featureThreadMatchesRun = Boolean(
      matchedFeature?.childThreadId &&
        ((s.runId && matchedFeature.runId && matchedFeature.runId === s.runId) ||
          (!s.runId && sameFeatureSessionCount === 1))
    );
    const childThreadId =
      s.childThreadId ||
      s.threadId ||
      h.childThreadId ||
      (featureThreadMatchesRun ? matchedFeature.childThreadId : null) ||
      null;

    byId.set(id, {
      id,
      runId: s.runId || null,
      role,
      workerNumber: number,
      milestoneId: s.milestoneId || matchedFeature?.milestoneId || "m1",
      featureId: s.featureId || id,
      title,
      label: s.label || `${role} #${number}: ${title}`,
      status,
      timeLabel:
        s.timeLabel ||
        formatRelativeTime(
          s.endedAt || s.startedAt,
          status === "running" ? "now" : "1h"
        ),
      childThreadId,
      handoff: {
        salientSummary:
          s.salientSummary ||
          h.salientSummary ||
          (status === "running"
            ? `Running ${title}`
            : status === "paused"
              ? `Paused ${title}`
              : status === "pending"
                ? `Scheduled ${title}`
                : "No handoff summary recorded."),
        whatWasImplemented:
          s.whatWasImplemented ||
          h.whatWasImplemented ||
          "No handoff recorded yet.",
        commandsRun: Array.isArray(s.commandsRun)
          ? s.commandsRun
          : Array.isArray(h.commandsRun)
            ? h.commandsRun
            : [],
        discoveredIssues: Array.isArray(s.discoveredIssues)
          ? s.discoveredIssues
          : Array.isArray(h.discoveredIssues)
            ? h.discoveredIssues
            : [],
      },
    });
  }

  for (const [idx, f] of featuresList.entries()) {
    const matchingSessions = Array.from(byId.values()).filter(
      (s) => s.featureId === f.id
    );
    if (matchingSessions.length > 0) {
      if (f.lastHandoff && f.lastHandoff.runId) {
        const targetSession = matchingSessions.find(
          (s) => s.runId === f.lastHandoff.runId && s.status !== "running"
        );
        if (targetSession) {
          targetSession.handoff = {
            salientSummary:
              f.lastHandoff.salientSummary ||
              f.lastHandoff.whatWasImplemented ||
              targetSession.handoff.salientSummary,
            whatWasImplemented:
              f.lastHandoff.whatWasImplemented ||
              targetSession.handoff.whatWasImplemented,
            commandsRun: Array.isArray(f.lastHandoff.commandsRun)
              ? f.lastHandoff.commandsRun
              : targetSession.handoff.commandsRun,
            discoveredIssues: Array.isArray(f.lastHandoff.discoveredIssues)
              ? f.lastHandoff.discoveredIssues
              : targetSession.handoff.discoveredIssues,
          };
        }
      }
      continue;
    }

    const role = inferSessionRole(f);
    const number = f.workerNumber ?? idx + 1;
    const id = `session-${f.id || idx + 1}`;
    const title = f.title || f.id;
    const status = f.status || "pending";
    const h = status === "running" || status === "pending" ? {} : f.lastHandoff || {};
    const childThreadId = f.childThreadId || h.childThreadId || null;

    byId.set(id, {
      id,
      runId: h.runId || null,
      role,
      workerNumber: number,
      milestoneId: f.milestoneId || "m1",
      featureId: f.id,
      title,
      label: `${role} #${number}: ${title}`,
      status,
      timeLabel: formatRelativeTime(
        h.completedAt,
        status === "running" ? "now" : "1h"
      ),
      childThreadId,
      handoff: {
        salientSummary:
          h.salientSummary ||
          f.description ||
          (status === "running" ? `Running ${title}` : `Scheduled ${title}`),
        whatWasImplemented:
          h.whatWasImplemented || "No handoff recorded yet.",
        commandsRun: Array.isArray(h.commandsRun) ? h.commandsRun : [],
        discoveredIssues: Array.isArray(h.discoveredIssues)
          ? h.discoveredIssues
          : [],
      },
    });
  }

  if (state?.activeWorker) {
    const aw = state.activeWorker;
    const number = aw.workerNumber ?? 28;
    const awId = aw.sessionId || aw.runId || `worker-${number}`;
    const matchedFeature =
      featuresList.find((f) => f.id && f.id === aw.featureId) || null;
    const existing =
      byId.get(awId) ||
      Array.from(byId.values()).find((s) =>
        aw.runId
          ? s.runId === aw.runId
          : s.workerNumber === number ||
            (aw.featureId && s.featureId === aw.featureId && s.status !== "completed")
      );
    const role = inferSessionRole(aw, existing || matchedFeature);
    const featureTitle =
      aw.featureTitle ||
      aw.title ||
      existing?.title ||
      matchedFeature?.title ||
      aw.featureId ||
      "M2 material test gaps";
    const status = aw.status || (state.status === "paused" ? "paused" : "running");
    const h = aw.handoff || {};

    const sessionObj = {
      id: existing?.id || awId,
      runId: aw.runId || existing?.runId || null,
      role,
      workerNumber: number,
      milestoneId: aw.milestoneId || existing?.milestoneId || "m2",
      featureId: aw.featureId || existing?.featureId || "m2-material-test-gaps",
      title: featureTitle,
      label: `${role} #${number}: ${featureTitle}`,
      status,
      timeLabel: "now",
      childThreadId:
        aw.childThreadId || aw.threadId || existing?.childThreadId || null,
      handoff: {
        salientSummary:
          aw.salientSummary ||
          h.salientSummary ||
          existing?.handoff?.salientSummary ||
          (status === "paused"
            ? `Paused ${featureTitle}`
            : `Running ${featureTitle}`),
        whatWasImplemented:
          aw.whatWasImplemented ||
          h.whatWasImplemented ||
          existing?.handoff?.whatWasImplemented ||
          "No handoff recorded yet.",
        commandsRun: Array.isArray(aw.commandsRun)
          ? aw.commandsRun
          : Array.isArray(h.commandsRun)
            ? h.commandsRun
            : Array.isArray(existing?.handoff?.commandsRun)
              ? existing.handoff.commandsRun
              : [],
        discoveredIssues: Array.isArray(aw.discoveredIssues)
          ? aw.discoveredIssues
          : Array.isArray(h.discoveredIssues)
            ? h.discoveredIssues
            : Array.isArray(existing?.handoff?.discoveredIssues)
              ? existing.handoff.discoveredIssues
              : [],
      },
    };
    byId.set(sessionObj.id, sessionObj);
  }

  return Array.from(byId.values());
}

async function postJson(url, payload = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }
  const data = await res.json();
  if (data?.snapshot) {
    applySnapshot(data.snapshot);
  }
  return data;
}

function renderTopBar(snapshot) {
  const { state, features } = snapshot;
  const repoEl = document.getElementById("mission-repo-path");
  const titleEl = document.getElementById("mission-title");
  const timeEl = document.getElementById("metric-time");
  const progressEl = document.getElementById("metric-progress");
  const progressBarEl = document.getElementById("metric-progress-bar");
  const usageEl = document.getElementById("metric-usage");

  if (repoEl) repoEl.textContent = state.repoPath || "/Volumes/Workspace/project";
  if (titleEl) titleEl.textContent = state.title || "T3 Mission Control";

  const elapsedMs = computeLiveElapsedMs(state);
  if (timeEl) timeEl.textContent = formatDurationHms(elapsedMs);

  const totalFeatures = Array.isArray(features) ? features.length : 0;
  const completedFeatures = Array.isArray(features)
    ? features.filter((f) => f.status === "completed").length
    : 0;
  if (progressEl) {
    progressEl.textContent = `${completedFeatures}/${totalFeatures}`;
  }
  if (progressBarEl) {
    const pct = totalFeatures > 0 ? Math.round((completedFeatures / totalFeatures) * 100) : 0;
    progressBarEl.style.width = `${pct}%`;
  }
  if (usageEl) {
    usageEl.textContent = state.usage || "0%";
  }
}

function renderStatusStrip(snapshot) {
  const { state } = snapshot;
  const stripEl = document.getElementById("status-strip");
  const labelEl = document.getElementById("status-strip-label");
  const subEl = document.getElementById("status-strip-subtext");
  const approveBtn = document.getElementById("strip-approve-btn");
  const pauseBtn = document.getElementById("btn-pause");
  const resumeBtn = document.getElementById("btn-resume");

  const status = state.status || "planning";
  if (stripEl) stripEl.dataset.status = status;
  if (labelEl) labelEl.textContent = getStatusBannerText(state);

  const activeRole = state.activeWorker ? inferSessionRole(state.activeWorker) : "Worker";
  const activeWorkerSummary = state.activeWorker
    ? ` · ${activeRole} #${state.activeWorker.workerNumber ?? 28} (${state.activeWorker.status || status})`
    : "";
  if (subEl) {
    subEl.textContent = `Revision #${state.revision ?? 1}${activeWorkerSummary}`;
  }

  const needsApproval = status === "awaiting_input" && !state.planAccepted;
  if (approveBtn) {
    approveBtn.classList.toggle("hidden", !needsApproval);
    approveBtn.classList.toggle("is-primary-action", needsApproval);
  }
  if (pauseBtn) {
    pauseBtn.classList.toggle("is-primary-action", status === "running" || status === "orchestrator_turn");
  }
  if (resumeBtn) {
    resumeBtn.classList.toggle("is-primary-action", status === "paused");
  }
}

function renderSessionsColumn(snapshot) {
  const { state, features } = snapshot;
  const listEl = document.getElementById("sessions-list");
  const countEl = document.getElementById("sessions-count");
  if (!listEl) return;

  const sessions = synthesizeSessions(state, features);
  if (countEl) countEl.textContent = String(sessions.length + 1);

  const milestones =
    Array.isArray(state.milestones) && state.milestones.length > 0
      ? state.milestones
      : [
          { id: "m1", title: "Milestone 1: Intake" },
          { id: "m2", title: "Milestone 2: Materials In Run" },
        ];

  let html = `
    <button
      type="button"
      class="session-item ${hudState.selectedSessionId === "orchestrator" ? "active" : ""}"
      data-session-id="orchestrator"
    >
      <span class="session-item-left">
        <span class="session-dot running"></span>
        <span class="session-label">Orchestrator</span>
      </span>
      <span class="session-time">now</span>
    </button>
  `;

  const grouped = new Map();
  for (const m of milestones) {
    grouped.set(m.id, { title: m.title || m.id, items: [] });
  }
  for (const s of sessions) {
    const mId = s.milestoneId || milestones[0]?.id || "m1";
    if (!grouped.has(mId)) {
      grouped.set(mId, { title: `Milestone: ${mId}`, items: [] });
    }
    grouped.get(mId).items.push(s);
  }

  for (const [, group] of grouped.entries()) {
    if (group.items.length === 0) continue;
    html += `<div class="session-milestone-header">${escapeHtml(group.title)}</div>`;
    for (const item of group.items) {
      const isSelected = hudState.selectedSessionId === item.id;
      const dotClass =
        item.status === "running"
          ? "running"
          : item.status === "paused"
            ? "paused"
            : item.status === "pending"
              ? "pending"
              : "completed";
      html += `
        <button
          type="button"
          class="session-item ${isSelected ? "active" : ""}"
          data-session-id="${escapeHtml(item.id)}"
          data-feature-id="${escapeHtml(item.featureId || "")}"
        >
          <span class="session-item-left">
            <span class="session-dot ${dotClass}"></span>
            <span class="session-label">${escapeHtml(item.label)}</span>
          </span>
          <span class="session-time">${escapeHtml(item.timeLabel)}</span>
        </button>
      `;
    }
  }

  listEl.innerHTML = html;

  listEl.querySelectorAll(".session-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      hudState.selectedSessionId = btn.dataset.sessionId || "orchestrator";
      renderCenterColumn(hudState.snapshot);
      renderSessionsColumn(hudState.snapshot);
    });
  });
}

function renderCenterColumn(snapshot) {
  const { initialized, state, features, progressLog, modelSettings } = snapshot;
  const onboardingEl = document.getElementById("onboarding-card");
  const approvalEl = document.getElementById("plan-approval-card");
  const handoffEl = document.getElementById("session-handoff-view");
  const streamEl = document.getElementById("orchestrator-stream");
  const pipelineTextEl = document.getElementById("pipeline-text");
  const composerMsgEl = document.getElementById("composer-status-msg");
  const toolbarModelEl = document.getElementById("toolbar-orchestrator-model");

  // 1. Uninitialized onboarding notice
  if (onboardingEl) {
    if (!initialized) {
      onboardingEl.classList.remove("hidden");
      onboardingEl.innerHTML = `
        <div class="approval-badge">WAITING FOR INITIALIZATION</div>
        <h3 class="approval-title">${escapeHtml(state.onboarding?.headline || "Mission directory (.mission/) not initialized yet")}</h3>
        <p style="margin:6px 0 0;color:var(--text-secondary);">
          ${escapeHtml(state.onboarding?.instructions || "Initialize .mission/state.json or click Approve & Start Mission to bootstrap.")}
        </p>
      `;
    } else {
      onboardingEl.classList.add("hidden");
    }
  }

  // 2. Plan Approval Card when status === "awaiting_input" && !planAccepted
  const showApprovalCard = state.status === "awaiting_input" && !state.planAccepted;
  if (approvalEl) {
    if (showApprovalCard) {
      approvalEl.classList.remove("hidden");
      const milestones = Array.isArray(state.milestones) ? state.milestones : [];
      const assertions = Array.isArray(state.assertions) ? state.assertions : [];
      approvalEl.innerHTML = `
        <div class="approval-header">
          <div>
            <span class="approval-badge">Mission 计划书与 Validation Contract 审批卡</span>
            <h2 class="approval-title">${escapeHtml(state.title || "Mission Plan & Validation Contract")}</h2>
          </div>
          <button
            type="button"
            class="btn-approve-large"
            id="btn-approve"
            data-testid="btn-approve-mission"
            data-action="approve"
          >
            ✓ Approve &amp; Start Mission
          </button>
        </div>
        <div class="approval-grid">
          <div class="contract-box">
            <h4>Milestones (${milestones.length})</h4>
            <ul class="contract-list">
              ${
                milestones.length
                  ? milestones
                      .map((m) => `<li><strong>${escapeHtml(m.id)}</strong>: ${escapeHtml(m.title)}</li>`)
                      .join("")
                  : `<li>m1: Milestone 1: Intake</li><li>m2: Milestone 2: Materials In Run</li>`
              }
            </ul>
          </div>
          <div class="contract-box">
            <h4>Planned Features (${features.length})</h4>
            <ul class="contract-list">
              ${
                features.length
                  ? features
                      .slice(0, 8)
                      .map((f) => `<li><strong>${escapeHtml(f.title || f.id)}</strong> (${escapeHtml(f.milestoneId || "m1")})</li>`)
                      .join("")
                  : `<li>Awaiting feature breakdown</li>`
              }
            </ul>
          </div>
          <div class="contract-box">
            <h4>Validation Assertions (${assertions.length})</h4>
            <ul class="contract-list">
              ${
                assertions.length
                  ? assertions
                      .slice(0, 8)
                      .map(
                        (a) =>
                          `<li><span class="mono">${escapeHtml(a.id)}</span>: ${escapeHtml(a.description || a.status || "pending")}</li>`
                      )
                      .join("")
                  : `<li><span class="mono">VAL-HUD-001</span> ~ <span class="mono">VAL-HUD-004</span></li>`
              }
            </ul>
          </div>
        </div>
      `;
      const approveBtn = approvalEl.querySelector("#btn-approve");
      approveBtn?.addEventListener("click", () => triggerApprove());
    } else {
      approvalEl.classList.add("hidden");
    }
  }

  // 3. Session Handoff View when a non-Orchestrator Session is selected
  const sessions = synthesizeSessions(state, features);
  const selectedSession =
    hudState.selectedSessionId !== "orchestrator"
      ? sessions.find((s) => s.id === hudState.selectedSessionId) || null
      : null;

  if (handoffEl) {
    if (selectedSession) {
      handoffEl.classList.remove("hidden");
      const threadUri = selectedSession.childThreadId
        ? `t3-thread://v1/${selectedSession.childThreadId}`
        : "Unavailable";
      const commands = Array.isArray(selectedSession.handoff?.commandsRun)
        ? selectedSession.handoff.commandsRun
        : [];
      const issues = Array.isArray(selectedSession.handoff?.discoveredIssues)
        ? selectedSession.handoff.discoveredIssues
        : [];

      handoffEl.innerHTML = `
        <div class="handoff-topbar">
          <div>
            <span class="approval-badge">${escapeHtml(selectedSession.role)} Handoff Inspector</span>
            <h3 class="approval-title">${escapeHtml(selectedSession.label)}</h3>
          </div>
          <div class="thread-copy-group">
            <code class="thread-uri-code" id="handoff-thread-uri">${escapeHtml(threadUri)}</code>
            <button
              type="button"
              class="btn-copy-thread"
              id="btn-copy-thread-uri"
              data-thread-uri="${escapeHtml(threadUri)}"
            >
              ${hudState.copiedThreadUri === threadUri ? "✓ Copied" : "Copy t3-thread URI"}
            </button>
            <button type="button" class="btn-back-orchestrator" id="btn-back-orchestrator">
              ← Orchestrator Turn
            </button>
          </div>
        </div>

        <div class="handoff-section">
          <div class="handoff-section-title">salientSummary</div>
          <div class="handoff-block" id="handoff-salient-summary">
            ${escapeHtml(selectedSession.handoff?.salientSummary || "No summary recorded.")}
          </div>
        </div>

        <div class="handoff-section">
          <div class="handoff-section-title">whatWasImplemented</div>
          <div class="handoff-block" id="handoff-what-was-implemented">
            ${escapeHtml(selectedSession.handoff?.whatWasImplemented || "No handoff recorded yet.")}
          </div>
        </div>

        <div class="handoff-section">
          <div class="handoff-section-title">commandsRun (${commands.length})</div>
          <div class="handoff-block mono" id="handoff-commands-run">
            ${
              commands.length
                ? commands
                    .map((cmd) =>
                      typeof cmd === "string"
                        ? `$ ${escapeHtml(cmd)}`
                        : `$ ${escapeHtml(cmd.command || JSON.stringify(cmd))}`
                    )
                    .join("<br/>")
                : "No commands recorded yet."
            }
          </div>
        </div>

        <div class="handoff-section">
          <div class="handoff-section-title">discoveredIssues (${issues.length})</div>
          <div class="handoff-block" id="handoff-discovered-issues">
            ${
              issues.length
                ? issues
                    .map((iss) =>
                      typeof iss === "string"
                        ? `• ${escapeHtml(iss)}`
                        : `• ${escapeHtml(iss.summary || iss.description || JSON.stringify(iss))}`
                    )
                    .join("<br/>")
                : "None — all assertions and checks clean."
            }
          </div>
        </div>
      `;

      handoffEl.querySelector("#btn-back-orchestrator")?.addEventListener("click", () => {
        hudState.selectedSessionId = "orchestrator";
        renderCenterColumn(hudState.snapshot);
        renderSessionsColumn(hudState.snapshot);
      });

      handoffEl.querySelector("#btn-copy-thread-uri")?.addEventListener("click", async (e) => {
        const uri = e.currentTarget.dataset.threadUri;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(uri);
          }
        } catch {}
        hudState.copiedThreadUri = uri;
        renderCenterColumn(hudState.snapshot);
      });
    } else {
      handoffEl.classList.add("hidden");
    }
  }

  // 4. Orchestrator Turn & Action Stream (Droid style)
  if (streamEl) {
    const hasDismissed =
      Array.isArray(state.lastDismissedHandoffItems) &&
      state.lastDismissedHandoffItems.length > 0;
    const hasResumeEvent =
      Boolean(state.lastResumeDiagnostic) ||
      Boolean(state.lastResumeTrigger) ||
      (progressLog || []).some((e) => e.type === "mission_resumed");
    const resumeDiagnostic =
      state.lastResumeDiagnostic ||
      (state.activeWorker
        ? `${inferSessionRole(state.activeWorker)} #${state.activeWorker.workerNumber ?? 1} (${state.activeWorker.featureTitle || state.activeWorker.featureId}) is currently ${state.activeWorker.status || state.status}.`
        : `Mission status is ${state.status || "planning"}.`);

    const recentLogCards = (progressLog || [])
      .slice(-6)
      .map(
        (entry) => `
          <div class="stream-tool-row">
            <span>● <strong>${escapeHtml(entry.type || "event")}</strong> — ${escapeHtml(entry.message)}</span>
            <span class="mono">${escapeHtml(formatRelativeTime(entry.timestamp, "now"))}</span>
          </div>
        `
      )
      .join("");

    const activeRole = state.activeWorker ? inferSessionRole(state.activeWorker) : "Worker";

    streamEl.innerHTML = `
      ${
        hasDismissed
          ? `<div class="stream-tool-row">
              <span><strong>Dismiss Handoff Items</strong> · Dismissed ${state.lastDismissedHandoffItems.length} item(s)</span>
              <span class="mono">Completed</span>
            </div>`
          : ""
      }
      ${
        hasResumeEvent
          ? `<div class="stream-pill-Input">[resume the mission]</div>`
          : ""
      }
      <div class="stream-narrative-card" id="resume-diagnostic-card">
        <div class="stream-narrative-title">▣ Check mission state before resuming</div>
        <div>${escapeHtml(resumeDiagnostic)}</div>
      </div>
      <div class="stream-tool-row">
        <span><strong>Start Mission Run</strong> · ${escapeHtml(
          state.activeWorker
            ? `${activeRole} #${state.activeWorker.workerNumber ?? 28}: ${state.activeWorker.featureTitle || state.activeWorker.featureId || "M2 material test gaps"}`
            : "Mission execution loop"
        )}</span>
        <span class="mono">${escapeHtml(state.status || "planning")}</span>
      </div>
      ${recentLogCards}
    `;
  }

  // 5. Bottom Composer & Milestone Capsule
  if (pipelineTextEl) {
    const milestones = Array.isArray(state.milestones) ? state.milestones : [];
    const featuresList = Array.isArray(features) ? features : [];
    const assertionsList = Array.isArray(state.assertions) ? state.assertions : [];
    if (milestones.length >= 1) {
      const mLabels = milestones.map((m) => {
        const mFeatures = featuresList.filter((f) => f.milestoneId === m.id);
        const mAssertions = assertionsList.filter((a) => a.milestoneId === m.id);
        const allFeaturesDone =
          mFeatures.length > 0 && mFeatures.every((f) => f.status === "completed");
        const allAssertionsPassed =
          mAssertions.length === 0 || mAssertions.every((a) => a.status === "passed");
        return allFeaturesDone && allAssertionsPassed
          ? `${m.id.toUpperCase()} 已通过验收`
          : `${m.id.toUpperCase()}（${m.title || m.id}）`;
      });
      pipelineTextEl.textContent = `执行并处理交接：${mLabels.join(" → ")}`;
    } else {
      pipelineTextEl.textContent = "执行并处理交接：等待里程碑初始化";
    }
  }

  if (composerMsgEl) {
    if (state.status === "paused") {
      composerMsgEl.textContent = "Mission is paused. Click ▶ Resume Mission to continue.";
    } else if (state.status === "awaiting_input" && !state.planAccepted) {
      composerMsgEl.textContent =
        "Mission is awaiting approval. Click ✓ Approve & Start Mission above.";
    } else {
      composerMsgEl.textContent = "Mission is running. Pause to send messages.";
    }
  }

  if (toolbarModelEl && modelSettings?.orchestrator) {
    const orch = modelSettings.orchestrator;
    toolbarModelEl.textContent = `${orch.label || orch.model} (${orch.model})`;
  }
}

function renderRightColumn(snapshot) {
  const { state, features, modelSettings, progressLog, catalog } = snapshot;

  const effortLevelNames = {
    1: "minimal",
    2: "low",
    3: "medium",
    4: "high",
    5: "max",
  };

  // 1. Model 3-Slot Controls
  for (const slot of ["orchestrator", "worker", "validator"]) {
    const selectEl = document.getElementById(`model-select-${slot}`);
    const barsEl = document.getElementById(`effort-bars-${slot}`);
    const slotCfg = modelSettings?.[slot] || {};
    const currentModel = slotCfg.model || "gpt-6.1-sol";
    const currentEffort = Number(slotCfg.effort || slotCfg.options?.effort || 4);

    const optionsList = Array.isArray(catalog) ? [...catalog] : [];
    const catalogEntry = optionsList.find(
      (c) => c.model === currentModel || c.id === currentModel
    );
    const supportsEffort =
      catalogEntry?.supportsEffort !== undefined
        ? Boolean(catalogEntry.supportsEffort)
        : slotCfg.supportsEffort !== undefined
          ? Boolean(slotCfg.supportsEffort)
          : slotCfg.providerInstanceId !== "antigravity" &&
            !/-(low|medium|high)$/i.test(currentModel);

    if (!catalogEntry) {
      optionsList.unshift({
        id: currentModel,
        model: currentModel,
        label: slotCfg.label || currentModel,
        providerInstanceId: slotCfg.providerInstanceId || "custom",
        supportsEffort,
        effort: supportsEffort ? currentEffort : null,
      });
    }

    if (selectEl) {
      selectEl.innerHTML = optionsList
        .map(
          (item) => `
            <option
              value="${escapeHtml(item.model)}"
              data-provider="${escapeHtml(item.providerInstanceId || "")}"
              data-label="${escapeHtml(item.label || item.model)}"
              data-supports-effort="${item.supportsEffort !== false}"
              data-effort="${escapeHtml(item.supportsEffort === false ? "" : item.effort || 4)}"
              ${item.model === currentModel ? "selected" : ""}
            >
              ${escapeHtml(item.label || item.model)}
            </option>
          `
        )
        .join("");
    }

    if (barsEl) {
      if (!supportsEffort) {
        barsEl.classList.add("hidden");
        barsEl.style.display = "none";
        barsEl.innerHTML = "";
        barsEl.setAttribute?.("aria-hidden", "true");
      } else {
        barsEl.classList.remove("hidden");
        barsEl.style.display = "";
        barsEl.removeAttribute?.("aria-hidden");

        let barsHtml = "";
        for (let level = 1; level <= 5; level++) {
          const isActive = level <= currentEffort;
          const levelName = effortLevelNames[level] || "high";
          barsHtml += `
          <button
            type="button"
            class="effort-bar-btn ${isActive ? "active" : ""}"
            data-slot="${slot}"
            data-effort="${level}"
            title="Reasoning Effort: ${levelName} (${level}/5)"
            aria-label="${slot} effort ${level}"
          ></button>
        `;
        }
        barsEl.innerHTML = barsHtml;

        barsEl.querySelectorAll(".effort-bar-btn").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const newEffort = Number(btn.dataset.effort || 4);
            await updateModelSlot(slot, {
              model: selectEl?.value || currentModel,
              effort: newEffort,
            });
          });
        });
      }
    }
  }

  // 2. Features Checklist
  const featuresCountEl = document.getElementById("features-count");
  const featuresListEl = document.getElementById("features-list");
  const totalFeatures = Array.isArray(features) ? features.length : 0;
  const completedFeatures = Array.isArray(features)
    ? features.filter((f) => f.status === "completed").length
    : 0;
  if (featuresCountEl) {
    featuresCountEl.textContent = `${completedFeatures}/${totalFeatures}`;
  }

  if (featuresListEl) {
    const milestones =
      Array.isArray(state.milestones) && state.milestones.length > 0
        ? state.milestones
        : [
            { id: "m1", title: "Milestone 1: Intake" },
            { id: "m2", title: "Milestone 2: Materials In Run" },
          ];
    const groups = new Map();
    for (const m of milestones) {
      groups.set(m.id, { title: m.title || m.id, items: [] });
    }
    for (const f of features || []) {
      const mId = f.milestoneId || milestones[0]?.id || "m1";
      if (!groups.has(mId)) {
        groups.set(mId, { title: `Milestone: ${mId}`, items: [] });
      }
      groups.get(mId).items.push(f);
    }

    let fHtml = "";
    for (const [, group] of groups.entries()) {
      if (group.items.length === 0) continue;
      fHtml += `<div class="feature-milestone-group"><div class="feature-milestone-title">${escapeHtml(group.title)}</div>`;
      for (const f of group.items) {
        const st = f.status || "pending";
        const icon = st === "completed" ? "✓" : st === "running" ? "●" : st === "paused" ? "||" : "•";
        fHtml += `
          <div class="feature-row" data-feature-id="${escapeHtml(f.id)}">
            <span class="feature-icon ${escapeHtml(st)}">${icon}</span>
            <span class="feature-title-text">${escapeHtml(f.title || f.id)}</span>
          </div>
        `;
      }
      fHtml += `</div>`;
    }
    featuresListEl.innerHTML =
      fHtml || `<div style="color:var(--text-muted);font-size:12px;">No features registered yet.</div>`;

    featuresListEl.querySelectorAll(".feature-row").forEach((row) => {
      row.addEventListener("click", () => {
        const fId = row.dataset.featureId;
        const sessions = synthesizeSessions(state, features);
        const match = sessions.find((s) => s.featureId === fId);
        if (match) {
          hudState.selectedSessionId = match.id;
          renderCenterColumn(hudState.snapshot);
          renderSessionsColumn(hudState.snapshot);
        }
      });
    });
  }

  // 2.5 Validation Contract Assertions Checklist
  const assertionsCountEl = document.getElementById("assertions-count");
  const assertionsListEl = document.getElementById("assertions-list");
  const assertions = Array.isArray(state.assertions) ? state.assertions : [];
  const passedAssertions = assertions.filter((a) => a.status === "passed").length;
  if (assertionsCountEl) {
    assertionsCountEl.textContent = `${passedAssertions}/${assertions.length}`;
  }
  if (assertionsListEl) {
    assertionsListEl.innerHTML = assertions.length
      ? assertions
          .map((a) => {
            const st = String(a.status || "pending").toLowerCase();
            const icon = st === "passed" ? "✓" : st === "failed" ? "✕" : "•";
            return `
              <div class="feature-row assertion-row" data-assertion-id="${escapeHtml(a.id)}" data-assertion-status="${escapeHtml(st)}">
                <span class="feature-icon ${escapeHtml(st === "passed" ? "completed" : st)}">${icon}</span>
                <span class="mono" style="font-size:11px;font-weight:600;">${escapeHtml(a.id)}</span>
                <span class="feature-title-text" style="flex:1;">${escapeHtml(a.description || "")}</span>
                <span class="mono assertion-status-badge ${escapeHtml(st)}" style="font-size:10px;text-transform:uppercase;">${escapeHtml(st)}</span>
              </div>
            `;
          })
          .join("")
      : `<div style="color:var(--text-muted);font-size:12px;">No validation assertions registered yet.</div>`;
  }

  // 3. Progress Log (newest to oldest)
  const logCountEl = document.getElementById("progress-log-count");
  const logListEl = document.getElementById("progress-log-list");
  const entries = Array.isArray(progressLog) ? [...progressLog].reverse() : [];
  if (logCountEl) logCountEl.textContent = String(entries.length);

  if (logListEl) {
    logListEl.innerHTML = entries.length
      ? entries
          .map(
            (item) => `
              <div class="log-row" data-log-seq="${escapeHtml(item.seq || "")}">
                <div class="log-left">
                  <span class="log-dot ${escapeHtml(item.type || "info")}"></span>
                  <span class="log-msg">${escapeHtml(item.message)}</span>
                </div>
                <span class="log-time">${escapeHtml(formatRelativeTime(item.timestamp, "now"))}</span>
              </div>
            `
          )
          .join("")
      : `<div style="color:var(--text-muted);font-size:12px;">No progress log events yet.</div>`;
  }
}

export function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  hudState.snapshot = snapshot;
  renderTopBar(snapshot);
  renderStatusStrip(snapshot);
  renderSessionsColumn(snapshot);
  renderCenterColumn(snapshot);
  renderRightColumn(snapshot);
}

async function triggerApprove() {
  await postJson("/api/mission/approve", {
    approvedBy: "user",
  });
}

async function triggerPause() {
  await postJson("/api/mission/pause", {
    requestedBy: "user",
  });
}

async function triggerResume() {
  await postJson("/api/mission/resume", {
    trigger: "[resume the mission]",
  });
}

async function updateModelSlot(slot, { model, providerInstanceId, label, effort }) {
  const statusEl = document.getElementById("model-save-status");
  if (statusEl) statusEl.textContent = "Saving...";
  const payload = { slot, model, providerInstanceId, label };
  if (effort !== undefined && effort !== null) {
    payload.effort = effort;
  }
  await postJson("/api/mission/model-slots", payload);
  if (statusEl) statusEl.textContent = "Saved";
}

function bindStaticListeners() {
  document.getElementById("strip-approve-btn")?.addEventListener("click", () => triggerApprove());
  document.getElementById("btn-pause")?.addEventListener("click", () => triggerPause());
  document.getElementById("btn-resume")?.addEventListener("click", () => triggerResume());

  for (const slot of ["orchestrator", "worker", "validator"]) {
    const selectEl = document.getElementById(`model-select-${slot}`);
    selectEl?.addEventListener("change", async (e) => {
      const opt = e.target.selectedOptions?.[0];
      const model = e.target.value;
      const providerInstanceId = opt?.dataset?.provider || undefined;
      const label = opt?.dataset?.label || undefined;
      const optSupportsEffort = opt?.dataset?.supportsEffort !== "false";
      const currentEffort = optSupportsEffort
        ? hudState.snapshot?.modelSettings?.[slot]?.effort ||
          Number(opt?.dataset?.effort || 4)
        : null;
      await updateModelSlot(slot, {
        model,
        providerInstanceId,
        label,
        ...(optSupportsEffort ? { effort: currentEffort } : {}),
      });
    });
  }
}

function connectSseStream() {
  const indicatorEl = document.getElementById("sse-indicator");
  const url = hudState.lastEventId
    ? `/api/mission/stream?lastEventId=${encodeURIComponent(hudState.lastEventId)}`
    : "/api/mission/stream";
  const es = new EventSource(url);

  es.addEventListener("open", () => {
    hudState.sseConnected = true;
    if (indicatorEl) indicatorEl.textContent = "● Live";
  });

  es.addEventListener("mission_snapshot", (event) => {
    if (event.lastEventId) {
      hudState.lastEventId = event.lastEventId;
    }
    try {
      const payload = JSON.parse(event.data);
      applySnapshot(payload);
    } catch {}
  });

  es.addEventListener("error", () => {
    hudState.sseConnected = false;
    if (indicatorEl) indicatorEl.textContent = "○ Reconnecting";
  });
}

async function initHud() {
  bindStaticListeners();
  try {
    const res = await fetch("/api/mission/state");
    if (res.ok) {
      const snapshot = await res.json();
      applySnapshot(snapshot);
    }
  } catch {}

  connectSseStream();

  setInterval(() => {
    if (hudState.snapshot?.state) {
      const timeEl = document.getElementById("metric-time");
      if (timeEl) {
        timeEl.textContent = formatDurationHms(computeLiveElapsedMs(hudState.snapshot.state));
      }
    }
  }, 1000);
}

initHud();
