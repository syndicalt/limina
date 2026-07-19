import { createHash } from "node:crypto";

export const SEARCH_SCHEMA = "limina.visual-reference-search/v1";
export const CANDIDATE_SCHEMA = "limina.visual-reference-candidates/v1";
const MEDIA = new Set(["image", "3d-model", "material"]);
const HTTPS = /^https:\/\//;
const MAX_QUERY = 240;
const MAX_RESULTS = 100;

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const url = (value) => {
  const candidate = text(value);
  if (!candidate || !HTTPS.test(candidate)) return undefined;
  try {
    return new URL(candidate).href;
  } catch {
    return undefined;
  }
};
const integer = (value) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined);
const array = (value) => (Array.isArray(value) ? value : []);
const stableId = (provider, id, canonicalPageUrl) =>
  `${provider}/${text(id) ?? createHash("sha256").update(canonicalPageUrl).digest("hex").slice(0, 20)}`;
const terms = (query) =>
  query
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/u)
    .filter((part) => part.length > 1);
const lexicalScore = (query, candidate) => {
  const haystack =
    `${candidate.title ?? ""} ${candidate.description ?? ""} ${array(candidate.tags).join(" ")}`.toLocaleLowerCase(
      "en-US",
    );
  return terms(query).reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
};
async function mapBounded(values, concurrency, mapper) {
  const output = new Array(values.length),
    workers = Array.from({ length: Math.min(concurrency, values.length) }, async (_, worker) => {
      for (let index = worker; index < values.length; index += concurrency)
        output[index] = await mapper(values[index], index);
    });
  await Promise.all(workers);
  return output;
}

export function normalizeQuery(input) {
  if (!input || typeof input !== "object") throw new Error("reference query must be an object");
  const query = text(input.query);
  if (!query || query.length > MAX_QUERY) throw new Error(`reference query must contain 1-${MAX_QUERY} characters`);
  const mediaKinds = [...new Set(array(input.mediaKinds).map(text).filter(Boolean))];
  if (!mediaKinds.length || mediaKinds.some((kind) => !MEDIA.has(kind)))
    throw new Error("reference query requires valid mediaKinds");
  const limit = integer(input.limit) ?? 24;
  if (limit > MAX_RESULTS) throw new Error(`reference query limit exceeds ${MAX_RESULTS}`);
  return { schema: SEARCH_SCHEMA, query, mediaKinds, limit };
}

