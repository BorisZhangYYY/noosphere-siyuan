// @vitest-environment jsdom
/** 原生代理连接覆盖压缩协商、实时读取、取消与令牌发送范围。 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchReviewStream } from "../src/siyuan/stream";

const host = window as unknown as { require?: unknown; siyuan?: unknown };
let incoming: EventEmitter & { statusCode: number; headers: Record<string, string>; pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
let request: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
let http: { request: ReturnType<typeof vi.fn> };

describe("desktop stream transport", () => {
  beforeEach(() => {
    incoming = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "siyuan-proxy-content-type": "text/event-stream" }, pause: vi.fn(), resume: vi.fn(), destroy: vi.fn() });
    request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    http = { request: vi.fn((_url, _options, accept) => { request.end.mockImplementation(() => queueMicrotask(() => accept(incoming))); return request; }) };
    host.require = vi.fn(() => http); host.siyuan = { config: { api: { token: "local-kernel-token" } } };
  });
  afterEach(() => { delete host.require; delete host.siyuan; vi.unstubAllGlobals(); });

  it("disables local response compression and delivers data before the response ends", async () => {
    const response = await fetchReviewStream("/api/network/proxy?u=remote-model", "中文", new AbortController().signal);
    const [target, options] = http.request.mock.calls[0];
    expect(new URL(target).origin).toBe(window.location.origin);
    expect(options.headers).toMatchObject({ "Accept-Encoding": "identity", Authorization: "Token local-kernel-token", "Content-Length": "6" });
    const reader = response.body!.getReader();
    incoming.emit("data", new TextEncoder().encode("data: first\n\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    incoming.emit("data", new TextEncoder().encode("data: second\n\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: second\n\n");
    incoming.emit("end"); expect((await reader.read()).done).toBe(true);
  });

  it("verifies local HTTPS using the workspace CA without disabling certificate checks", async () => {
    const readFileSync = vi.fn(() => "workspace CA");
    const requireModule = vi.fn(name => name === "fs" ? { readFileSync } : name === "path" ? { join: (...parts: string[]) => parts.join("/") } : http);
    vi.stubGlobal("window", { location: { origin: "https://127.0.0.1:60080" }, require: requireModule, siyuan: { config: { api: { token: "local-kernel-token" }, system: { confDir: "/workspace/conf" } } } });
    const response = await fetchReviewStream("/api/network/proxy", "{}", new AbortController().signal);
    expect(requireModule).toHaveBeenCalledWith("https");
    expect(readFileSync).toHaveBeenCalledWith("/workspace/conf/ca.crt", "utf8");
    expect(http.request.mock.calls[0][1]).toMatchObject({ ca: "workspace CA", rejectUnauthorized: true });
    await response.body!.cancel();
  });

  it("keeps HTTPS verification enabled when the local CA is unavailable", async () => {
    const requireModule = vi.fn(name => name === "fs" ? { readFileSync: () => { throw new Error("missing CA"); } } : name === "path" ? { join: (...parts: string[]) => parts.join("/") } : http);
    vi.stubGlobal("window", { location: { origin: "https://127.0.0.1:60080" }, require: requireModule, siyuan: { config: { api: { token: "local-kernel-token" }, system: { workspaceDir: "/workspace" } } } });
    const response = await fetchReviewStream("/api/network/proxy", "{}", new AbortController().signal);
    expect(http.request.mock.calls[0][1].rejectUnauthorized).toBe(true);
    expect(http.request.mock.calls[0][1]).not.toHaveProperty("ca");
    await response.body!.cancel();
  });

  it("does not apply the workspace CA to a remote HTTPS kernel", async () => {
    const requireModule = vi.fn(() => http);
    vi.stubGlobal("window", { location: { origin: "https://notes.example.com" }, require: requireModule, siyuan: { config: { api: { token: "remote-kernel-token" }, system: { confDir: "/workspace/conf" } } } });
    const response = await fetchReviewStream("/api/network/proxy", "{}", new AbortController().signal);
    expect(requireModule).not.toHaveBeenCalledWith("fs");
    expect(http.request.mock.calls[0][1]).toMatchObject({ rejectUnauthorized: true });
    expect(http.request.mock.calls[0][1]).not.toHaveProperty("ca");
    await response.body!.cancel();
  });

  it("rejects other origins before exposing the kernel token or request body", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(fetchReviewStream("https://other.example.com/api/network/proxy", "private article", new AbortController().signal)).rejects.toThrow("当前思源内核");
    expect(http.request).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("destroys the native connection on cancellation while waiting for headers", async () => {
    request.end.mockImplementation(() => undefined);
    http.request.mockImplementation(() => request);
    const controller = new AbortController();
    const pending = fetchReviewStream("/api/network/proxy", "{}", controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await assertion; expect(request.destroy).toHaveBeenCalledOnce();
  });

  it("cancels the body reader and closes both native sides", async () => {
    const controller = new AbortController();
    const response = await fetchReviewStream("/api/network/proxy", "{}", controller.signal);
    const reader = response.body!.getReader();
    const assertion = expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await assertion;
    expect(incoming.destroy).toHaveBeenCalledOnce(); expect(request.destroy).toHaveBeenCalledOnce();
  });

  it("uses the browser's own session without sending a kernel token when native HTTP is unavailable", async () => {
    delete host.require;
    const fetchMock = vi.fn(async () => new Response("data: test\n\n")); vi.stubGlobal("fetch", fetchMock);
    await fetchReviewStream("/api/network/proxy", "{}", new AbortController().signal);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ "Content-Type": "application/json" });
    expect(http.request).not.toHaveBeenCalled();
  });

  it("closes malformed native responses without leaving the request pending", async () => {
    incoming.statusCode = 204;
    await expect(fetchReviewStream("/api/network/proxy", "{}", new AbortController().signal)).rejects.toBeInstanceOf(TypeError);
    expect(incoming.destroy).toHaveBeenCalledOnce(); expect(request.destroy).toHaveBeenCalledOnce();
  });

});
