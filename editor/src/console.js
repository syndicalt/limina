const logbar = document.querySelector(".logbar");
const expandButton = document.getElementById("console-expand");
const collapseButton = document.getElementById("console-collapse");
const preview = document.getElementById("console-preview");
const log = document.getElementById("log");
const tabs = Array.from(document.querySelectorAll("[data-console-tab]"));
const panes = Array.from(document.querySelectorAll("[data-console-pane]"));

let expanded = false;
let activeTab = "console";

function setExpanded(nextExpanded) {
  expanded = Boolean(nextExpanded);
  if (logbar) {
    logbar.dataset.consoleExpanded = expanded ? "true" : "false";
    if (!expanded) logbar.style.height = "";
  }
  if (expandButton) expandButton.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function setActiveTab(tabName) {
  if (!tabs.some((tab) => tab.dataset.consoleTab === tabName)) return;
  activeTab = tabName;
  if (logbar) logbar.dataset.consoleActiveTab = activeTab;

  for (const tab of tabs) {
    const selected = tab.dataset.consoleTab === activeTab;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
  }

  for (const pane of panes) {
    const selected = pane.dataset.consolePane === activeTab;
    pane.classList.toggle("active", selected);
    pane.hidden = !selected;
  }
}

function updatePreview() {
  if (!preview || !log) return;
  const latestRow = log.querySelector(".log-row");
  if (!latestRow) {
    preview.textContent = "";
    return;
  }
  preview.textContent = latestRow.textContent.trim();
}

function wireConsole() {
  if (!logbar) return;

  expandButton?.addEventListener("click", () => setExpanded(true));
  collapseButton?.addEventListener("click", () => setExpanded(false));

  for (const control of [collapseButton, ...tabs]) {
    control?.addEventListener("pointerdown", (event) => event.stopPropagation());
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => setActiveTab(tab.dataset.consoleTab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const currentIndex = tabs.indexOf(tab);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length];
      setActiveTab(nextTab.dataset.consoleTab);
      nextTab.focus();
    });
  }

  updatePreview();
  if (log) {
    new MutationObserver(updatePreview).observe(log, { childList: true, subtree: true, characterData: true });
  }
  setActiveTab(activeTab);
  setExpanded(expanded);
}

wireConsole();
