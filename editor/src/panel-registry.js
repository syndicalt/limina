// Studio shell panel registry (plans/studio-unification.md, Chunk U1): named panels, ordered
// layout profiles (full "studio" vs docs/maps-only "design"), per-profile visibility overrides,
// and serializable layout state. PURE STATE — no DOM, no timers — so it runs in plain node and
// can be driven by any renderer (editor chrome today, a worker later).
//
// Constraints:
// - Storage is dependency-injected ({ load, save }); without it the registry is memory-only.
//   Bootstrap order is register → defineProfile → restore(storage.load(key)): registration and
//   profile definitions are static declarations, so they never persist and never fire onChange.
//   Only layout mutations (setProfile / show / hide / restore) persist, then notify.
// - Overrides are scoped to the current profile: setProfile and restore replace them wholesale.
// - visibleIds is canonical: base set in profile-declaration order (registration order while no
//   profile is active), then shown extras in registration order. An unordered Set-based list is
//   a bug — snapshot equality and renderer diffing depend on this order.
// - profileMembership restricts which profiles may contain a panel; undefined = all profiles.
//   Enforced at defineProfile / show / restore time (panels register before profiles exist).
//   A panel registered after defineProfile is not retroactively added to that profile.
// - Snapshots are canonical: hide ⊆ base set, show ∩ base set = ∅. restore(state()) is an
//   identity; anything state() cannot emit is malformed.
// - Malformed input throws TypeError; unknown or duplicate ids/profiles throw Error.
// - storage.save must not throw: a throwing adapter aborts the commit after state is applied.

const DEFAULT_STORAGE_KEY = "limina.studio.panel-layout/v1";

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0;

const isId = (value) => typeof value === "string" && value.length > 0;

function requireShape(value, required, allowed, what) {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.includes(key)) throw new TypeError(`${what} does not allow key "${key}"`);
  }
  for (const key of required) {
    if (!keys.includes(key)) throw new TypeError(`${what} requires key "${key}"`);
  }
}

