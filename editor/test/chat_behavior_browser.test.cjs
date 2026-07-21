const assert = require("node:assert/strict");
const { chromeExecutable, loadChromium, requireChromeBinary, skip } = require("./browser-env.cjs");

const BASE_URL = process.env.EDITOR_BASE_URL || "http://localhost:5173";

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) skip(loaded.error);
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);
  let browser;
  try {
    browser = await loaded.chromium.launch({
      headless: true,
      executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  } catch (error) {
    skip(`could not launch CPU-only Chromium: ${error.message}`);
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const response = await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => null);
    if (!response?.ok()) skip(`editor not served on ${BASE_URL}`);
    await page.waitForFunction(() => window.liminaChat?.onChatMessage, null, { timeout: 8_000 });
    const result = await page.evaluate(() => {
      const send = window.liminaChat.onChatMessage;
      const stepTurn = `behavior-step-${Date.now()}`;
      send({ type: "chat.step", turnId: stepTurn, tool: "scene.createEntity", icon: "…" });
      send({ type: "chat.step", turnId: stepTurn, tool: "scene.createEntity", status: "ok", detail: "created ent_7" });
      for (const status of ["failed", "held", "rejected"]) {
        send({ type: "chat.step", turnId: stepTurn, tool: `behavior.${status}`, status, detail: `${status} detail` });
      }
      const stepRoot = document.getElementById(`chat-turn-${stepTurn}`);
      const statuses = [...stepRoot.querySelectorAll(".chat-step-chip")].map((chip) => ({
        classes: [...chip.classList],
        icon: chip.querySelector(".chat-step-icon")?.textContent,
        tool: chip.querySelector(".chat-step-tool")?.textContent,
        detail: chip.querySelector(".chat-step-detail")?.textContent,
        iconColor: getComputedStyle(chip.querySelector(".chat-step-icon")).color,
        borderColor: getComputedStyle(chip).borderColor,
      }));
      const approval = document.querySelector('[data-acc-toggle="approval"]');
      const beforeApproval = approval?.getAttribute("aria-expanded");
      stepRoot.querySelector(".chat-step-approval-link")?.click();
      const afterApproval = approval?.getAttribute("aria-expanded");

      const planTurn = `behavior-plan-${Date.now()}`;
      send({
        type: "chat.step",
        turnId: planTurn,
        tool: "gds.plan",
        status: "ok",
        result: {
          plan: {
            gdsId: "gds.behavioral",
            slices: [
              { name: "Playable", goal: "Prove the loop", dodIds: ["dod.1"] },
              { name: "Polish", goal: "Improve cues", dodIds: [] },
            ],
            systems: [
              { mechanicName: "Build", skill: "scene.createEntity", status: "existing" },
              { mechanicName: "Weather", skill: "world.weather", status: "new" },
              { mechanicName: "Mystery", skill: "unknown.skill", status: "unknown" },
            ],
          },
          gaps: ["missing weather authority"],
          issues: [{ path: "systems[2]", message: "skill is unknown" }],
          newWork: ["implement world.weather"],
        },
      });
      const plan = document.querySelector(`#chat-turn-${planTurn} .chat-plan-card`);
      const planEvidence = {
        title: plan?.querySelector(".chat-plan-title")?.textContent,
        slices: [...(plan?.querySelectorAll(".chat-plan-slice") ?? [])].map((node) => node.textContent),
        mappings: [...(plan?.querySelectorAll(".chat-plan-mapping") ?? [])].map((node) => ({ classes: [...node.classList], text: node.textContent })),
        gaps: [...(plan?.querySelectorAll(".chat-plan-gap") ?? [])].map((node) => node.textContent),
        issues: [...(plan?.querySelectorAll(".chat-plan-issue") ?? [])].map((node) => node.textContent),
        work: [...(plan?.querySelectorAll(".chat-plan-newwork-item") ?? [])].map((node) => node.textContent),
      };

      const doneTurn = `behavior-done-${Date.now()}`;
      send({ type: "chat.done", turnId: doneTurn, reason: "max_steps" });
      const doneError = document.querySelector(`#chat-turn-${doneTurn} .chat-error`)?.textContent;
      return {
        statuses,
        detailsOpen: stepRoot.querySelector("details.chat-steps")?.open,
        beforeApproval,
        afterApproval,
        planEvidence,
        doneError,
      };
    });

    assert.equal(result.statuses.length, 4, "completion did not upgrade the pending chip in place");
    assert.deepEqual(result.statuses.map((entry) => entry.icon), ["✓", "✕", "⏸", "⊘"]);
    assert.deepEqual(result.statuses.map((entry) => entry.classes.find((name) => name.startsWith("chat-step-") && name !== "chat-step-chip")),
      ["chat-step-ok", "chat-step-failed", "chat-step-held", "chat-step-rejected"]);
    assert.equal(result.statuses[0].detail, "created ent_7");
    assert.equal(result.detailsOpen, true, "failed/held steps stayed collapsed");
    assert.notEqual(result.beforeApproval, "true");
    assert.equal(result.afterApproval, "true", "held-step review did not open Approval");
    assert.equal(new Set(result.statuses.map((entry) => `${entry.iconColor}|${entry.borderColor}`)).size >= 3, true,
      "status icon/border styles are not visually distinct");
    assert.equal(result.planEvidence.title, "Plan · gds.behavioral");
    assert.deepEqual(result.planEvidence.slices, ["PlayableProve the loop1 DoD", "PolishImprove cuesnot auto-gated"]);
    assert.deepEqual(result.planEvidence.mappings.map((entry) => entry.classes.at(-1)),
      ["chat-plan-mapping-existing", "chat-plan-mapping-new", "chat-plan-mapping-unknown"]);
    assert.deepEqual(result.planEvidence.gaps, ["missing weather authority"]);
    assert.deepEqual(result.planEvidence.issues, ["systems[2]: skill is unknown"]);
    assert.deepEqual(result.planEvidence.work, ["implement world.weather"]);
    assert.match(result.doneError, /stopped without a reply \(max_steps\)/);
    assert.deepEqual(pageErrors, []);
    console.log("chat_behavior_browser.test OK: real DOM upgrades pending outcomes, exposes failure/hold states, opens Approval, renders structured plan evidence, and surfaces bound-cut completion (GPU disabled)");
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((error) => { console.error(`FAIL: ${error.stack}`); process.exit(1); });
