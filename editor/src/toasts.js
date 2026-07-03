const TOAST_EVENT = "limina:toast";
const INFO_TIMEOUT_MS = 5000;
const OK_TIMEOUT_MS = 5000;
const ERROR_TIMEOUT_MS = 12000;
const VALID_KINDS = new Set(["error", "info", "ok"]);

let stack;

function getStack() {
  if (stack) return stack;
  stack = document.createElement("div");
  stack.className = "toast-stack";
  stack.setAttribute("aria-live", "polite");
  stack.setAttribute("aria-atomic", "false");
  document.body.appendChild(stack);
  return stack;
}

function normalizeKind(kind) {
  return VALID_KINDS.has(kind) ? kind : "info";
}

function removeToast(toast) {
  toast.remove();
  if (stack && stack.children.length === 0) {
    stack.remove();
    stack = undefined;
  }
}

function showToast(detail = {}) {
  const message = String(detail.message || "").trim();
  if (!message) return;

  const kind = normalizeKind(detail.kind);
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");

  const messageNode = document.createElement("div");
  messageNode.className = "toast-message";
  messageNode.textContent = message;

  const dismiss = document.createElement("button");
  dismiss.className = "toast-dismiss";
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", "Dismiss notification");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => removeToast(toast));

  toast.append(messageNode, dismiss);
  getStack().appendChild(toast);

  const timeout = kind === "error" ? ERROR_TIMEOUT_MS : kind === "ok" ? OK_TIMEOUT_MS : INFO_TIMEOUT_MS;
  if (timeout > 0) {
    window.setTimeout(() => removeToast(toast), timeout);
  }
}

window.addEventListener(TOAST_EVENT, (event) => {
  showToast(event instanceof CustomEvent ? event.detail : {});
});
