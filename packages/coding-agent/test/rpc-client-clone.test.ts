import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient clone", () => {
	it("sends the clone RPC command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "clone",
			success: true,
			data: { cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.clone();

		expect(send).toHaveBeenCalledWith({ type: "clone", name: undefined });
		expect(result).toEqual({ cancelled: false });
	});

	it("sends the clone RPC command with a name", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "clone",
			success: true,
			data: { cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.clone("my clone");

		expect(send).toHaveBeenCalledWith({ type: "clone", name: "my clone" });
		expect(result).toEqual({ cancelled: false });
	});
});

describe("RpcClient newSession", () => {
	it("sends the new_session RPC command with a name", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "new_session",
			success: true,
			data: { cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.newSession(undefined, "my session");

		expect(send).toHaveBeenCalledWith({ type: "new_session", parentSession: undefined, name: "my session" });
		expect(result).toEqual({ cancelled: false });
	});
});

describe("RpcClient fork", () => {
	it("sends the fork RPC command with a name", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "fork",
			success: true,
			data: { text: "hello", cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.fork("entry-1", "my fork");

		expect(send).toHaveBeenCalledWith({ type: "fork", entryId: "entry-1", name: "my fork" });
		expect(result).toEqual({ text: "hello", cancelled: false });
	});
});
