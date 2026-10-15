import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Makes omp's OpenCode Zen free-model requests pass OpenCode's free-tier gate by presenting them as
// the opencode client. Installs a process-wide fetch wrapper; the repository README lists what the gate checks.

const zenInferencePath =
	/^\/zen\/(?:v\d+(?:beta)?\/)?(?:chat\/completions|responses|messages|systemone|models\/([^/]+):(?:streamGenerateContent|generateContent))\/?$/;

/** Returns the parsed URL when `input` targets an OpenCode Zen inference route (OpenCode Go under /zen/go is excluded). */
function zenInferenceUrl(input: string | URL | Request): URL | undefined {
	const url = new URL(input instanceof Request ? input.url : input);
	return url.origin === "https://opencode.ai" && zenInferencePath.test(url.pathname) ? url : undefined;
}

// OpenCode's descending identifier (packages/schema/src/identifier.ts). The free-tier gate rejects any
// session id whose 12-hex prefix is not `~(ms * 0x1000 + counter)`, so hashed or random ids get 403.
const idChars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdTimestamp = 0;
let idCounter = 0;

function descendingSessionId(): string {
	const now = Date.now();
	if (now !== lastIdTimestamp) {
		lastIdTimestamp = now;
		idCounter = 0;
	}
	idCounter++;
	const time = ~(BigInt(now) * 0x1000n + BigInt(idCounter)) & 0xffffffffffffn;
	const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), byte => idChars[byte % 62]).join("");
	return `ses_${time.toString(16).padStart(12, "0")}${random}`;
}

/** One stable opencode session per omp session, so the gateway keeps provider/cache affinity. */
const opencodeSessions = new Map<string, string>();

function opencodeSessionId(source: string | null): string {
	const key = source ?? "";
	let id = opencodeSessions.get(key);
	if (id === undefined) {
		id = descendingSessionId();
		opencodeSessions.set(key, id);
	}
	return id;
}

/** Applies the opencode client identity: UA plus the session under both headers the gate requires. */
function withIdentity(input: string | URL | Request, init: RequestInit | undefined): RequestInit {
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	const session = opencodeSessionId(headers.get("x-opencode-session"));
	headers.set("x-opencode-session", session);
	headers.set("x-opencode-session-id", session);
	headers.set("User-Agent", "opencode/1.18.35");
	return { ...init, headers };
}

async function requestBodyText(input: string | URL | Request, init: RequestInit | undefined): Promise<string | undefined> {
	const body = init?.body;
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
	if (body == null && input instanceof Request) return input.clone().text();
	return undefined;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function requestBodyJson(input: string | URL | Request, init: RequestInit | undefined): Promise<JsonObject | undefined> {
	try {
		const text = await requestBodyText(input, init);
		if (text === undefined) return undefined;
		const parsed: unknown = JSON.parse(text);
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

// OpenCode's free-tier gate also rejects (403 FreeTierError) any request that does not declare a `read`
// tool whose parameter schema has at least one property (empty `properties` fails). Earlier gate revisions
// also required `bash`. Main sessions carry both, but title generation (no tools), advisors
// (advise/read/grep/glob), and read-only subagents do not, so the missing ones are declared as
// never-callable placeholders shaped like opencode's own tools.
const requiredToolNames = ["read", "bash"];
const placeholderDescription = "Unavailable in this request. Never call this tool.";
const placeholderParameter: Record<string, string> = { read: "filePath", bash: "command" };

function declaredToolName(tool: unknown): string | undefined {
	if (!isJsonObject(tool)) return undefined;
	if (typeof tool.name === "string") return tool.name;
	return isJsonObject(tool.function) && typeof tool.function.name === "string" ? tool.function.name : undefined;
}

function placeholderTool(pathname: string, name: string): JsonObject {
	const parameter = placeholderParameter[name];
	const schema = { type: "object", properties: { [parameter]: { type: "string" } }, required: [parameter], additionalProperties: false };
	if (/\/chat\/completions\/?$/.test(pathname)) {
		return { type: "function", function: { name, description: placeholderDescription, parameters: schema } };
	}
	if (/\/messages\/?$/.test(pathname)) {
		return { name, description: placeholderDescription, input_schema: schema };
	}
	return { type: "function", name, description: placeholderDescription, parameters: schema };
}

/** Returns the re-serialized body with the gate's required tools declared, or undefined when nothing is missing. */
function withRequiredTools(pathname: string, body: JsonObject): string | undefined {
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const declared = new Set(tools.map(declaredToolName));
	const missing = requiredToolNames.filter(name => !declared.has(name));
	if (missing.length === 0) return undefined;
	return JSON.stringify({ ...body, tools: [...tools, ...missing.map(name => placeholderTool(pathname, name))] });
}

/** Process-wide handler: every free Zen chat request passes the free-tier gate, whoever issued it. */
async function freeTierFetch(fetch: FetchImpl, input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const url = zenInferenceUrl(input);
	if (!url) return fetch(input, init);
	const pathModel = zenInferencePath.exec(url.pathname)?.[1];
	const body = pathModel === undefined ? await requestBodyJson(input, init) : undefined;
	const modelId = pathModel !== undefined ? decodeURIComponent(pathModel) : typeof body?.model === "string" ? body.model : undefined;
	if (
		modelId === undefined ||
		!(modelId === "big-pickle" || modelId.endsWith("-free")) ||
		/^(?:jev|system[-_]?one)(?:[-_.]|$)/i.test(modelId)
	) {
		return fetch(input, init);
	}
	// The free tier is served only from /inference/v1 now; the same request to /zen/v1 is always 403.
	url.pathname = url.pathname.replace(/^\/zen\//, "/inference/");
	const target = input instanceof Request ? new Request(url, input) : url;
	const identified = withIdentity(input, init);
	const patchedBody = body ? withRequiredTools(url.pathname, body) : undefined;
	if (patchedBody === undefined) return fetch(target, identified);
	const headers = new Headers(identified.headers);
	headers.delete("content-length");
	return fetch(target, { ...identified, headers, body: patchedBody });
}

type FetchHandler = (fetch: FetchImpl, input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface FetchSlot {
	original: FetchImpl;
	wrapper: FetchImpl;
	/** Replaced on every factory run so /reload picks up new code without stacking wrappers. */
	handler: FetchHandler;
}

const fetchSlotKey = Symbol.for("omp.opencode-zen-free.fetch");

function installFreeTierFetch(): void {
	const scope = globalThis as typeof globalThis & { [fetchSlotKey]?: FetchSlot };
	const existing = scope[fetchSlotKey];
	if (existing) {
		existing.handler = freeTierFetch;
		return;
	}
	const original: FetchImpl = globalThis.fetch;
	const wrapper: FetchImpl = (input, init) => slot.handler(slot.original, input, init);
	if (original.preconnect) wrapper.preconnect = original.preconnect.bind(original);
	const slot: FetchSlot = { original, wrapper, handler: freeTierFetch };
	scope[fetchSlotKey] = slot;
	globalThis.fetch = wrapper as typeof globalThis.fetch;
}

export default function (_pi: ExtensionAPI) {
	installFreeTierFetch();
}
