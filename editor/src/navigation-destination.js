const DEFAULT_TIMEOUT_MS = 30_000;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function finiteCenter(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) {
    throw new TypeError("navigation residency center must be a finite [x,z]");
  }
  const center = [];
  for (let index = 0; index < 2; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !("value" in descriptor)
        || typeof descriptor.value !== "number" || !Number.isFinite(descriptor.value)) {
      throw new TypeError("navigation residency center must be a finite [x,z]");
    }
    center.push(Object.is(descriptor.value, -0) ? 0 : descriptor.value);
  }
  return Object.freeze(center);
}

function destinationResidency(current, center) {
  if (current === null || Array.isArray(current) || typeof current !== "object") {
    throw new TypeError("active derived residency is unavailable");
  }
  return Object.freeze({ ...current, center: finiteCenter(center) });
}

function requireContext(context) {
  const runtime = context?.runtime;
  const client = context?.client;
  const navigation = runtime?.editorNavigation;
  if (!runtime || !client || !navigation || typeof context.isCurrent !== "function"
      || typeof client.reconcileResidency !== "function"
      || typeof runtime.derivedTerrainResidency !== "function"
      || typeof navigation.snapshot !== "function" || typeof navigation.restore !== "function"
      || typeof navigation.residencyCenter !== "function" || typeof navigation.acquireDisabled !== "function") {
    throw codedError("NAVIGATION_UNAVAILABLE", "editor navigation is not ready");
  }
  if (!context.isCurrent()) throw codedError("NAVIGATION_STALE_CONTEXT", "editor navigation context is stale");
  return { ...context, runtime, client, navigation };
}

/**
 * Coordinates discontinuous camera travel with the derived residency worker.
 * Continuous orbit/fly movement does not use this path.
 */
export function createNavigationDestinationCoordinator({
  getContext,
  onState = () => {},
  onCommit = () => {},
  resetContext = async () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof getContext !== "function") throw new TypeError("navigation destination getContext is required");
  if (typeof onState !== "function" || typeof onCommit !== "function" || typeof resetContext !== "function") {
    throw new TypeError("navigation destination callbacks must be functions");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new RangeError("navigation destination timeout is invalid");
  }

  let active;
  let sequence = 0;

  const publish = (busy, label = "", code = "") => {
    try { onState(Object.freeze({ busy, label: String(label).slice(0, 80), code })); }
    catch { /* status observers cannot break navigation cleanup */ }
  };

  async function navigate(pose, { label = "destination", metadata } = {}) {
    if (active !== undefined) throw codedError("NAVIGATION_BUSY", "another navigation destination is loading");
    const context = requireContext(getContext());
    const priorPose = context.navigation.snapshot();
    const priorResidency = context.runtime.derivedTerrainResidency();
    const residency = destinationResidency(priorResidency, context.navigation.residencyCenter(pose));
    const ticket = { id: ++sequence, context, priorPose, priorResidency, residency, timer: undefined };
    const releaseNavigation = context.navigation.acquireDisabled();
    if (typeof releaseNavigation !== "function") throw new TypeError("editor navigation disable lease is invalid");
    active = ticket;
    publish(true, label);

    let timeoutReject;
    const timeout = new Promise((_resolve, reject) => { timeoutReject = reject; });
    try {
      ticket.timer = setTimer(() => {
        timeoutReject(codedError("NAVIGATION_TIMEOUT", "destination terrain did not become ready in time"));
      }, timeoutMs);
      const result = await Promise.race([context.client.reconcileResidency(residency), timeout]);
      if (active !== ticket || !context.isCurrent()) {
        throw codedError("NAVIGATION_STALE_CONTEXT", "editor navigation context changed while loading");
      }
      context.navigation.restore(pose);
      const committed = Object.freeze({ pose: context.navigation.snapshot(), residency, result, metadata });
      try { onCommit(committed); } catch { /* persistence/telemetry cannot roll back a ready destination */ }
      publish(false, label);
      return committed;
    } catch (error) {
      const failure = error instanceof Error ? error : codedError("NAVIGATION_FAILED", "destination navigation failed");
      if (active === ticket && context.isCurrent()) {
        try { context.navigation.restore(priorPose); } catch { /* runtime may have failed closed */ }
        if (failure.code === "NAVIGATION_TIMEOUT") {
          await resetContext(context, failure).catch(() => undefined);
        } else {
          await context.client.reconcileResidency(priorResidency).catch(() => undefined);
        }
      }
      publish(false, label, typeof failure.code === "string" ? failure.code : "NAVIGATION_FAILED");
      throw failure;
    } finally {
      if (ticket.timer !== undefined) clearTimer(ticket.timer);
      if (active === ticket) {
        active = undefined;
        try { releaseNavigation(); } catch { /* runtime may have been replaced */ }
      }
    }
  }

  return Object.freeze({
    navigate,
    busy: () => active !== undefined,
  });
}
