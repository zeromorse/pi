/**
 * mcli provider compatibility shim.
 *
 * The mcli provider (internal proxy for Claude-compatible endpoints) drops
 * requests whose system prompt does not start with the official Claude Code
 * marker. This extension injects that marker as the leading system block on
 * every mcli request, without touching requests for other providers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MCLI_SYSTEM_MARKER = "You are Claude Code, Anthropic's official CLI for Claude.";

type SystemTextPart = { type: "text"; text: string };

interface McliPayload {
	system?: unknown;
}

export default function mcliCompat(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "mcli") return;

		const payload = event.payload as McliPayload | undefined;
		if (!payload || typeof payload !== "object") return;

		const marker: SystemTextPart = { type: "text", text: MCLI_SYSTEM_MARKER };
		const currentSystem = payload.system;

		if (Array.isArray(currentSystem)) {
			const alreadyPresent = currentSystem.some(
				(part) =>
					typeof part === "object" &&
					part !== null &&
					(part as SystemTextPart).type === "text" &&
					(part as SystemTextPart).text === MCLI_SYSTEM_MARKER,
			);
			if (alreadyPresent) return;
			return { ...payload, system: [marker, ...currentSystem] };
		}

		if (typeof currentSystem === "string" && currentSystem.length > 0) {
			if (currentSystem === MCLI_SYSTEM_MARKER) return;
			return {
				...payload,
				system: [marker, { type: "text", text: currentSystem }],
			};
		}

		return { ...payload, system: [marker] };
	});
}
