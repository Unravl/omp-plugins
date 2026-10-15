import { type JudgmentRequest, NativeJudge } from "@oh-my-pi/pi-ai/judgment";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Separate module so omp builds without NativeJudge (older than 18.10) still load the free-tier fix in index.ts.
// Jev's /systemone route is not behind the free-tier gate, so this needs no client identity.

export default function (pi: ExtensionAPI) {
	pi.registerCommand("zen-judge", {
		description: "Judge JSON {state, questions} with Jev 1.13 Free (noul, choice, score).",
		async handler(args, ctx) {
			let request: JudgmentRequest;
			try {
				request = JSON.parse(args) as JudgmentRequest;
				if (
					!request ||
					!(typeof request.state === "string" || (request.state !== null && typeof request.state === "object")) ||
					!request.questions ||
					typeof request.questions !== "object" ||
					Array.isArray(request.questions)
				) {
					throw new Error("Expected {state, questions}.");
				}
			} catch {
				ctx.ui.notify(
					'Usage: /zen-judge {"state":"...", "questions":{"id":{"type":"noul","instructions":"..."}}}',
					"error",
				);
				return;
			}
			const judge = new NativeJudge({
				apiKey: ctx.modelRegistry.resolver("opencode-zen", {
					sessionId: ctx.sessionManager.getSessionId(),
					baseUrl: "https://opencode.ai/zen",
					modelId: "jev-1.13-free",
				}),
				api: "typesafe",
				provider: "opencode-zen",
				baseUrl: "https://opencode.ai/zen",
				model: "jev-1.13-free",
			});
			const result = await judge.judge(request);
			pi.sendMessage({
				customType: "zen-judge",
				content: JSON.stringify(result, null, 2),
				details: result,
				display: true,
			});
		},
	});
}