function requireIdList(value, what) {
  if (!Array.isArray(value) || value.some((id) => !isId(id))) {
    throw new TypeError(`${what} must be an array of non-empty string ids`);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${what} must not repeat ids`);
}

export function createPanelRegistry(options = {}) {
  if (!isPlainObject(options)) throw new TypeError("panel registry options must be a plain object");
  requireShape(options, [], ["storage", "storageKey", "onChange"], "panel registry options");
  const { storage, onChange } = options;
  const storageKey = options.storageKey === undefined ? DEFAULT_STORAGE_KEY : options.storageKey;
  if (storage !== undefined && (typeof storage.load !== "function" || typeof storage.save !== "function")) {
    throw new TypeError("panel registry storage must provide load(key) and save(key, value)");
  }
  if (!isId(storageKey)) throw new TypeError("panel registry storageKey must be a non-empty string");
  if (onChange !== undefined && typeof onChange !== "function") {
    throw new TypeError("panel registry onChange must be a function");
  }

  const panels = new Map();       // id -> frozen descriptor, in registration order
  const profiles = new Map();     // name -> frozen ordered id array (explicit visible set)
  let currentProfile = null;      // null = default set: defaultVisible panels, registration order
  const shownExtras = new Set();  // shown ids outside the base set
  const hiddenBase = new Set();   // hidden ids inside the base set

  const baseIds = () => currentProfile === null
    ? [...panels.values()].filter((panel) => panel.defaultVisible).map((panel) => panel.id)
    : [...profiles.get(currentProfile)];

  function requirePanel(id, what) {
    if (!isId(id)) throw new TypeError(`${what} id must be a non-empty string`);
    const panel = panels.get(id);
    if (panel === undefined) throw new Error(`unknown panel "${id}"`);
    return panel;
  }

  function visibleIds() {
    const base = baseIds().filter((id) => !hiddenBase.has(id));
    const extras = [...panels.keys()].filter((id) => shownExtras.has(id));
    return [...base, ...extras];
  }

  function state() {
    const order = new Map([...panels.keys()].map((id, index) => [id, index]));
    const byRegistration = (a, b) => order.get(a) - order.get(b);
    return {
      profile: currentProfile,
      overrides: {
        show: [...shownExtras].sort(byRegistration),
        hide: [...hiddenBase].sort(byRegistration),
      },
    };
  }

  function commit() {
    if (storage !== undefined) storage.save(storageKey, state());
    if (onChange !== undefined) onChange(state()); // fresh snapshot per notification
  }

  function register(descriptor) {
    if (!isPlainObject(descriptor)) throw new TypeError("panel descriptor must be a plain object");
    requireShape(descriptor, ["id", "title"], ["id", "title", "profileMembership", "defaultVisible"], "panel descriptor");
    const { id, title, profileMembership, defaultVisible } = descriptor;
    if (!isId(id)) throw new TypeError("panel id must be a non-empty string");
    if (panels.has(id)) throw new Error(`duplicate panel "${id}"`);
    if (typeof title !== "string" || title.length === 0) {
      throw new TypeError(`panel "${id}" title must be a non-empty string`);
    }
    if (profileMembership !== undefined) requireIdList(profileMembership, `panel "${id}" profileMembership`);
    if (defaultVisible !== undefined && typeof defaultVisible !== "boolean") {
      throw new TypeError(`panel "${id}" defaultVisible must be a boolean`);
    }
    panels.set(id, Object.freeze({
      id,
      title,
      membership: profileMembership === undefined ? undefined : Object.freeze([...profileMembership]),
      defaultVisible: defaultVisible !== false,
    }));
  }

  function defineProfile(name, panelIds) {
    if (!isId(name)) throw new TypeError("profile name must be a non-empty string");
    if (profiles.has(name)) throw new Error(`duplicate profile "${name}"`);
    requireIdList(panelIds, `profile "${name}" panel list`);
    for (const id of panelIds) {
      const panel = panels.get(id);
      if (panel === undefined) throw new Error(`profile "${name}" lists unknown panel "${id}"`);
      if (panel.membership !== undefined && !panel.membership.includes(name)) {
        throw new Error(`panel "${id}" is not a member of profile "${name}"`);
      }
    }
    profiles.set(name, Object.freeze([...panelIds]));
  }

  function setProfile(name) {
    if (!isId(name)) throw new TypeError("profile name must be a non-empty string");
    if (!profiles.has(name)) throw new Error(`unknown profile "${name}"`);
    currentProfile = name;
    shownExtras.clear();
    hiddenBase.clear();
    commit();
  }

  function show(id) {
    const panel = requirePanel(id, "show");
    if (currentProfile !== null && panel.membership !== undefined && !panel.membership.includes(currentProfile)) {
      throw new Error(`panel "${id}" is not a member of profile "${currentProfile}"`);
    }
    hiddenBase.delete(id);
    if (!baseIds().includes(id)) shownExtras.add(id);
    commit();
  }

  function hide(id) {
    requirePanel(id, "hide");
    shownExtras.delete(id);
    if (baseIds().includes(id)) hiddenBase.add(id);
    commit();
  }

  function restore(snapshot) {
    if (!isPlainObject(snapshot)) throw new TypeError("panel layout snapshot must be a plain object");
    requireShape(snapshot, ["profile", "overrides"], ["profile", "overrides"], "panel layout snapshot");
    const { profile, overrides } = snapshot;
    if (profile !== null && !isId(profile)) throw new TypeError("snapshot profile must be null or a non-empty string");
    if (profile !== null && !profiles.has(profile)) throw new Error(`snapshot names unknown profile "${profile}"`);
    if (!isPlainObject(overrides)) throw new TypeError("snapshot overrides must be a plain object");
    requireShape(overrides, ["show", "hide"], ["show", "hide"], "snapshot overrides");
    requireIdList(overrides.show, "snapshot overrides.show");
    requireIdList(overrides.hide, "snapshot overrides.hide");
    for (const id of [...overrides.show, ...overrides.hide]) {
      if (!panels.has(id)) throw new Error(`snapshot names unknown panel "${id}"`);
    }
    if (overrides.show.some((id) => overrides.hide.includes(id))) {
      throw new TypeError("snapshot overrides.show and overrides.hide overlap");
    }
    // Canonicality is checked against the snapshot's profile, not the current one.
    const base = new Set(profile === null
      ? [...panels.values()].filter((panel) => panel.defaultVisible).map((panel) => panel.id)
      : profiles.get(profile));
    for (const id of overrides.hide) {
      if (!base.has(id)) throw new TypeError(`snapshot hides "${id}", which is outside the base set`);
    }
    for (const id of overrides.show) {
      if (base.has(id)) throw new TypeError(`snapshot shows "${id}", which is already in the base set`);
      const panel = panels.get(id);
      if (profile !== null && panel.membership !== undefined && !panel.membership.includes(profile)) {
        throw new Error(`panel "${id}" is not a member of profile "${profile}"`);
      }
    }
    currentProfile = profile;
    shownExtras.clear();
    for (const id of overrides.show) shownExtras.add(id);
    hiddenBase.clear();
    for (const id of overrides.hide) hiddenBase.add(id);
    commit();
  }

  return Object.freeze({ register, defineProfile, setProfile, show, hide, visibleIds, state, restore });
}