export function normalizeCandidate(raw, { provider, query, providerRank }) {
  const canonicalPageUrl = url(raw.canonicalPageUrl);
  if (!canonicalPageUrl) throw new Error(`${provider} result lacks a canonical HTTPS page URL`);
  const warnings = [...new Set(array(raw.warnings).map(text).filter(Boolean))].sort();
  const creator = text(raw.creator);
  const rights = text(raw.rights);
  const license = text(raw.license);
  const rightsUrl = url(raw.rightsUrl);
  const provenanceComplete = Boolean(creator && rights && license && license.toLocaleLowerCase("en-US") !== "unknown");
  if (!provenanceComplete) warnings.push("ineligible: rights, license, or creator provenance is incomplete");
  const mediaKind = MEDIA.has(raw.mediaKind) ? raw.mediaKind : "image";
  const result = {
    id: stableId(provider, raw.providerId, canonicalPageUrl),
    provider,
    providerId: text(raw.providerId) ?? "unidentified",
    query,
    providerRank: integer(providerRank) ?? 1,
    mediaKind,
    title: text(raw.title) ?? "Untitled reference",
    canonicalPageUrl,
    previewUrl: url(raw.previewUrl),
    originalUrl: provenanceComplete ? url(raw.originalUrl) : undefined,
    creator,
    rights,
    license,
    rightsUrl,
    dimensions:
      integer(raw.width) && integer(raw.height)
        ? { width: integer(raw.width), height: integer(raw.height) }
        : undefined,
    format: text(raw.format)?.toLocaleLowerCase("en-US"),
    tags: [...new Set(array(raw.tags).map(text).filter(Boolean))].sort(),
    eligibleForCuration: provenanceComplete,
    warnings: [...new Set(warnings)].sort(),
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

export function rankAndDeduplicate(query, candidates, limit) {
  const byCanonical = new Map();
  for (const candidate of candidates) {
    const key = candidate.canonicalPageUrl
      .replace(/[?#].*$/u, "")
      .replace(/\/$/u, "")
      .toLocaleLowerCase("en-US");
    const current = byCanonical.get(key);
    if (
      !current ||
      candidate.eligibleForCuration > current.eligibleForCuration ||
      candidate.providerRank < current.providerRank
    )
      byCanonical.set(key, candidate);
  }
  return [...byCanonical.values()]
    .sort(
      (a, b) =>
        Number(b.eligibleForCuration) - Number(a.eligibleForCuration) ||
        lexicalScore(query, b) - lexicalScore(query, a) ||
        a.providerRank - b.providerRank ||
        a.provider.localeCompare(b.provider) ||
        a.providerId.localeCompare(b.providerId),
    )
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

const metadataValue = (metadata, key) =>
  text(metadata?.[key]?.value)
    ?.replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
const commonsLicense = (metadata) => metadataValue(metadata, "LicenseShortName");

export function createWikimediaCommonsProvider() {
  return {
    id: "wikimedia-commons",
    async search(request, { fetchJson }) {
      if (!request.mediaKinds.includes("image")) return [];
      const endpoint = new URL("https://commons.wikimedia.org/w/api.php");
      Object.entries({
        action: "query",
        generator: "search",
        gsrnamespace: "6",
        gsrsearch: request.query,
        gsrlimit: String(request.limit),
        prop: "imageinfo|info",
        inprop: "url",
        iiprop: "url|size|mime|extmetadata",
        iiurlwidth: "960",
        format: "json",
        origin: "*",
      }).forEach(([key, value]) => endpoint.searchParams.set(key, value));
      const body = await fetchJson(endpoint.href);
      return Object.values(body?.query?.pages ?? {})
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((page) => {
          const image = page.imageinfo?.[0] ?? {},
            meta = image.extmetadata ?? {};
          return {
            providerId: String(page.pageid),
            title: page.title?.replace(/^File:/u, ""),
            canonicalPageUrl: page.canonicalurl ?? page.fullurl,
            previewUrl: image.thumburl ?? image.url,
            originalUrl: image.url,
            creator: metadataValue(meta, "Artist") ?? metadataValue(meta, "Credit"),
            rights: metadataValue(meta, "UsageTerms") ?? commonsLicense(meta),
            license: commonsLicense(meta),
            rightsUrl: metadataValue(meta, "LicenseUrl"),
            width: image.width,
            height: image.height,
            format: image.mime?.split("/")[1],
            mediaKind: "image",
            description: metadataValue(meta, "ImageDescription"),
          };
        });
    },
  };
}

export function createMetProvider() {
  return {
    id: "met",
    async search(request, { fetchJson }) {
      if (!request.mediaKinds.includes("image")) return [];
      const searchUrl = `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${encodeURIComponent(request.query)}`;
      const found = await fetchJson(searchUrl),
        ids = array(found?.objectIDs).slice(0, request.limit),
        objects = await mapBounded(ids, 6, (id) =>
          fetchJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`),
        );
      return objects
        .filter((item) => item?.objectID && item?.objectURL && (item.primaryImageSmall || item.primaryImage))
        .map((item) => ({
          providerId: String(item.objectID),
          title: item.title,
          canonicalPageUrl: item.objectURL,
          previewUrl: item.primaryImageSmall || item.primaryImage,
          originalUrl: item.isPublicDomain ? item.primaryImage : undefined,
          creator: item.artistDisplayName || item.culture || "Unknown maker; The Metropolitan Museum of Art",
          rights: item.isPublicDomain ? "Public Domain / The Met Open Access" : "Rights not established by API",
          license: item.isPublicDomain ? "CC0 1.0" : "unknown",
          rightsUrl: item.isPublicDomain
            ? "https://www.metmuseum.org/about-the-met/policies-and-documents/open-access"
            : undefined,
          mediaKind: "image",
          tags: array(item.tags).map((tag) => tag?.term),
          warnings: item.isPublicDomain ? [] : ["Met API does not mark this object public domain"],
        }));
    },
  };
}

export function createSketchfabProvider({ token } = {}) {
  return {
    id: "sketchfab",
    async search(request, { fetchJson }) {
      if (!request.mediaKinds.includes("3d-model")) return [];
      const endpoint = `https://api.sketchfab.com/v3/search?type=models&q=${encodeURIComponent(request.query)}&count=${request.limit}`;
      const body = await fetchJson(endpoint, { headers: token ? { Authorization: `Token ${token}` } : {} });
      return array(body?.results).map((item) => ({
        providerId: item.uid,
        title: item.name,
        canonicalPageUrl: item.viewerUrl ?? `https://sketchfab.com/3d-models/${item.uid}`,
        previewUrl: [...array(item.thumbnails?.images)].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url,
        creator: item.user?.displayName ?? item.user?.username,
        rights: item.license?.label,
        license: item.license?.label,
        rightsUrl: item.license?.url,
        mediaKind: "3d-model",
        tags: array(item.tags).map((tag) => tag?.name ?? tag),
        warnings: ["reference thumbnail only; model download/import is outside reference discovery policy"],
      }));
    },
  };
}

export function createPolyHavenProvider() {
  return {
    id: "poly-haven",
    async search(request, { fetchJson }) {
      const desired = request.mediaKinds.filter((kind) => kind === "material" || kind === "3d-model");
      if (!desired.length) return [];
      const all = [];
      for (const type of desired.map((kind) => (kind === "material" ? "textures" : "models"))) {
        const body = await fetchJson(`https://api.polyhaven.com/assets?t=${type}`);
        for (const [id, item] of Object.entries(body ?? {}))
          all.push({
            providerId: id,
            title: item.name ?? id,
            description: item.description,
            canonicalPageUrl: `https://polyhaven.com/a/${id}`,
            previewUrl: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=512&height=512`,
            creator: item.authors ? Object.keys(item.authors).join(", ") : "Poly Haven contributors",
            rights: "CC0",
            license: "CC0 1.0",
            rightsUrl: "https://polyhaven.com/license",
            mediaKind: type === "textures" ? "material" : "3d-model",
            tags: [...array(item.categories), ...array(item.tags)],
          });
      }
      return all
        .sort(
          (a, b) =>
            lexicalScore(request.query, b) - lexicalScore(request.query, a) || a.providerId.localeCompare(b.providerId),
        )
        .slice(0, request.limit);
    },
  };
}

export function createEuropeanaProvider({ apiKey } = {}) {
  return {
    id: "europeana",
    enabled: Boolean(apiKey),
    async search(request, { fetchJson }) {
      if (!apiKey || !request.mediaKinds.includes("image")) return [];
      const endpoint = `https://api.europeana.eu/record/v2/search.json?wskey=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(request.query)}&media=true&rows=${request.limit}`;
      const body = await fetchJson(endpoint);
      return array(body?.items).map((item) => ({
        providerId: item.id,
        title: array(item.title)[0],
        canonicalPageUrl: array(item.guid)[0] ?? item.guid,
        previewUrl: array(item.edmPreview)[0],
        originalUrl: array(item.edmIsShownBy)[0],
        creator: array(item.dcCreator)[0],
        rights: array(item.rights)[0],
        license: array(item.rights)[0],
        rightsUrl: array(item.rights)[0],
        mediaKind: "image",
        format: array(item.dcFormat)[0],
      }));
    },
  };
}

export function createSmithsonianProvider({ apiKey } = {}) {
  return {
    id: "smithsonian",
    enabled: Boolean(apiKey),
    async search(request, { fetchJson }) {
      if (!apiKey || !request.mediaKinds.includes("image")) return [];
      const endpoint = `https://api.si.edu/openaccess/api/v1.0/search?q=${encodeURIComponent(request.query)}&rows=${request.limit}&api_key=${encodeURIComponent(apiKey)}`,
        body = await fetchJson(endpoint);
      return array(body?.response?.rows).map((row) => {
        const content = row.content ?? {},
          fre = content.descriptiveNonRepeating ?? {},
          online = array(fre.online_media?.media)[0] ?? {},
          indexed = content.indexedStructured ?? {};
        return {
          providerId: row.id,
          title: row.title,
          canonicalPageUrl: fre.record_link ?? `https://www.si.edu/object/${encodeURIComponent(row.id)}`,
          previewUrl: online.thumbnail ?? online.content,
          originalUrl: online.content,
          creator: array(indexed.name)[0] ?? array(indexed.artist)[0],
          rights: online.rights ?? fre.metadata_usage?.access,
          license: online.rights ?? fre.metadata_usage?.access,
          mediaKind: "image",
          format: online.type,
        };
      });
    },
  };
}

export function createManualIngestionProvider(entries = []) {
  return {
    id: "manual-web",
    async search(request) {
      return entries
        .filter((entry) => !entry.query || entry.query === request.query)
        .slice(0, request.limit)
        .map((entry) => ({
          ...entry,
          mediaKind: entry.mediaKind ?? "image",
          warnings: [
            ...array(entry.warnings),
            "manually ingested web-search result; verify page-level provenance before curation",
          ],
        }));
    },
  };
}

export async function searchVisualReferences(
  input,
  { providers, fetchJson = defaultFetchJson, clock = () => new Date() } = {},
) {
  const request = normalizeQuery(input),
    selected = array(providers).filter((provider) => provider?.enabled !== false);
  if (!selected.length) throw new Error("reference search requires at least one enabled provider");
  const candidates = [],
    failures = [];
  for (const provider of selected) {
    try {
      const raws = array(await provider.search(request, { fetchJson })).slice(0, request.limit);
      raws.forEach((raw, index) =>
        candidates.push(
          normalizeCandidate(raw, { provider: provider.id, query: request.query, providerRank: index + 1 }),
        ),
      );
    } catch (error) {
      failures.push({ provider: provider.id, error: String(error?.message ?? error) });
    }
  }
  const results = rankAndDeduplicate(request.query, candidates, request.limit);
  return {
    schema: CANDIDATE_SCHEMA,
    query: request,
    generatedAt: clock().toISOString(),
    policy: {
      purpose: "reference-and-inspiration-only",
      productionAssetImportAllowed: false,
      unknownRightsEligible: false,
    },
    curationHandoff: {
      tool: "tools/reference/promote-visual-reference-candidates.mjs",
      acquisitionTool: "tools/reference/acquire-visual-reference-board.mjs",
      automaticPromotionAllowed: false,
    },
    providers: selected.map(({ id }) => id),
    failures,
    results,
  };
}

export function createAcquisitionManifest(candidates, selection) {
  if (candidates?.schema !== CANDIDATE_SCHEMA) throw new Error("unsupported visual reference candidate manifest");
  if (
    !selection ||
    typeof selection !== "object" ||
    !text(selection.id) ||
    !text(selection.subjectKind) ||
    !Array.isArray(selection.sources) ||
    selection.sources.length === 0
  )
    throw new Error("selection requires id, subjectKind, and non-empty sources");
  const byId = new Map(array(candidates.results).map((candidate) => [candidate.id, candidate]));
  const seen = new Set(),
    sources = selection.sources.map((choice) => {
      const candidate = byId.get(choice.candidateId);
      if (!candidate) throw new Error(`selected candidate does not exist: ${choice.candidateId}`);
      if (seen.has(candidate.id)) throw new Error(`duplicate selected candidate: ${candidate.id}`);
      seen.add(candidate.id);
      if (!candidate.eligibleForCuration || candidate.mediaKind !== "image" || !candidate.originalUrl)
        throw new Error(`selected candidate is not eligible for image acquisition: ${candidate.id}`);
      const roles = [...new Set(array(choice.roles).map(text).filter(Boolean))];
      if (!roles.length) throw new Error(`selected candidate requires at least one visual role: ${candidate.id}`);
      return {
        id: candidate.id,
        sourceUrl: candidate.canonicalPageUrl,
        imageUrl: candidate.originalUrl,
        creator: candidate.creator,
        license: candidate.license,
        roles,
      };
    });
  return {
    schema: "limina.visual-reference-acquisition/v1",
    id: selection.id,
    subjectKind: selection.subjectKind,
    sources,
  };
}

export async function defaultFetchJson(resource, options = {}) {
  const response = await fetch(resource, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(15_000),
    redirect: "follow",
    headers: {
      accept: "application/json",
      "user-agent": "Limina visual reference discovery/1.0",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(resource).origin}`);
  return response.json();
}
